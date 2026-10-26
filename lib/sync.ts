import type { PoolClient } from "pg";
import { getPool } from "./db";
import { configFromEnv, resolveQueryPath, runQuery, type TmrConfig, type TmrQuery, type TmrTable } from "./tmr";
import { buildConverter, type DailySpend, daysBetween, ensureDailyRates, type FxFetcher } from "./fx";
import {
  accountCurrencies,
  type AccountType,
  dailySpendQuery,
  parseDailySpend,
  type FactRow,
  META_CONNECTOR,
  applyCurrencyConversion,
  mainQuery,
  mergeChunk,
  purchasesQuery,
} from "./transform";

export const SYNC_FROM = "2025-01-01";
const PLATFORM = "meta";
const LOCK_KEY = 4_206_031; // pg advisory lock id for the sync job
/** Bump to make the next sync re-pull every half-year (3: spend converted to SGD by us, see lib/fx.ts). */
const DATA_VERSION = "3";

export type Range = { start: string; end: string };

const iso = (d: Date) => d.toISOString().slice(0, 10);
const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d));
const addDays = (day: string, n: number) => iso(new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000));

/** Half-year chunks (Jan-Jun, Jul-Dec) from `from` to `today`, the last one clipped to today. */
export function halfYearChunks(from: string, today: string): (Range & { fullEnd: string })[] {
  const out: (Range & { fullEnd: string })[] = [];
  const [fy, fm] = from.split("-").map(Number);
  let y = fy;
  let h = fm <= 6 ? 0 : 1;
  for (;;) {
    const start = iso(utc(y, h * 6, 1));
    if (start > today) break;
    const fullEnd = iso(utc(y, h * 6 + 6, 0));
    out.push({ start, end: fullEnd < today ? fullEnd : today, fullEnd });
    if (h === 1) { y++; h = 0; } else h = 1;
  }
  return out;
}

/** Split a range into calendar quarters (the main query is not attribution-sensitive). */
export function quarterRanges(r: Range): Range[] {
  const out: Range[] = [];
  let [y, m] = r.start.split("-").map(Number);
  m = Math.floor((m - 1) / 3) * 3;
  for (;;) {
    const start = iso(utc(y, m, 1));
    if (start > r.end) break;
    const qEnd = iso(utc(y, m + 3, 0));
    out.push({ start: start < r.start ? r.start : start, end: qEnd < r.end ? qEnd : r.end });
    m += 3;
    if (m >= 12) { m = 0; y++; }
  }
  return out;
}

/** First day of the month two months before `today`: the restatement window (current + previous 2). */
export function recentWindowStart(today: string): string {
  const [y, m] = today.split("-").map(Number);
  return iso(utc(y, m - 1 - 2, 1));
}

/**
 * Which half-year chunks to pull: any never synced (backfill), plus any that overlap the
 * restatement window. Recent months are always re-pulled as part of their whole half-year,
 * because Meta/TMR attribute purchases differently depending on the query's start date
 * (an April pulled from Apr 1 shows fewer purchases than the same April pulled from Jan 1).
 */
export function planChunks(today: string, syncedChunkStarts: Set<string>, full = false) {
  const recent = recentWindowStart(today);
  return halfYearChunks(SYNC_FROM, today).filter(
    (c) => full || !syncedChunkStarts.has(c.start) || c.fullEnd >= recent,
  );
}

type Account = { accountId: string; type: AccountType; currency: string | null };

export type SyncOptions = {
  full?: boolean;
  today?: string;
  cfg?: TmrConfig;
  log?: (msg: string) => void;
  /** Injected for tests / fixtures. */
  query?: (title: string, q: TmrQuery) => Promise<TmrTable>;
  fx?: FxFetcher;
};

export type SyncResult = { runId: number; status: "success" | "failed" | "skipped"; rows: number; error?: string };

export async function runSync(opts: SyncOptions = {}): Promise<SyncResult> {
  const log = opts.log ?? console.log;
  const pool = getPool();
  const lock = await pool.connect();
  try {
    const { rows: got } = await lock.query("select pg_try_advisory_lock($1) as ok", [LOCK_KEY]);
    if (!got[0].ok) {
      log("sync: another sync is already running, skipping");
      return { runId: 0, status: "skipped", rows: 0 };
    }
    const { rows: run } = await pool.query(
      "insert into sync_runs (started_at, status) values (now(), 'running') returning id",
    );
    const runId: number = run[0].id;
    try {
      const rows = await doSync(opts, log);
      await pool.query("update sync_runs set finished_at = now(), status = 'success', rows = $2 where id = $1", [runId, rows]);
      log(`sync: done, ${rows} rows written`);
      return { runId, status: "success", rows };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await pool.query("update sync_runs set finished_at = now(), status = 'failed', error = $2 where id = $1", [runId, message]);
      log(`sync: FAILED: ${message}`);
      return { runId, status: "failed", rows: 0, error: message };
    }
  } finally {
    await lock.query("select pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => {});
    lock.release();
  }
}

async function doSync(opts: SyncOptions, log: (msg: string) => void): Promise<number> {
  const pool = getPool();
  const today = opts.today ?? iso(new Date());
  const { rows: acctRows } = await pool.query(
    "select account_id, account_type, currency from accounts where platform = $1 and enabled",
    [PLATFORM],
  );
  const accounts: Account[] = acctRows.map((r) => ({ accountId: r.account_id, type: r.account_type, currency: r.currency }));
  if (!accounts.length) throw new Error("No enabled accounts in the accounts table");
  const accountIdsForQuery = accounts.map((a) => `act_${a.accountId}`);
  const types = new Map(accounts.map((a) => [a.accountId, a.type]));
  const knownCurrencies = new Map(accounts.map((a) => [a.accountId, a.currency]));
  const query = opts.query ?? (await liveQuery(opts.cfg ?? configFromEnv(), accountIdsForQuery, log));

  // Data saved by an older sync version is re-pulled once (e.g. spend that came back unconverted).
  const { rows: ver } = await pool.query("select value from app_settings where key = 'data_version'");
  if (ver[0]?.value !== DATA_VERSION) {
    log(`sync: data version ${ver[0]?.value ?? "none"} -> ${DATA_VERSION}, re-pulling every half-year`);
    await pool.query("delete from sync_chunks where platform = $1", [PLATFORM]);
  }

  const { rows: done } = await pool.query(
    "select to_char(chunk_start, 'YYYY-MM-DD') as chunk_start from sync_chunks where platform = $1",
    [PLATFORM],
  );
  const synced = new Set<string>(done.map((r) => r.chunk_start));
  const chunks = planChunks(today, synced, opts.full);
  log(`sync: ${accounts.length} accounts, chunks ${chunks.map((c) => `${c.start}..${c.end}`).join(", ") || "none"}`);

  let written = 0;
  for (const chunk of chunks) {
    const main = await pullMain(query, chunk);
    const purchases = await pullPurchases(query, chunk, log);

    // Spend comes back in each account's own currency: convert at spend-weighted daily rates.
    const daily = await pullDailySpend(query, chunk, log);
    const currencies = new Map([...knownCurrencies, ...accountCurrencies(main)]);
    await saveCurrencies(accountCurrencies(main), knownCurrencies);
    const rates = await ensureDailyRates(
      [...currencies.values()].filter(Boolean) as string[],
      daysBetween(addDays(chunk.start, -7), chunk.end), // a week before covers unpublished days at the start
      today,
      opts.fx,
      log,
    );
    const toSgd = buildConverter(rates, daily);

    const facts = mergeChunk(main, purchases, types, PLATFORM, toSgd, currencies);
    assertSpendInSgd(facts, accounts, chunk);
    written += await replaceChunk(chunk, facts, accounts.map((a) => a.accountId));
    log(`sync: ${chunk.start}..${chunk.end} -> ${facts.length} rows`);
  }

  await recomputeSgdValues(knownCurrencies);
  await pool.query(
    `insert into app_settings (key, value) values ('data_version', $1)
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [DATA_VERSION],
  );
  return written;
}

/**
 * Live TMR query function. Uses the Run query path saved by an earlier sync (unless TMR_QUERY_PATH
 * is set), confirms it with one tiny request, and saves whatever path that check settles on.
 */
async function liveQuery(cfg: TmrConfig, accountIds: string[], log: (msg: string) => void) {
  const pool = getPool();
  if (!process.env.TMR_QUERY_PATH) {
    const { rows } = await pool.query("select value from app_settings where key = 'tmr_query_path'");
    if (rows[0]?.value) cfg = { ...cfg, queryPath: rows[0].value };
  }
  const probe = { connectorId: META_CONNECTOR, accountIds, title: "endpoint check", query: mainQuery(SYNC_FROM, SYNC_FROM) };
  const path = await resolveQueryPath(probe, cfg, log);
  await pool.query(
    `insert into app_settings (key, value) values ('tmr_query_path', $1)
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [path],
  );
  cfg = { ...cfg, queryPath: path };
  return (title: string, q: TmrQuery) => runQuery({ connectorId: META_CONNECTOR, accountIds, title, query: q }, cfg, log);
}

/** Record the billing currency Meta reports for each account (and keep the in-memory map current). */
async function saveCurrencies(found: Map<string, string>, known: Map<string, string | null>): Promise<void> {
  const changed = [...found].filter(([id, cur]) => known.get(id) !== cur);
  if (!changed.length) return;
  await getPool().query(
    `update accounts a set currency = u.cur from unnest($2::text[], $3::text[]) as u(id, cur)
     where a.platform = $1 and a.account_id = u.id`,
    [PLATFORM, changed.map(([id]) => id), changed.map(([, c]) => c)],
  );
  for (const [id, cur] of changed) known.set(id, cur);
}

/**
 * Spend from query 3a must be in SGD. For accounts billed in another currency, SGD spend equal to
 * local spend means Two Minutes ignored the currency request; fail rather than save wrong numbers.
 */
export function assertSpendInSgd(facts: FactRow[], accounts: { accountId: string; currency: string | null }[], chunk: Range) {
  const foreign = new Map(accounts.filter((a) => a.currency && a.currency !== "SGD").map((a) => [a.accountId, a.currency!]));
  const sums = new Map<string, { sgd: number; native: number }>();
  for (const f of facts) {
    if (!foreign.has(f.accountId) || !f.spendNative) continue;
    const t = sums.get(f.accountId) ?? { sgd: 0, native: 0 };
    t.sgd += f.spendSgd;
    t.native += f.spendNative;
    sums.set(f.accountId, t);
  }
  const unconverted = [...sums].filter(([, t]) => t.sgd > 0 && Math.abs(t.sgd / t.native - 1) < 0.001);
  if (unconverted.length) {
    const [id, t] = unconverted[0];
    throw new Error(
      `Two Minutes returned spend in local currency, not SGD, for ${chunk.start}..${chunk.end} ` +
        `(account ${id} is billed in ${foreign.get(id)}: "SGD" spend ${t.sgd.toFixed(2)} = local spend ${t.native.toFixed(2)}). ` +
        "Nothing was saved for this period.",
    );
  }
}

async function pullMain(
  query: NonNullable<SyncOptions["query"]>,
  chunk: Range,
): Promise<TmrTable> {
  // Spend and delivery do not depend on the query range, so quarters keep each call well under the timeout.
  const parts: TmrTable[] = [];
  for (const q of quarterRanges(chunk)) parts.push(await query("Meta benchmark base", mainQuery(q.start, q.end)));
  return concat(parts);
}

/**
 * Daily local spend per account, used to weight exchange rates. Optional: if it fails the
 * conversion falls back to monthly average rates, so the sync carries on.
 */
async function pullDailySpend(
  query: NonNullable<SyncOptions["query"]>,
  chunk: Range,
  log: (msg: string) => void,
): Promise<DailySpend[]> {
  try {
    const parts: TmrTable[] = [];
    for (const q of quarterRanges(chunk)) parts.push(await query("Meta daily spend", dailySpendQuery(q.start, q.end)));
    return parts.flatMap(parseDailySpend);
  } catch (err) {
    log(`sync: WARNING daily spend pull failed (${(err as Error).message}); using monthly average exchange rates`);
    return [];
  }
}

async function pullPurchases(
  query: NonNullable<SyncOptions["query"]>,
  chunk: Range,
  log: (msg: string) => void,
): Promise<TmrTable> {
  try {
    return await query("Meta purchases", purchasesQuery(chunk.start, chunk.end));
  } catch (err) {
    // Last resort: quarters. Purchase counts can differ slightly from a half-year pull (see planChunks).
    log(`sync: WARNING half-year purchases pull failed (${(err as Error).message}); falling back to quarters`);
    const parts: TmrTable[] = [];
    for (const q of quarterRanges(chunk)) parts.push(await query("Meta purchases", purchasesQuery(q.start, q.end)));
    return concat(parts);
  }
}

function concat(parts: TmrTable[]): TmrTable {
  return { fields: parts[0]?.fields ?? [], rows: parts.flatMap((p) => p.rows) };
}

/** Replace the chunk's months for the synced accounts in one transaction. */
async function replaceChunk(chunk: Range, facts: FactRow[], accountIds: string[]): Promise<number> {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    const { rows: existing } = await client.query(
      "select count(*)::int as n from fact_monthly where platform = $1 and month between $2 and $3 and account_id = any($4)",
      [PLATFORM, chunk.start, chunk.end, accountIds],
    );
    if (facts.length === 0 && existing[0].n > 0) {
      throw new Error(`TMR returned no rows for ${chunk.start}..${chunk.end} but ${existing[0].n} exist; keeping previous data`);
    }
    await client.query(
      "delete from fact_monthly where platform = $1 and month between $2 and $3 and account_id = any($4)",
      [PLATFORM, chunk.start, chunk.end, accountIds],
    );
    await insertFacts(client, facts);
    await client.query(
      `insert into sync_chunks (platform, chunk_start, chunk_end, synced_at) values ($1, $2, $3, now())
       on conflict (platform, chunk_start) do update set chunk_end = excluded.chunk_end, synced_at = now()`,
      [PLATFORM, chunk.start, chunk.end],
    );
    await client.query("commit");
    return facts.length;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function insertFacts(client: PoolClient, facts: FactRow[]): Promise<void> {
  if (!facts.length) return;
  const col = <K extends keyof FactRow>(k: K) => facts.map((f) => f[k]);
  await client.query(
    `insert into fact_monthly (platform, account_id, objective, goal, month, spend_sgd, impressions, clicks, link_clicks,
       spend_native, purchases, purchase_value_native, purchase_value_sgd, synced_at)
     select *, now() from unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::date[], $6::numeric[], $7::bigint[],
       $8::bigint[], $9::bigint[], $10::numeric[], $11::numeric[], $12::numeric[], $13::numeric[])
     on conflict (platform, account_id, objective, goal, month) do update set
       spend_sgd = excluded.spend_sgd, impressions = excluded.impressions, clicks = excluded.clicks,
       link_clicks = excluded.link_clicks, spend_native = excluded.spend_native, purchases = excluded.purchases,
       purchase_value_native = excluded.purchase_value_native, purchase_value_sgd = excluded.purchase_value_sgd,
       synced_at = now()`,
    [
      col("platform"), col("accountId"), col("objective"), col("goal"), col("month"), col("spendSgd"),
      col("impressions"), col("clicks"), col("linkClicks"), col("spendNative"), col("purchases"),
      col("purchaseValueNative"), col("purchaseValueSgd"),
    ],
  );
}

/** Currency conversion needs every month of an account (all-time fallback), so it runs over the whole table. */
export async function recomputeSgdValues(currencies: Map<string, string | null>): Promise<void> {
  const pool = getPool();
  const { rows } = await pool.query(
    `select account_id, objective, goal, to_char(month, 'YYYY-MM-DD') as month, spend_sgd, spend_native, purchase_value_native
     from fact_monthly where platform = $1 and (objective = 'OUTCOME_SALES' or purchase_value_native is not null)`,
    [PLATFORM],
  );
  const facts: FactRow[] = rows.map((r) => ({
    platform: PLATFORM, accountId: r.account_id, objective: r.objective, goal: r.goal, month: r.month,
    spendSgd: Number(r.spend_sgd), impressions: 0, clicks: 0, linkClicks: 0,
    spendNative: r.spend_native === null ? null : Number(r.spend_native), purchases: null,
    purchaseValueNative: r.purchase_value_native === null ? null : Number(r.purchase_value_native),
    purchaseValueSgd: null,
  }));
  applyCurrencyConversion(facts, currencies);
  if (!facts.length) return;
  await pool.query(
    `update fact_monthly f set purchase_value_sgd = u.v
     from unnest($2::text[], $3::text[], $4::text[], $5::date[], $6::numeric[]) as u(a, o, g, m, v)
     where f.platform = $1 and f.account_id = u.a and f.objective = u.o and f.goal = u.g and f.month = u.m`,
    [PLATFORM, facts.map((f) => f.accountId), facts.map((f) => f.objective), facts.map((f) => f.goal),
      facts.map((f) => f.month), facts.map((f) => f.purchaseValueSgd)],
  );
}
