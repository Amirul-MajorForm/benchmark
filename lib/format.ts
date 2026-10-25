const n = (v: number, dp: number) => v.toLocaleString("en-SG", { minimumFractionDigits: dp, maximumFractionDigits: dp });

export const BLANK = "–";

export const fmt = {
  money: (v: number | null, dp = 2) => (v === null ? BLANK : `S$${n(v, dp)}`),
  money0: (v: number | null) => (v === null ? BLANK : `S$${n(Math.round(v), 0)}`),
  int: (v: number | null) => (v === null ? BLANK : n(Math.round(v), 0)),
  pct: (v: number | null, dp = 2) => (v === null ? BLANK : `${n(v * 100, dp)}%`),
  roas: (v: number | null) => (v === null ? BLANK : `${n(v, 2)}x`),
  compact: (v: number) =>
    v >= 1e6 ? `${n(v / 1e6, 1)}M` : v >= 1e3 ? `${n(v / 1e3, 1)}K` : n(v, 0),
};

export type ColumnKey = "spend" | "impressions" | "cpm" | "cpc" | "ctr" | "cpa" | "roas";

export function formatMetric(key: ColumnKey, v: number | null): string {
  switch (key) {
    case "spend": return fmt.money0(v);
    case "impressions": return fmt.int(v);
    case "cpm": case "cpc": case "cpa": return fmt.money(v);
    case "ctr": return fmt.pct(v);
    case "roas": return fmt.roas(v);
  }
}
