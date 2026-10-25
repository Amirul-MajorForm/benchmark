/** Filters and periods. Pure: safe to import from client components. */

export const FILTER_KEYS = ["period", "platform", "objective", "goal", "client", "market", "type", "account"] as const;
export type FilterKey = (typeof FILTER_KEYS)[number];
/** "" means All. */
export type Filters = Record<FilterKey, string>;

const ALL: Filters = { period: "", platform: "", objective: "", goal: "", client: "", market: "", type: "", account: "" };

/** The original question: Q2 2025, Awareness, Reach. */
export const DEFAULT_FILTERS: Filters = { ...ALL, period: "2025-Q2", objective: "OUTCOME_AWARENESS", goal: "REACH" };

/** Defaults apply only to a bare URL; once any filter is in the query string, missing means All. */
export function parseFilters(params: Record<string, string | string[] | undefined>): Filters {
  const get = (k: string) => {
    const v = params[k];
    return (Array.isArray(v) ? v[0] : v)?.trim() ?? "";
  };
  if (!FILTER_KEYS.some((k) => params[k] !== undefined)) return { ...DEFAULT_FILTERS };
  const f = { ...ALL };
  for (const k of FILTER_KEYS) {
    const v = get(k);
    f[k] = v.toLowerCase() === "all" ? "" : v;
  }
  if (f.period && !parsePeriod(f.period)) f.period = "";
  return f;
}

/** Query string for a set of filters. Period is always written ("all" for All) so the URL is never bare. */
export function filtersToQuery(f: Filters): string {
  const q = new URLSearchParams();
  q.set("period", f.period || "all");
  for (const k of FILTER_KEYS) if (k !== "period" && f[k]) q.set(k, f[k]);
  return q.toString();
}

export type Period = { key: string; kind: "all" | "year" | "quarter" | "month"; start: string; end: string; label: string };

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const ym = (y: number, m: number) => `${y}-${String(m).padStart(2, "0")}`;

/** "2025-12" -> "2026-01" */
export function nextMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return m === 12 ? ym(y + 1, 1) : ym(y, m + 1);
}

/** "2025" | "2025-Q2" | "2025-04" | "" (all time). Months are YYYY-MM. */
export function parsePeriod(key: string): Period | null {
  if (!key) return { key: "", kind: "all", start: "0000-00", end: "9999-99", label: "All time" };
  let m = /^(\d{4})$/.exec(key);
  if (m) return { key, kind: "year", start: `${m[1]}-01`, end: `${m[1]}-12`, label: m[1] };
  m = /^(\d{4})-Q([1-4])$/i.exec(key);
  if (m) {
    const y = Number(m[1]);
    const q = Number(m[2]);
    return { key: `${y}-Q${q}`, kind: "quarter", start: ym(y, q * 3 - 2), end: ym(y, q * 3), label: `Q${q} ${y}` };
  }
  m = /^(\d{4})-(\d{2})$/.exec(key);
  if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12) {
    return { key, kind: "month", start: key, end: key, label: `${MONTH_NAMES[Number(m[2]) - 1]} ${m[1]}` };
  }
  return null;
}

/** Month vs previous month, quarter vs previous quarter, year vs previous year. */
export function previousPeriod(p: Period): Period | null {
  const [y, mo] = p.start.split("-").map(Number);
  if (p.kind === "year") return parsePeriod(String(y - 1));
  if (p.kind === "quarter") {
    const q = Math.ceil(mo / 3);
    return parsePeriod(q === 1 ? `${y - 1}-Q4` : `${y}-Q${q - 1}`);
  }
  if (p.kind === "month") return parsePeriod(mo === 1 ? ym(y - 1, 12) : ym(y, mo - 1));
  return null;
}
