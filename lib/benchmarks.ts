import { getPool } from "./db";
import { type FilterKey, type Filters, type Period, nextMonth, parsePeriod, previousPeriod } from "./filters";
import { goalLabel, marketLabel, objectiveLabel, platformLabel } from "./labels";
import { APP_PROMOTION, BETTER, type Fact, LEADS, type MetricKey, type Metrics, SALES, type Totals, metrics, totals, trackedAccounts } from "./metrics";

export * from "./filters";

export function matches(f: Fact, filters: Filters, period: Period | null): boolean {
  return (
    (!period || (f.month >= period.start && f.month <= period.end)) &&
    (!filters.platform || f.platform === filters.platform) &&
    (!filters.objective || f.objective === filters.objective) &&
    (!filters.goal || f.goal === filters.goal) &&
    (!filters.client || f.client === filters.client) &&
    (!filters.market || f.market === filters.market) &&
    (!filters.type || f.accountType === filters.type) &&
    (!filters.account || f.accountId === filters.account)
  );
}

// ---------------------------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------------------------

export type SyncStatus = {
  lastSuccessAt: string | null;
  latest: { id: number; status: string; startedAt: string | null; finishedAt: string | null; error: string | null } | null;
};

let cache: { key: string; at: number; facts: Fact[] } | null = null;

export async function loadSyncStatus(): Promise<SyncStatus> {
  const pool = getPool();
  const { rows } = await pool.query(
    `select (select max(finished_at) from sync_runs where status = 'success') as last_success,
            r.id, r.status, r.started_at, r.finished_at, r.error
     from (select 1) one left join lateral (select * from sync_runs order by id desc limit 1) r on true`,
  );
  const r = rows[0];
  // A run stuck in "running" for over an hour died without logging.
  const stale = r?.status === "running" && Date.now() - new Date(r.started_at).getTime() > 3_600_000;
  return {
    lastSuccessAt: r?.last_success ? new Date(r.last_success).toISOString() : null,
    latest: r?.id
      ? {
          id: r.id,
          status: stale ? "failed" : r.status,
          startedAt: r.started_at ? new Date(r.started_at).toISOString() : null,
          finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : null,
          error: stale ? "Sync did not finish" : r.error,
        }
      : null,
  };
}

/** All facts joined to the account mapping. ~1k rows; cached until the next successful sync. */
export async function loadFacts(syncKey?: string | null): Promise<Fact[]> {
  const key = syncKey ?? "none";
  if (cache && cache.key === key && Date.now() - cache.at < 10 * 60_000) return cache.facts;
  const { rows } = await getPool().query(
    `select f.platform, f.account_id, coalesce(a.name, f.account_id) as name, a.client, a.market, a.account_type,
            f.objective, f.goal, to_char(f.month, 'YYYY-MM') as month,
            f.spend_sgd::float8 as spend, f.impressions::float8 as impressions, f.clicks::float8 as clicks,
            f.link_clicks::float8 as link_clicks, coalesce(f.purchases, 0)::float8 as purchases,
            coalesce(f.purchase_value_sgd, 0)::float8 as value, coalesce(f.leads, 0)::float8 as leads,
            coalesce(f.installs, 0)::float8 as installs
     from fact_monthly f
     join accounts a on a.platform = f.platform and a.account_id = f.account_id`,
  );
  const facts: Fact[] = rows.map((r) => ({
    platform: r.platform,
    accountId: r.account_id,
    accountName: r.name,
    client: r.client,
    market: r.market,
    accountType: r.account_type,
    objective: r.objective,
    goal: r.goal,
    month: r.month,
    spendSgd: r.spend,
    impressions: r.impressions,
    clicks: r.clicks,
    linkClicks: r.link_clicks,
    purchases: r.purchases,
    purchaseValueSgd: r.value,
    leads: r.leads,
    installs: r.installs,
  }));
  cache = { key, at: Date.now(), facts };
  return facts;
}

export function invalidateFactsCache() {
  cache = null;
}

// ---------------------------------------------------------------------------------------------
// View model
// ---------------------------------------------------------------------------------------------

export type Row = { key: string; label: string; filter: Partial<Filters>; totals: Totals; metrics: Metrics };
export type Tile = { key: MetricKey; label: string; value: number | null; previous: number | null; change: number | null; better: "lower" | "higher" | null };
export type Option = { value: string; label: string };

export type View = {
  filters: Filters;
  period: Period;
  previous: Period | null;
  /** False when the comparison period has no spend for these filters. */
  previousHasData: boolean;
  totals: Totals;
  metrics: Metrics;
  tiles: Tile[];
  takeaway: string | null;
  empty: string | null;
  chart: { month: string; label: string; cpm: number | null; spend: number; impressions: number; selected: boolean }[];
  byMarket: Row[];
  byClient: Row[];
  byObjectiveGoal: Row[];
  options: {
    periods: { years: Option[]; quarters: Option[]; months: Option[] };
    platforms: Option[];
    objectives: Option[];
    goals: Option[];
    clients: Option[];
    markets: Option[];
    types: Option[];
  };
};

export function aggregate(facts: Fact[], filters: Filters, tracked = trackedAccounts(facts)) {
  const period = parsePeriod(filters.period)!;
  const t = totals(facts.filter((f) => matches(f, filters, period)), tracked);
  return { totals: t, metrics: metrics(t) };
}

function groupRows(rows: Fact[], tracked: Set<string>, keyOf: (f: Fact) => string, describe: (key: string, f: Fact) => Omit<Row, "totals" | "metrics" | "key">): Row[] {
  const groups = new Map<string, { sample: Fact; rows: Fact[] }>();
  for (const f of rows) {
    const k = keyOf(f);
    const g = groups.get(k);
    if (g) g.rows.push(f);
    else groups.set(k, { sample: f, rows: [f] });
  }
  return [...groups]
    .map(([key, g]) => {
      const t = totals(g.rows, tracked);
      return { key, ...describe(key, g.sample), totals: t, metrics: metrics(t) };
    })
    .filter((r) => r.totals.spend > 0 || r.totals.purchases > 0)
    .sort((a, b) => b.totals.spend - a.totals.spend);
}

const sgd0 = (n: number) => `S$${Math.round(n).toLocaleString("en-SG")}`;
const sgd2 = (n: number) => `S$${n.toLocaleString("en-SG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function describeSelection(filters: Filters, period: Period): string[] {
  const parts = [period.label];
  if (filters.platform) parts.push(platformLabel(filters.platform));
  if (filters.objective) parts.push(objectiveLabel(filters.objective));
  if (filters.goal) parts.push(`${goalLabel(filters.goal)} goal`);
  if (filters.client) parts.push(filters.client);
  if (filters.market) parts.push(marketLabel(filters.market));
  if (filters.type) parts.push(filters.type);
  return parts;
}

/** Loosen the most specific filter first and say what did run. */
function emptyMessage(facts: Fact[], filters: Filters, period: Period): string {
  if (!facts.some((f) => f.month >= period.start && f.month <= period.end)) {
    return `No data synced for ${period.label}.`;
  }
  const order: { key: FilterKey; label: (f: Fact) => string; value: (f: Fact) => string }[] = [
    { key: "goal", label: (f) => goalLabel(f.goal), value: (f) => f.goal },
    { key: "objective", label: (f) => objectiveLabel(f.objective), value: (f) => f.objective },
    { key: "type", label: (f) => f.accountType, value: (f) => f.accountType },
    { key: "market", label: (f) => marketLabel(f.market), value: (f) => f.market },
    { key: "client", label: (f) => f.client, value: (f) => f.client },
  ];
  const loosened = { ...filters };
  for (const dim of order) {
    if (!loosened[dim.key]) continue;
    loosened[dim.key] = "";
    const spendBy = new Map<string, { label: string; spend: number }>();
    for (const f of facts) {
      if (!matches(f, loosened, period) || f.spendSgd <= 0) continue;
      const v = dim.value(f);
      const e = spendBy.get(v) ?? { label: dim.label(f), spend: 0 };
      e.spend += f.spendSgd;
      spendBy.set(v, e);
    }
    if (spendBy.size) {
      const ran = [...spendBy.values()].sort((a, b) => b.spend - a.spend).slice(0, 5).map((e) => e.label);
      return `No spend for this selection. What did run: ${ran.join(", ")}.`;
    }
  }
  return "No spend for this selection.";
}

const options = (values: Iterable<string>, label: (v: string) => string = (v) => v): Option[] =>
  [...new Set(values)].filter(Boolean).map((v) => ({ value: v, label: label(v) })).sort((a, b) => a.label.localeCompare(b.label));

export function buildView(facts: Fact[], filters: Filters): View {
  const tracked = trackedAccounts(facts);
  const period = parsePeriod(filters.period) ?? parsePeriod("")!;
  const previous = previousPeriod(period);
  const current = facts.filter((f) => matches(f, filters, period));
  const t = totals(current, tracked);
  const m = metrics(t);
  const prevTotals = previous ? totals(facts.filter((f) => matches(f, filters, previous)), tracked) : null;
  const pm = prevTotals ? metrics(prevTotals) : null;
  const prevHasData = !!prevTotals && prevTotals.spend > 0;

  const tile = (key: MetricKey, label: string, value: number | null, prev: number | null): Tile => ({
    key,
    label,
    value,
    previous: prevHasData ? prev : null,
    change: prevHasData && value !== null && prev !== null && prev !== 0 ? value / prev - 1 : null,
    better: BETTER[key],
  });
  const tiles: Tile[] = [
    tile("cpm", "CPM", m.cpm, pm?.cpm ?? null),
    tile("cpc", "CPC (link)", m.cpc, pm?.cpc ?? null),
    tile("ctr", "CTR (link)", m.ctr, pm?.ctr ?? null),
    tile("spend", "Spend", t.spend, prevTotals?.spend ?? null),
    tile("impressions", "Impressions", t.impressions, prevTotals?.impressions ?? null),
    tile("cpa", "CPA", m.cpa, pm?.cpa ?? null),
    tile("roas", "ROAS", m.roas, pm?.roas ?? null),
    tile("cpl", "CPL", m.cpl, pm?.cpl ?? null),
    tile("cpi", "CPI", m.cpi, pm?.cpi ?? null),
  ].filter((x) => {
    // Conversion tiles only where they can apply: CPA/ROAS for Sales, CPL for Leads, CPI for
    // App promotion (all of them when no objective is picked).
    if (x.key === "cpa" || x.key === "roas") return !filters.objective || filters.objective === SALES;
    if (x.key === "cpl") return !filters.objective || filters.objective === LEADS;
    if (x.key === "cpi") return !filters.objective || filters.objective === APP_PROMOTION;
    return true;
  });

  const hasSpend = t.spend > 0;
  let takeaway: string | null = null;
  if (hasSpend) {
    const markets = new Set(current.filter((f) => f.spendSgd > 0).map((f) => f.market));
    const where = filters.market ? "" : markets.size === 1 ? ` in ${marketLabel([...markets][0])}` : ` across ${markets.size} markets`;
    const cpm = m.cpm !== null ? `CPM ${sgd2(m.cpm)}` : "no impressions";
    const sales = m.cpa !== null ? `; CPA ${sgd2(m.cpa)}, ROAS ${m.roas?.toFixed(2)}x` : "";
    const leads = m.cpl !== null ? `; CPL ${sgd2(m.cpl)} on ${Math.round(t.leads).toLocaleString("en-SG")} leads` : "";
    const installs = m.cpi !== null ? `; CPI ${sgd2(m.cpi)} on ${Math.round(t.installs).toLocaleString("en-SG")} installs` : "";
    takeaway = `${describeSelection(filters, period).join(" · ")}: ${cpm} on ${sgd0(t.spend)} spend${where}${sales}${leads}${installs}.`;
  }

  // CPM by month for the current filters, ignoring period.
  const months = [...new Set(facts.map((f) => f.month))].sort();
  const series: View["chart"] = [];
  if (months.length) {
    const byMonth = new Map<string, Fact[]>();
    for (const f of facts) {
      if (!matches(f, filters, null)) continue;
      (byMonth.get(f.month) ?? byMonth.set(f.month, []).get(f.month)!).push(f);
    }
    const last = months[months.length - 1];
    for (let key = months[0]; key <= last; key = nextMonth(key)) {
      const mt = totals(byMonth.get(key) ?? [], tracked);
      series.push({
        month: key,
        label: parsePeriod(key)!.label,
        cpm: metrics(mt).cpm,
        spend: mt.spend,
        impressions: mt.impressions,
        selected: period.kind !== "all" && key >= period.start && key <= period.end,
      });
    }
  }

  const goalPool = facts.filter((f) => !filters.objective || f.objective === filters.objective);
  const periodMonths = [...new Set(facts.map((f) => f.month))].sort().reverse();

  return {
    filters,
    period,
    previous,
    previousHasData: prevHasData,
    totals: t,
    metrics: m,
    tiles,
    takeaway,
    empty: hasSpend ? null : emptyMessage(facts, filters, period),
    chart: series,
    byMarket: groupRows(current, tracked, (f) => f.market, (k) => ({ label: marketLabel(k), filter: { market: k } })),
    byClient: groupRows(current, tracked, (f) => f.client, (k) => ({ label: k, filter: { client: k } })),
    byObjectiveGoal: groupRows(
      current,
      tracked,
      (f) => `${f.objective}|${f.goal}`,
      (_k, f) => ({ label: `${objectiveLabel(f.objective)} · ${goalLabel(f.goal)}`, filter: { objective: f.objective, goal: f.goal } }),
    ),
    options: {
      periods: {
        years: [...new Set(periodMonths.map((x) => x.slice(0, 4)))].map((v) => ({ value: v, label: v })),
        quarters: [...new Set(periodMonths.map((x) => `${x.slice(0, 4)}-Q${Math.ceil(Number(x.slice(5)) / 3)}`))].map((v) => ({
          value: v,
          label: parsePeriod(v)!.label,
        })),
        months: periodMonths.map((v) => ({ value: v, label: parsePeriod(v)!.label })),
      },
      platforms: options(facts.map((f) => f.platform), platformLabel),
      objectives: options(facts.map((f) => f.objective), objectiveLabel),
      goals: options(goalPool.map((f) => f.goal), goalLabel),
      clients: options(facts.map((f) => f.client)),
      markets: options(facts.map((f) => f.market), marketLabel),
      types: options(facts.map((f) => f.accountType)),
    },
  };
}
