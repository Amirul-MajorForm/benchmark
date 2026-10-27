/**
 * The data tool behind "Ask": aggregates synced facts for any filter set, optionally grouped by time
 * or a dimension, using the same matching and metric code as the dashboard (ratios from sums).
 */
import { type Filters, matches } from "./benchmarks";
import { FILTER_KEYS, parsePeriod } from "./filters";
import { goalLabel, marketLabel, objectiveLabel } from "./labels";
import { type Fact, metrics, totals, trackedAccounts } from "./metrics";

export const GROUP_BYS = ["none", "month", "quarter", "year", "market", "client", "objective", "objective_goal", "account", "account_type"] as const;
export type GroupBy = (typeof GROUP_BYS)[number];
export type QueryInput = Partial<Filters> & { group_by?: GroupBy };

const quarterOf = (month: string) => `${month.slice(0, 4)}-Q${Math.ceil(Number(month.slice(5, 7)) / 3)}`;

const KEY: Record<Exclude<GroupBy, "none">, (f: Fact) => [string, string]> = {
  month: (f) => [f.month, parsePeriod(f.month)!.label],
  quarter: (f) => [quarterOf(f.month), parsePeriod(quarterOf(f.month))!.label],
  year: (f) => [f.month.slice(0, 4), f.month.slice(0, 4)],
  market: (f) => [f.market, marketLabel(f.market)],
  client: (f) => [f.client, f.client],
  objective: (f) => [f.objective, objectiveLabel(f.objective)],
  objective_goal: (f) => [`${f.objective}|${f.goal}`, `${objectiveLabel(f.objective)} · ${goalLabel(f.goal)}`],
  account: (f) => [f.accountId, f.accountName],
  account_type: (f) => [f.accountType, f.accountType],
};

const r = (v: number | null, dp: number) => (v === null ? null : Number(v.toFixed(dp)));

/** Validate tool input from the model. Returns an error string for anything unusable. */
export function parseQueryInput(raw: unknown): QueryInput | string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "Input must be an object.";
  const out: QueryInput = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v === null || v === undefined || v === "") continue;
    if (k === "group_by") {
      if (!GROUP_BYS.includes(v as GroupBy)) return `group_by must be one of ${GROUP_BYS.join(", ")}.`;
      out.group_by = v as GroupBy;
    } else if ((FILTER_KEYS as readonly string[]).includes(k)) {
      if (typeof v !== "string") return `${k} must be a string.`;
      const value = v.trim().toLowerCase() === "all" ? "" : v.trim();
      if (k === "period" && value && !parsePeriod(value)) {
        return `period "${v}" is not valid: use "2025", "2025-Q2", "2025-04" or "all".`;
      }
      out[k as keyof Filters] = value;
    } else {
      return `Unknown field "${k}".`;
    }
  }
  return out;
}

export function runBenchmarkQuery(facts: Fact[], input: QueryInput) {
  const filters: Filters = { period: "", platform: "", objective: "", goal: "", client: "", market: "", type: "", account: "" };
  for (const k of FILTER_KEYS) if (input[k]) filters[k] = input[k]!;
  const tracked = trackedAccounts(facts);
  const period = parsePeriod(filters.period) ?? parsePeriod("")!;
  const rows = facts.filter((f) => matches(f, filters, period));
  const groupBy = input.group_by ?? "none";

  const groups = new Map<string, { label: string; rows: Fact[] }>();
  for (const f of rows) {
    const [key, label] = groupBy === "none" ? ["total", "Total"] : KEY[groupBy](f);
    const g = groups.get(key) ?? { label, rows: [] };
    g.rows.push(f);
    groups.set(key, g);
  }
  const timeOrdered = groupBy === "month" || groupBy === "quarter" || groupBy === "year";
  const out = [...groups]
    .map(([key, g]) => {
      const t = totals(g.rows, tracked);
      const m = metrics(t);
      return {
        key,
        label: g.label,
        spend_sgd: r(t.spend, 2),
        impressions: t.impressions,
        link_clicks: t.linkClicks,
        cpm_sgd: r(m.cpm, 3),
        cpc_sgd: r(m.cpc, 3),
        ctr_pct: m.ctr === null ? null : r(m.ctr * 100, 3),
        purchases: Math.round(t.purchases),
        cpa_sgd: r(m.cpa, 2),
        roas: r(m.roas, 2),
        leads: Math.round(t.leads),
        cpl_sgd: r(m.cpl, 2),
        installs: Math.round(t.installs),
        cpi_sgd: r(m.cpi, 2),
      };
    })
    .filter((g) => (g.spend_sgd ?? 0) > 0 || g.purchases > 0 || g.leads > 0 || g.installs > 0)
    .sort((a, b) => (timeOrdered ? a.key.localeCompare(b.key) : (b.spend_sgd ?? 0) - (a.spend_sgd ?? 0)));

  const latestMonth = facts.reduce((m, f) => (f.month > m ? f.month : m), "");
  return {
    filters_applied: Object.fromEntries(Object.entries(filters).filter(([, v]) => v)),
    period: period.label,
    group_by: groupBy,
    latest_month_with_data: latestMonth,
    rows: out,
    ...(out.length ? {} : { note: "No spend matches these filters." }),
  };
}
