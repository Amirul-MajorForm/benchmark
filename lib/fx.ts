/**
 * Exchange rates for converting spend to SGD.
 *
 * The Two Minutes REST API returns spend in each ad account's own currency and ignores currency
 * requests, so the sync converts it here. Each account-month is converted at its spend-weighted
 * rate: Σ(daily local spend × that day's rate) ÷ Σ daily local spend, which matches converting every
 * day at its own rate. When daily spend isn't available the month's average rate is used instead.
 *
 * Daily rates come from the free currency-api (github.com/fawazahmed0/exchange-api), which covers
 * every currency we bill in (including VND and TWD), and are cached in fx_daily.
 */
import { getPool } from "./db";
import type { ToSgd } from "./transform";

/** Units of each currency per 1 SGD for one day, keyed by lowercase ISO code ({ myr: 3.3, ... }). */
export type DailyRates = Record<string, number>;
export type FxFetcher = (date: string) => Promise<DailyRates | null>;

/** Fetch one day's SGD rates. Null when the day has not been published (e.g. today). */
export const fetchSgdRates: FxFetcher = async (date) => {
  const [y, m, d] = date.split("-").map(Number);
  const urls = [
    `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${y}.${m}.${d}/v1/currencies/sgd.min.json`,
    `https://${date}.currency-api.pages.dev/v1/currencies/sgd.min.json`,
  ];
  let lastError = "";
  for (const url of urls) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (res.status === 404) {
        lastError = "404";
        continue;
      }
      if (!res.ok) {
        lastError = `HTTP ${res.status}`;
        continue;
      }
      const json = (await res.json()) as { sgd?: DailyRates };
      if (json?.sgd) return json.sgd;
      lastError = "no sgd rates in response";
    } catch (err) {
      lastError = (err as Error).message;
    }
  }
  if (lastError === "404") return null;
  throw new Error(`Could not fetch exchange rates for ${date}: ${lastError}`);
};

const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (day: string, n: number) => iso(new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000));

/** Every day from start to end inclusive (YYYY-MM-DD). */
export function daysBetween(start: string, end: string): string[] {
  const out: string[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}

/** "MYR|2025-04-15" -> SGD per 1 MYR on that day. */
export type DailyRateMap = Map<string, number>;

/** SGD per unit on `day`, or the closest earlier day within a week (rates aren't published every day). */
export function rateOn(rates: DailyRateMap, currency: string, day: string): number | null {
  const cur = currency.toUpperCase();
  if (cur === "SGD") return 1;
  for (let i = 0; i <= 7; i++) {
    const r = rates.get(`${cur}|${addDays(day, -i)}`);
    if (r !== undefined) return r;
  }
  return null;
}

/** Average SGD per unit over the days of `month` (YYYY-MM-01) that have a rate. */
export function monthAverage(rates: DailyRateMap, currency: string, month: string): number | null {
  const cur = currency.toUpperCase();
  if (cur === "SGD") return 1;
  let sum = 0;
  let n = 0;
  for (const [k, v] of rates) {
    if (k.startsWith(`${cur}|${month.slice(0, 7)}`)) {
      sum += v;
      n += 1;
    }
  }
  return n ? sum / n : null;
}

export type DailySpend = { accountId: string; currency: string; day: string; spend: number };


/**
 * Converter for one chunk: spend-weighted daily rate per account-month where daily spend is known,
 * else the month's average rate, else the latest earlier rate (e.g. on the 1st of a month).
 */
export function buildConverter(rates: DailyRateMap, daily: DailySpend[]): ToSgd {
  const weighted = new Map<string, { local: number; sgd: number }>();
  for (const d of daily) {
    if (!(d.spend > 0)) continue;
    const r = rateOn(rates, d.currency, d.day);
    if (r === null) continue;
    const k = `${d.accountId}|${d.currency.toUpperCase()}|${d.day.slice(0, 7)}`;
    const w = weighted.get(k) ?? { local: 0, sgd: 0 };
    w.local += d.spend;
    w.sgd += d.spend * r;
    weighted.set(k, w);
  }
  return (accountId, currency, month) => {
    if (currency.toUpperCase() === "SGD") return 1;
    const w = weighted.get(`${accountId}|${currency.toUpperCase()}|${month.slice(0, 7)}`);
    if (w && w.local > 0) return w.sgd / w.local;
    const avg = monthAverage(rates, currency, month);
    if (avg !== null) return avg;
    // No rates in the month yet (e.g. the 1st): latest earlier rate on record.
    const cur = currency.toUpperCase();
    const earlier = [...rates.keys()].filter((k) => k.startsWith(`${cur}|`) && k.slice(cur.length + 1) < month).sort().pop();
    if (earlier) return rates.get(earlier)!;
    throw new Error(`No ${currency.toUpperCase()}->SGD exchange rate for ${month.slice(0, 7)}`);
  };
}

/**
 * Make sure fx_daily has `currencies` for every day in `days` up to yesterday (fetching only missing
 * days), and return the rates for those days.
 */
export async function ensureDailyRates(
  currencies: string[],
  days: string[],
  today: string,
  fetcher: FxFetcher = fetchSgdRates,
  log: (msg: string) => void = console.log,
): Promise<DailyRateMap> {
  const wanted = [...new Set(currencies.map((c) => c.toUpperCase()))].filter((c) => c !== "SGD");
  const yesterday = addDays(today, -1);
  const needed = [...new Set(days)].filter((d) => d <= yesterday);
  if (!wanted.length || !needed.length) return new Map();
  const pool = getPool();

  const { rows: have } = await pool.query(
    `select to_char(date, 'YYYY-MM-DD') as date, count(*)::int as n from fx_daily
     where date = any($1::date[]) and currency = any($2) group by date`,
    [needed, wanted],
  );
  const complete = new Set(have.filter((r) => r.n >= wanted.length).map((r) => r.date));
  const missing = needed.filter((d) => !complete.has(d));
  if (missing.length) log(`  fx: fetching ${missing.length} days of rates for ${wanted.join(", ")}`);

  // A few at a time; the CDN is fast but there is no reason to hammer it.
  for (let i = 0; i < missing.length; i += 8) {
    const batch = missing.slice(i, i + 8);
    const results = await Promise.all(batch.map(async (date) => ({ date, rates: await fetcher(date) })));
    const rows = results.flatMap(({ date, rates }) =>
      rates
        ? wanted
            .filter((c) => rates[c.toLowerCase()] > 0)
            .map((c) => ({ date, currency: c, sgdPerUnit: 1 / rates[c.toLowerCase()] }))
        : [],
    );
    if (rows.length) {
      await pool.query(
        `insert into fx_daily (date, currency, sgd_per_unit)
         select * from unnest($1::date[], $2::text[], $3::numeric[])
         on conflict (date, currency) do update set sgd_per_unit = excluded.sgd_per_unit, fetched_at = now()`,
        [rows.map((r) => r.date), rows.map((r) => r.currency), rows.map((r) => r.sgdPerUnit)],
      );
    }
  }

  const { rows } = await pool.query(
    `select to_char(date, 'YYYY-MM-DD') as date, currency, sgd_per_unit::float8 as rate from fx_daily
     where date = any($1::date[]) and currency = any($2)`,
    [needed, wanted],
  );
  return new Map(rows.map((r) => [`${r.currency}|${r.date}`, r.rate]));
}
