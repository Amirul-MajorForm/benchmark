import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { Client } from "pg";
import { closePool, getPool, migrate } from "../lib/db";
import { buildConverter, type DailyRateMap, daysBetween, ensureDailyRates, monthAverage, rateOn } from "../lib/fx";
import { dayOf, mergeChunk, parseDailySpend } from "../lib/transform";

// Own database so this file can run alongside the acceptance tests.
const base = process.env.TEST_PG_URL ?? "postgres://postgres@127.0.0.1:5432";
process.env.DATABASE_URL = `${base}/benchmarks_fx_test`;

const rates = (entries: [string, number][]): DailyRateMap => new Map(entries);

describe("fx: conversion rules", () => {
  // SGD per PHP: 0.0230 on Jun 2, 0.0240 on Jun 3, nothing published on Jun 4 (borrows Jun 3), 0.0200 on Jun 20
  const r = rates([["PHP|2025-06-02", 0.023], ["PHP|2025-06-03", 0.024], ["PHP|2025-06-20", 0.02]]);

  test("missing days borrow the closest earlier day; SGD is always 1", () => {
    assert.equal(rateOn(r, "PHP", "2025-06-04"), 0.024);
    assert.equal(rateOn(r, "php", "2025-06-02"), 0.023);
    assert.equal(rateOn(r, "PHP", "2025-06-01"), null);
    assert.equal(rateOn(r, "SGD", "2025-01-01"), 1);
  });

  test("spend-weighted rate per account-month; monthly average without daily spend", () => {
    const toSgd = buildConverter(r, [
      { accountId: "ph", currency: "PHP", day: "2025-06-02", spend: 1000 },
      { accountId: "ph", currency: "PHP", day: "2025-06-03", spend: 3000 },
    ]);
    // (1000 x 0.023 + 3000 x 0.024) / 4000 = 0.02375, not the month average (0.0223)
    assert.ok(Math.abs(toSgd("ph", "PHP", "2025-06-01") - 0.02375) < 1e-12);
    assert.ok(Math.abs(toSgd("other", "PHP", "2025-06-01") - monthAverage(r, "PHP", "2025-06-01")!) < 1e-12);
    assert.equal(toSgd("x", "SGD", "2025-06-01"), 1);
    // July has no rates yet: borrows the latest earlier day
    assert.equal(toSgd("ph", "PHP", "2025-07-01"), 0.02);
    assert.throws(() => toSgd("ph", "MYR", "2025-06-01"), /No MYR->SGD/);
  });

  test("daily spend rows parse dates and skip zero spend", () => {
    assert.equal(dayOf("2025-06-02T00:00:00.000Z"), "2025-06-02");
    assert.equal(dayOf("20250602"), "2025-06-02");
    const rows = parseDailySpend({
      fields: ["account_id", "date", "account_currency", "spend"],
      rows: [["act_1", "2025-06-02", "php", "1,000"], ["act_1", "2025-06-03", "PHP", 0]],
    });
    assert.deepEqual(rows, [{ accountId: "1", currency: "PHP", day: "2025-06-02", spend: 1000 }]);
  });

  test("mergeChunk converts each account's spend with its own rate", () => {
    const main = {
      fields: ["account_id", "campaign_objective", "optimization_goal", "year_month", "account_currency", "spend", "impressions", "clicks", "link_clicks"],
      rows: [
        ["1001057058029561", "OUTCOME_SALES", "X", "2025-Apr", "MYR", 12852.35, 100, 1, 1],
        ["764971328270854", "OUTCOME_SALES", "X", "2025-Apr", "SGD", 2940.63, 100, 1, 1],
      ],
    };
    const toSgd = (_a: string, c: string, m: string) => (c === "MYR" && m === "2025-04-01" ? 0.3 : 1);
    const rows = mergeChunk(main, { fields: [], rows: [] }, new Map(), "meta", toSgd);
    assert.equal(rows.find((x) => x.accountId === "1001057058029561")!.spendSgd, 3855.71); // 12852.35 x 0.3, to the cent
    assert.equal(rows.find((x) => x.accountId === "764971328270854")!.spendSgd, 2940.63);
  });
});

describe("fx: cached daily rates", () => {
  before(async () => {
    const admin = new Client({ connectionString: `${base}/postgres` });
    await admin.connect();
    const { rows } = await admin.query("select 1 from pg_database where datname = 'benchmarks_fx_test'");
    if (!rows.length) await admin.query("create database benchmarks_fx_test");
    await admin.end();
    await migrate();
    await getPool().query("truncate fx_daily");
  });
  after(closePool);

  test("fetches only missing days up to yesterday, and serves the cache after that", async () => {
    const fetched: string[] = [];
    const fetcher = async (date: string) => {
      fetched.push(date);
      return date === "2025-04-03" ? null : { myr: 3.3, php: 42 }; // one unpublished day
    };
    const days = daysBetween("2025-04-01", "2025-04-30");
    const got = await ensureDailyRates(["MYR", "SGD"], days, "2025-04-11", fetcher, () => {});
    assert.equal(fetched.length, 10); // Apr 1-10; today and later are skipped
    assert.equal(got.size, 9); // Apr 3 unpublished
    assert.ok(Math.abs(got.get("MYR|2025-04-01")! - 1 / 3.3) < 1e-12);

    fetched.length = 0;
    await ensureDailyRates(["MYR"], days, "2025-04-11", fetcher, () => {});
    assert.deepEqual(fetched, ["2025-04-03"], "only the unpublished day is asked for again");
  });
});
