import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildView, DEFAULT_FILTERS, filtersToQuery, parseFilters, parsePeriod, previousPeriod } from "../lib/benchmarks";
import type { Fact } from "../lib/metrics";
import { halfYearChunks, planChunks, quarterRanges, recentWindowStart } from "../lib/sync";
import { extractTable } from "../lib/tmr";
import { applyCurrencyConversion, type FactRow, mainQuery, mergeChunk, monthStart, num } from "../lib/transform";

describe("transform", () => {
  test("year_month conversion", () => {
    assert.equal(monthStart("2025-Feb"), "2025-02-01");
    assert.equal(monthStart("2026-Oct"), "2026-10-01");
    assert.equal(monthStart("2025-07"), "2025-07-01");
  });

  test("empty cells are null", () => {
    assert.equal(num(""), null);
    assert.equal(num(undefined), null);
    assert.equal(num("1,234.5"), 1234.5);
    assert.equal(num(0), 0);
  });

  test("columns map by position, not by header label", () => {
    const q = mainQuery("2025-06-01", "2025-06-30");
    const json = { connectorResults: [{ results: [{ data: { headers: ["A", "B", "C", "D", "E", "F", "G", "H"], rows: [[1, 2, 3, 4, 5, 6, 7, 8]] } }] }] };
    assert.deepEqual(extractTable(json, { query: q }).fields, [...q.dimensions, ...q.metrics]);
    assert.throws(() => extractTable({ connectorResults: [{ results: [{ data: { headers: ["A"], rows: [[1]] } }] }] }, { query: q }));
  });

  test("purchases use collab fields for CPAS and all_purchases for Brand; zero-spend purchase rows are kept", () => {
    const main = { fields: ["account_id", "campaign_objective", "optimization_goal", "year_month", "spend", "impressions", "clicks", "link_clicks"], rows: [] };
    const purchases = {
      fields: ["account_id", "campaign_objective", "optimization_goal", "year_month", "spend", "all_purchases", "purchase_conversions_all", "collab_action_omni_purchase", "collab_ads_value_omni_purchase"],
      rows: [
        ["111", "OUTCOME_SALES", "OFFSITE_CONVERSIONS", "2025-Jan", 0, 1, "", 7, 70],
        ["222", "OUTCOME_SALES", "OFFSITE_CONVERSIONS", "2025-Jan", 10, 3, 30, "", ""],
      ],
    };
    const rows = mergeChunk(main, purchases, new Map([["111", "CPAS"], ["222", "Brand"]]));
    const byId = Object.fromEntries(rows.map((r) => [r.accountId, r]));
    assert.equal(byId["111"].purchases, 7);
    assert.equal(byId["111"].purchaseValueNative, 70);
    assert.equal(byId["111"].spendSgd, 0);
    assert.equal(byId["222"].purchases, 3);
    assert.equal(byId["222"].purchaseValueNative, 30);
  });

  test("currency: monthly rate, then all-time fallback, then 1 for SGD accounts", () => {
    const r = (accountId: string, month: string, spendSgd: number, spendNative: number | null, value: number | null): FactRow => ({
      platform: "meta", accountId, objective: "OUTCOME_SALES", goal: "X", month, spendSgd, impressions: 0, clicks: 0,
      linkClicks: 0, spendNative, purchases: 1, purchaseValueNative: value, purchaseValueSgd: null,
    });
    const rows = [
      r("myr", "2025-01-01", 30, 100, 1000), // rate 0.3
      r("myr", "2025-02-01", 40, 200, 1000), // rate 0.2
      r("myr", "2025-03-01", 0, 0, 1000), // no spend: all-time 70/300
      r("sgd", "2025-01-01", 0, 0, 50), // never spent, SGD-billed
    ];
    applyCurrencyConversion(rows, new Map([["sgd", "SGD"]]));
    assert.ok(Math.abs(rows[0].purchaseValueSgd! - 300) < 1e-9);
    assert.ok(Math.abs(rows[1].purchaseValueSgd! - 200) < 1e-9);
    assert.ok(Math.abs(rows[2].purchaseValueSgd! - (1000 * 70) / 300) < 1e-9);
    assert.equal(rows[3].purchaseValueSgd, 50);
  });
});

describe("sync planning", () => {
  test("half-year chunks from 2025-01-01, last one clipped", () => {
    assert.deepEqual(
      halfYearChunks("2025-01-01", "2026-10-25").map((c) => `${c.start}..${c.end}`),
      ["2025-01-01..2025-06-30", "2025-07-01..2025-12-31", "2026-01-01..2026-06-30", "2026-07-01..2026-10-25"],
    );
  });

  test("quarters inside a chunk", () => {
    assert.deepEqual(quarterRanges({ start: "2026-07-01", end: "2026-10-25" }), [
      { start: "2026-07-01", end: "2026-09-30" },
      { start: "2026-10-01", end: "2026-10-25" },
    ]);
  });

  test("first run backfills everything; later runs re-pull whole half-years that hold the last 3 months", () => {
    assert.equal(recentWindowStart("2026-10-25"), "2026-08-01");
    assert.equal(recentWindowStart("2027-01-03"), "2026-11-01");
    assert.equal(planChunks("2026-10-25", new Set()).length, 4);
    const synced = new Set(["2025-01-01", "2025-07-01", "2026-01-01", "2026-07-01"]);
    assert.deepEqual(planChunks("2026-10-25", synced).map((c) => c.start), ["2026-07-01"]);
    assert.deepEqual(planChunks("2027-01-03", new Set([...synced])).map((c) => c.start), ["2026-07-01", "2027-01-01"]);
    assert.equal(planChunks("2026-10-25", synced, true).length, 4);
  });
});

describe("filters and periods", () => {
  test("bare URL gets the default view; explicit All stays All", () => {
    assert.deepEqual(parseFilters({}), DEFAULT_FILTERS);
    assert.equal(parseFilters({ period: "all" }).goal, "");
    assert.equal(parseFilters({ period: "all" }).period, "");
    assert.equal(filtersToQuery(DEFAULT_FILTERS), "period=2025-Q2&objective=OUTCOME_AWARENESS&goal=REACH");
  });

  test("previous periods", () => {
    assert.equal(previousPeriod(parsePeriod("2025-Q1")!)!.key, "2024-Q4");
    assert.equal(previousPeriod(parsePeriod("2025-01")!)!.key, "2024-12");
    assert.equal(previousPeriod(parsePeriod("2026")!)!.key, "2025");
    assert.equal(previousPeriod(parsePeriod("")!), null);
  });
});

describe("view", () => {
  const fact = (o: Partial<Fact>): Fact => ({
    platform: "meta", accountId: "1", accountName: "A", client: "Oatside", market: "SG", accountType: "Brand",
    objective: "OUTCOME_AWARENESS", goal: "IMPRESSIONS", month: "2025-05", spendSgd: 100, impressions: 100_000,
    clicks: 10, linkClicks: 5, purchases: 0, purchaseValueSgd: 0, ...o,
  });

  test("empty state names what did run when the goal is loosened", () => {
    const view = buildView([fact({})], DEFAULT_FILTERS);
    assert.equal(view.empty, "No spend for this selection. What did run: Impressions.");
    assert.equal(view.takeaway, null);
  });

  test("takeaway and change vs previous period (ratios from sums)", () => {
    const facts = [
      fact({ goal: "REACH", month: "2025-05", spendSgd: 100, impressions: 200_000 }),
      fact({ goal: "REACH", month: "2025-06", spendSgd: 300, impressions: 200_000, market: "MY" }),
      fact({ goal: "REACH", month: "2025-02", spendSgd: 100, impressions: 100_000 }),
    ];
    const view = buildView(facts, DEFAULT_FILTERS);
    assert.equal(view.metrics.cpm, 1); // 400 / 400k * 1000, not the mean of 0.5 and 1.5
    assert.equal(view.takeaway, "Q2 2025 · Awareness · Reach goal: CPM S$1.00 on S$400 spend across 2 markets.");
    const cpm = view.tiles.find((t) => t.key === "cpm")!;
    assert.equal(cpm.previous, 1);
    assert.equal(cpm.change, 0);
    assert.deepEqual(view.chart.map((c) => c.selected), [false, false, true, true, true]);
  });
});
