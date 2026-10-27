import type { TmrQuery, TmrTable } from "./tmr";

export const META_CONNECTOR = "fads";
export const SALES_OBJECTIVE = "OUTCOME_SALES";

const DIMENSIONS = ["account_id", "campaign_objective", "optimization_goal", "year_month"];

/**
 * Query 3a: spend and delivery. The REST API returns spend in the account's own currency, so the
 * account currency comes back as a dimension and mergeChunk converts spend to SGD.
 */
export function mainQuery(startDate: string, endDate: string): TmrQuery {
  return {
    dateRange: { startDate, endDate },
    dimensions: [...DIMENSIONS, "account_currency"],
    metrics: ["spend", "impressions", "clicks", "link_clicks", "lead", "all_app_install"],
    reportParams: { includeAllItems: true },
  };
}

/**
 * Query 3b: purchases in account currency. Only Sales rows are used; that is
 * applied in mergeChunk rather than as an API filter, which keeps the request format simple and
 * gives the same rows (objective is a dimension, so filtering it out afterwards changes nothing).
 */
export function purchasesQuery(startDate: string, endDate: string): TmrQuery {
  return {
    dateRange: { startDate, endDate },
    dimensions: DIMENSIONS,
    metrics: ["spend", "all_purchases", "purchase_conversions_all", "collab_action_omni_purchase", "collab_ads_value_omni_purchase"],
    reportParams: { includeAllItems: true },
  };
}

export type AccountType = "Brand" | "CPAS";

export type FactRow = {
  platform: string;
  accountId: string;
  objective: string;
  goal: string;
  month: string; // YYYY-MM-01
  spendSgd: number;
  impressions: number;
  clicks: number;
  linkClicks: number;
  /** Meta "Leads (all)": instant forms, Messenger and website leads. */
  leads: number | null;
  /** Meta "App Installs (all)". */
  installs: number | null;
  spendNative: number | null;
  purchases: number | null;
  purchaseValueNative: number | null;
  purchaseValueSgd: number | null;
};

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

/** "2025-Feb" -> "2025-02-01". Also accepts "2025-02" and "202502". */
export function monthStart(yearMonth: string): string {
  const s = String(yearMonth).trim();
  let m = /^(\d{4})-([A-Za-z]{3})/.exec(s);
  if (m && MONTHS[m[2].toLowerCase()]) return `${m[1]}-${MONTHS[m[2].toLowerCase()]}-01`;
  m = /^([A-Za-z]{3})[a-z]*\.?\s+(\d{4})$/.exec(s); // "Feb 2025", "February 2025"
  if (m && MONTHS[m[1].toLowerCase()]) return `${m[2]}-${MONTHS[m[1].toLowerCase()]}-01`;
  m = /^(\d{4})-?(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-01`;
  throw new Error(`Unrecognised year_month value: ${yearMonth}`);
}

/** "act_123", "fads_act_123" and "123" all become "123". */
export function stripAct(id: unknown): string {
  return String(id).trim().replace(/^[a-z]+_(?=act_|\d)/, "").replace(/^act_/, "");
}

/** "" / null / undefined -> null; numeric strings -> numbers. */
export function num(v: unknown): number | null {
  if (v === "" || v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function records(table: TmrTable): Record<string, unknown>[] {
  return table.rows.map((row) => Object.fromEntries(table.fields.map((f, i) => [f, row[i]])));
}

function key(accountId: string, objective: string, goal: string, month: string) {
  return `${accountId}|${objective}|${goal}|${month}`;
}

function blankFact(platform: string, accountId: string, objective: string, goal: string, month: string): FactRow {
  return {
    platform, accountId, objective, goal, month,
    spendSgd: 0, impressions: 0, clicks: 0, linkClicks: 0, leads: null, installs: null,
    spendNative: null, purchases: null, purchaseValueNative: null, purchaseValueSgd: null,
  };
}

const cents = (n: number) => Math.round(n * 100) / 100;

const add = (a: number | null, b: number | null) => (a === null && b === null ? null : (a ?? 0) + (b ?? 0));

/**
 * Merge query 3a and 3b on (account, objective, goal, month).
 * Purchases come from collab_* fields for CPAS accounts and all_purchases / purchase_conversions_all
 * for Brand accounts. Rows with purchases but zero spend (late attribution) are kept.
 * purchase_value_sgd is filled in afterwards by applyCurrencyConversion, which needs all months.
 */
/** SGD per 1 unit of the account's `currency` for one account-month (YYYY-MM-01). */
export type ToSgd = (accountId: string, currency: string, month: string) => number;

/** Daily local-currency spend per account, used to weight exchange rates (see lib/fx.ts). */
export function dailySpendQuery(startDate: string, endDate: string): TmrQuery {
  return {
    dateRange: { startDate, endDate },
    dimensions: ["account_id", "date", "account_currency"],
    metrics: ["spend"],
    reportParams: { includeAllItems: true },
  };
}

/** "2025-06-02", "2025-06-02T00:00:00Z" or "20250602" -> "2025-06-02". */
export function dayOf(v: unknown): string {
  const s = String(v).trim();
  const m = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new Error(`Unrecognised date value: ${s}`);
  return d.toISOString().slice(0, 10);
}

export function parseDailySpend(table: TmrTable): { accountId: string; currency: string; day: string; spend: number }[] {
  return records(table)
    .filter((r) => r.account_currency && (num(r.spend) ?? 0) > 0)
    .map((r) => ({
      accountId: stripAct(r.account_id),
      currency: String(r.account_currency).toUpperCase(),
      day: dayOf(r.date),
      spend: num(r.spend)!,
    }));
}

/** Account currency for each account in a main-query result ("MYR"), as reported by Meta. */
export function accountCurrencies(main: TmrTable): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of records(main)) {
    if (r.account_currency) out.set(stripAct(r.account_id), String(r.account_currency).toUpperCase());
  }
  return out;
}

export function mergeChunk(
  main: TmrTable,
  purchases: TmrTable,
  accountTypes: Map<string, AccountType>,
  platform = "meta",
  toSgd: ToSgd = () => 1,
  knownCurrencies: Map<string, string | null> = new Map(),
): FactRow[] {
  const out = new Map<string, FactRow>();
  const get = (r: Record<string, unknown>) => {
    const accountId = stripAct(r.account_id);
    const objective = String(r.campaign_objective || "Unknown");
    const goal = String(r.optimization_goal || "Unknown Optimization Goal");
    const month = monthStart(String(r.year_month));
    const k = key(accountId, objective, goal, month);
    let row = out.get(k);
    if (!row) out.set(k, (row = blankFact(platform, accountId, objective, goal, month)));
    return row;
  };

  for (const r of records(main)) {
    const row = get(r);
    const currency = r.account_currency ? String(r.account_currency) : knownCurrencies.get(row.accountId);
    if (!currency) throw new Error(`No currency for account ${row.accountId}; cannot convert its spend to SGD`);
    row.spendSgd += (num(r.spend) ?? 0) * toSgd(row.accountId, currency, row.month);
    row.impressions += num(r.impressions) ?? 0;
    row.clicks += num(r.clicks) ?? 0;
    row.linkClicks += num(r.link_clicks) ?? 0;
    row.leads = add(row.leads, num(r.lead));
    row.installs = add(row.installs, num(r.all_app_install));
  }

  for (const r of records(purchases)) {
    if (String(r.campaign_objective) !== SALES_OBJECTIVE) continue; // purchases are Sales-only
    const accountId = stripAct(r.account_id);
    const type = accountTypes.get(accountId);
    if (!type) continue; // not in the mapping: nothing to attribute it to
    const row = get(r);
    const cpas = type === "CPAS";
    row.spendNative = add(row.spendNative, num(r.spend) ?? 0);
    row.purchases = add(row.purchases, num(cpas ? r.collab_action_omni_purchase : r.all_purchases));
    row.purchaseValueNative = add(
      row.purchaseValueNative,
      num(cpas ? r.collab_ads_value_omni_purchase : r.purchase_conversions_all),
    );
  }
  // Converted SGD spend carries fractional cents; store each row to the cent (matches the prototype's totals).
  for (const row of out.values()) row.spendSgd = cents(row.spendSgd);
  return [...out.values()];
}

/**
 * purchase_value_sgd = purchase_value_native x rate, where rate is the account's
 * Sigma spend_sgd / Sigma spend_native over its Sales rows that month, falling back to the account's
 * all-time rate (months where both sides are > 0). SGD-billed accounts come out at 1.
 * Mutates and returns the rows. Needs every Sales row for the account, not just one chunk.
 */
export function applyCurrencyConversion(rows: FactRow[], currencies: Map<string, string | null> = new Map()): FactRow[] {
  type Acc = { sgd: number; native: number };
  const monthly = new Map<string, Acc>();
  for (const r of rows) {
    if (r.objective !== SALES_OBJECTIVE) continue;
    const k = `${r.accountId}|${r.month}`;
    const a = monthly.get(k) ?? { sgd: 0, native: 0 };
    a.sgd += r.spendSgd;
    a.native += r.spendNative ?? 0;
    monthly.set(k, a);
  }
  const allTime = new Map<string, Acc>();
  for (const [k, a] of monthly) {
    if (a.sgd > 0 && a.native > 0) {
      const acct = k.split("|")[0];
      const t = allTime.get(acct) ?? { sgd: 0, native: 0 };
      t.sgd += a.sgd;
      t.native += a.native;
      allTime.set(acct, t);
    }
  }
  const rate = (accountId: string, month: string): number | null => {
    const m = monthly.get(`${accountId}|${month}`);
    if (m && m.sgd > 0 && m.native > 0) return m.sgd / m.native;
    const t = allTime.get(accountId);
    if (t) return t.sgd / t.native;
    return currencies.get(accountId) === "SGD" ? 1 : null;
  };
  for (const r of rows) {
    if (r.purchaseValueNative === null) {
      r.purchaseValueSgd = null;
      continue;
    }
    const fx = rate(r.accountId, r.month);
    r.purchaseValueSgd = fx === null ? null : r.purchaseValueNative * fx;
  }
  return rows;
}
