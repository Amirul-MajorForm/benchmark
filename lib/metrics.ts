/**
 * Metric definitions (brief section 5). Components are always summed over the filtered set
 * first and only then divided. Ratios are never averaged.
 */

export type Fact = {
  platform: string;
  accountId: string;
  accountName: string;
  client: string;
  market: string;
  accountType: "Brand" | "CPAS";
  objective: string;
  goal: string;
  month: string; // YYYY-MM
  spendSgd: number;
  impressions: number;
  clicks: number;
  linkClicks: number;
  purchases: number;
  purchaseValueSgd: number;
  leads: number;
};

export type Totals = {
  spend: number;
  impressions: number;
  clicks: number;
  linkClicks: number;
  /** Sales-objective spend from accounts that have ever reported a purchase. */
  spendTracked: number;
  purchases: number;
  purchaseValue: number;
  /** Leads-objective spend from accounts that have ever reported a lead. */
  spendLeads: number;
  leads: number;
};

export type Metrics = {
  cpm: number | null;
  cpc: number | null;
  ctr: number | null;
  cpa: number | null;
  roas: number | null;
  cpl: number | null;
};

export const SALES = "OUTCOME_SALES";
export const LEADS = "OUTCOME_LEADS";

const salesKey = (f: Pick<Fact, "platform" | "accountId">) => `sales|${f.platform}|${f.accountId}`;
const leadsKey = (f: Pick<Fact, "platform" | "accountId">) => `leads|${f.platform}|${f.accountId}`;

/**
 * Accounts whose conversions count, across all synced data: Sales accounts that report any
 * purchases (for CPA/ROAS) and Leads accounts that report any leads (for CPL). Accounts with no
 * tracking would otherwise drag those ratios down.
 */
export function trackedAccounts(all: Fact[]): Set<string> {
  const counts = new Map<string, number>();
  for (const f of all) {
    if (f.objective === SALES) counts.set(salesKey(f), (counts.get(salesKey(f)) ?? 0) + f.purchases);
    if (f.objective === LEADS) counts.set(leadsKey(f), (counts.get(leadsKey(f)) ?? 0) + f.leads);
  }
  return new Set([...counts].filter(([, n]) => n > 0).map(([k]) => k));
}

export function emptyTotals(): Totals {
  return { spend: 0, impressions: 0, clicks: 0, linkClicks: 0, spendTracked: 0, purchases: 0, purchaseValue: 0, spendLeads: 0, leads: 0 };
}

export function addFact(t: Totals, f: Fact, tracked: Set<string>): Totals {
  t.spend += f.spendSgd;
  t.impressions += f.impressions;
  t.clicks += f.clicks;
  t.linkClicks += f.linkClicks;
  if (f.objective === SALES && tracked.has(salesKey(f))) {
    t.spendTracked += f.spendSgd;
    t.purchases += f.purchases;
    t.purchaseValue += f.purchaseValueSgd;
  }
  if (f.objective === LEADS && tracked.has(leadsKey(f))) {
    t.spendLeads += f.spendSgd;
    t.leads += f.leads;
  }
  return t;
}

export function totals(rows: Fact[], tracked: Set<string>): Totals {
  const t = emptyTotals();
  for (const f of rows) addFact(t, f, tracked);
  return t;
}

export function metrics(t: Totals): Metrics {
  return {
    cpm: t.impressions > 0 ? (t.spend / t.impressions) * 1000 : null,
    cpc: t.linkClicks > 0 ? t.spend / t.linkClicks : null,
    ctr: t.impressions > 0 ? t.linkClicks / t.impressions : null,
    // Blank, not 0, when nothing was purchased.
    cpa: t.purchases > 0 ? t.spendTracked / t.purchases : null,
    roas: t.purchases > 0 && t.spendTracked > 0 ? t.purchaseValue / t.spendTracked : null,
    cpl: t.leads > 0 ? t.spendLeads / t.leads : null,
  };
}

export type MetricKey = keyof Metrics | "spend" | "impressions";

/** Lower is better for costs (incl. CPL); higher is better for CTR and ROAS. Volume has no direction. */
export const BETTER: Record<MetricKey, "lower" | "higher" | null> = {
  cpm: "lower",
  cpc: "lower",
  cpa: "lower",
  ctr: "higher",
  roas: "higher",
  cpl: "lower",
  spend: null,
  impressions: null,
};
