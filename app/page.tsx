import { BreakdownTable } from "@/components/BreakdownTable";
import { CpmChart } from "@/components/CpmChart";
import { FilterBar } from "@/components/FilterBar";
import { SyncButton } from "@/components/SyncButton";
import { buildView, loadFacts, loadSyncStatus, type Tile, type View } from "@/lib/benchmarks";
import { parseFilters } from "@/lib/filters";
import { fmt, formatMetric } from "@/lib/format";

export const dynamic = "force-dynamic";

const sgt = (iso: string) =>
  new Date(iso).toLocaleString("en-SG", { timeZone: "Asia/Singapore", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) + " SGT";

function TileCard({ tile, previous }: { tile: Tile; previous: View["previous"] }) {
  const value = formatMetric(tile.key, tile.value);
  let trend: "good" | "bad" | "flat" | null = null;
  if (tile.change !== null && tile.better) {
    trend = Math.abs(tile.change) < 0.0005 ? "flat" : (tile.change < 0) === (tile.better === "lower") ? "good" : "bad";
  }
  return (
    <div className="tile">
      <span className="tile-label">{tile.label}</span>
      <span className="tile-value">{value}</span>
      <span className={`tile-change${trend ? ` trend-${trend}` : ""}`}>
        {previous === null || tile.change === null
          ? " "
          : <>
                <span aria-hidden>{tile.change > 0 ? "▲" : tile.change < 0 ? "▼" : "•"}</span>{" "}
                {fmt.pct(Math.abs(tile.change), 1)} vs {previous.label}
                {trend && trend !== "flat" && <span className="sr-only"> ({trend === "good" ? "better" : "worse"})</span>}
              </>}
      </span>
    </div>
  );
}

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const filters = parseFilters(await searchParams);
  const sync = await loadSyncStatus();
  const facts = await loadFacts(sync.lastSuccessAt);
  const view = buildView(facts, filters);
  const syncFailed = sync.latest?.status === "failed";

  return (
    <main className="page">
      <header className="top">
        <div>
          <p className="eyebrow">MajorForm</p>
          <h1>Media Benchmarks</h1>
        </div>
        <div className="top-meta">
          <span className="muted">Data last synced: {sync.lastSuccessAt ? sgt(sync.lastSuccessAt) : "never"}</span>
          <SyncButton running={sync.latest?.status === "running"} />
        </div>
      </header>

      {syncFailed && (
        <div className="banner" role="alert">
          <strong>Last sync failed{sync.latest?.finishedAt ? ` (${sgt(sync.latest.finishedAt)})` : ""}.</strong>{" "}
          {sync.latest?.error} Showing data from the previous successful sync.
        </div>
      )}

      <FilterBar filters={view.filters} options={view.options} />

      <p className="takeaway">{view.takeaway ?? view.empty}</p>

      <section className="tiles" aria-label="Headline metrics">
        {view.tiles.map((t) => <TileCard key={t.key} tile={t} previous={view.previous} />)}
      </section>
      {view.previous && !view.previousHasData && view.takeaway && (
        <p className="muted small compare-note">No spend in {view.previous.label} for these filters, so there is nothing to compare against.</p>
      )}

      <section className="panel">
        <h2>CPM by month</h2>
        <p className="muted small">Current filters across all months; the selected period is highlighted.</p>
        <CpmChart points={view.chart} />
        <details className="chart-table">
          <summary>Show as table</summary>
          <div className="table-wrap">
            <table>
              <thead><tr><th scope="col">Month</th><th scope="col" className="num">Spend</th><th scope="col" className="num">Impressions</th><th scope="col" className="num">CPM</th></tr></thead>
              <tbody>
                {view.chart.map((p) => (
                  <tr key={p.month} className={p.selected ? "is-selected" : undefined}>
                    <th scope="row">{p.label}</th>
                    <td className="num">{fmt.money0(p.spend)}</td>
                    <td className="num">{fmt.int(p.impressions)}</td>
                    <td className="num">{fmt.money(p.cpm)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </section>

      <div className="tables">
        <BreakdownTable title="By market" firstColumn="Market" rows={view.byMarket} filters={view.filters} />
        <BreakdownTable title="By client" firstColumn="Client" rows={view.byClient} filters={view.filters} />
        <BreakdownTable title="By objective × goal" firstColumn="Objective · goal" rows={view.byObjectiveGoal} filters={view.filters} />
      </div>

      <footer className="footnote">
        <h2>How these numbers work</h2>
        <ul>
          <li><strong>SGD.</strong> All money is in Singapore dollars. Spend is converted by Two Minute Reports. Purchase values come in each account&apos;s own currency and are converted at that account&apos;s spend rate for the month (SGD spend ÷ local spend), or its all-time rate when it had no spend that month.</li>
          <li><strong>Spend-weighted ratios.</strong> CPM, CPC, CTR, CPA and ROAS are calculated from summed totals (for example CPM = total spend ÷ total impressions × 1,000), never by averaging ratios across accounts or months. CPC and CTR use link clicks.</li>
          <li><strong>Reach sits under Awareness.</strong> Optimisation goals are listed under the campaign objective they ran in, so Reach, Impressions and ThruPlay benchmarks are all found under Awareness.</li>
          <li><strong>&quot;Not reported&quot;</strong> is the goal Meta returns for Advantage+ and some legacy campaigns, which don&apos;t expose an optimisation goal.</li>
          <li><strong>CPAS</strong> (Collaborative Performance Advertising Solution) accounts run ads with a retailer such as Shopee or Lazada, which reports the sales back. Brand accounts are a client&apos;s own ad accounts.</li>
          <li><strong>Purchases.</strong> CPAS accounts use the retailer&apos;s collaborative-ads purchases and value; Brand accounts use Meta&apos;s all-purchases count and value. Attribution is each account&apos;s default setting. CPA and ROAS only count Sales-objective spend from accounts that report purchases, and show blank when there are none. Recent months can shift slightly as Meta restates data.</li>
        </ul>
      </footer>
    </main>
  );
}
