import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import { ask } from "../lib/ask";
import { buildView, DEFAULT_FILTERS } from "../lib/benchmarks";
import type { Fact } from "../lib/metrics";
import { parseQueryInput, runBenchmarkQuery } from "../lib/query";

const fact = (o: Partial<Fact>): Fact => ({
  platform: "meta", accountId: "1", accountName: "A", client: "Oatside", market: "MY", accountType: "Brand",
  objective: "OUTCOME_AWARENESS", goal: "REACH", month: "2025-04", spendSgd: 100, impressions: 100_000,
  clicks: 10, linkClicks: 5, purchases: 0, purchaseValueSgd: 0, leads: 0, installs: 0, ...o,
});

// Q1: 300 spend / 600k impr = CPM 0.50 (not the mean of 0.25 and 1.00). Q2: 400 / 400k = 1.00.
const facts = [
  fact({ month: "2025-01", spendSgd: 100, impressions: 400_000 }),
  fact({ month: "2025-02", spendSgd: 200, impressions: 200_000 }),
  fact({ month: "2025-04", spendSgd: 400, impressions: 400_000, market: "SG" }),
];

describe("query tool", () => {
  test("quarterly trend from summed components, oldest first", () => {
    const out = runBenchmarkQuery(facts, { objective: "OUTCOME_AWARENESS", group_by: "quarter" });
    assert.deepEqual(out.rows.map((r) => [r.label, r.spend_sgd, r.cpm_sgd]), [["Q1 2025", 300, 0.5], ["Q2 2025", 400, 1]]);
    assert.equal(out.latest_month_with_data, "2025-04");
  });

  test("breakdowns sort by spend; empty results say so", () => {
    assert.deepEqual(runBenchmarkQuery(facts, { group_by: "market" }).rows.map((r) => r.key), ["SG", "MY"]);
    assert.equal(runBenchmarkQuery(facts, { client: "Nobody" }).note, "No spend matches these filters.");
  });

  test("model input is validated", () => {
    assert.deepEqual(parseQueryInput({ period: "2025-Q2", goal: "all", group_by: "month" }), { period: "2025-Q2", goal: "", group_by: "month" });
    assert.match(parseQueryInput({ period: "last quarter" }) as string, /not valid/);
    assert.match(parseQueryInput({ group_by: "week" }) as string, /group_by must be/);
    assert.match(parseQueryInput({ colour: "blue" }) as string, /Unknown field/);
  });
});

describe("chart quarter CPM", () => {
  test("each month carries its quarter's CPM from sums", () => {
    const view = buildView(facts, { ...DEFAULT_FILTERS, period: "", goal: "" });
    const byMonth = Object.fromEntries(view.chart.map((p) => [p.month, [p.quarterLabel, p.quarterCpm]]));
    assert.deepEqual(byMonth["2025-01"], ["Q1 2025", 0.5]);
    assert.deepEqual(byMonth["2025-03"], ["Q1 2025", 0.5]); // no spend that month, still in Q1
    assert.deepEqual(byMonth["2025-04"], ["Q2 2025", 1]);
  });
});

describe("ask loop (scripted model)", () => {
  /** Plays back canned responses and records each request. */
  function scripted(responses: Partial<Anthropic.Beta.BetaMessage>[]) {
    const requests: any[] = [];
    const client = {
      beta: {
        messages: {
          create: async (req: any) => {
            requests.push(structuredClone(req));
            return { stop_details: null, ...responses[requests.length - 1] };
          },
        },
      },
    } as unknown as Pick<Anthropic, "beta">;
    return { client, requests };
  }

  test("runs query_benchmarks, returns the answer and the suggested view", async () => {
    const { client, requests } = scripted([
      {
        stop_reason: "tool_use",
        content: [
          { type: "tool_use", id: "t1", name: "query_benchmarks", input: { objective: "OUTCOME_AWARENESS", group_by: "quarter" } } as any,
        ],
      },
      {
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t2", name: "show_on_dashboard", input: { period: "2025-Q2", objective: "OUTCOME_AWARENESS" } } as any],
      },
      { stop_reason: "end_turn", content: [{ type: "text", text: "CPM doubled QoQ.\n- **Q2 2025: S$1.00**" } as any] },
    ]);
    const out = await ask("What's the QoQ trend?", facts, DEFAULT_FILTERS, null, client);
    assert.equal(out.answer, "CPM doubled QoQ.\n- **Q2 2025: S$1.00**");
    assert.equal(out.view, "period=2025-Q2&objective=OUTCOME_AWARENESS");

    // The tool result Claude saw holds the real quarterly numbers.
    const toolResult = JSON.parse(requests[1].messages[2].content[0].content);
    assert.deepEqual(toolResult.rows.map((r: any) => r.cpm_sgd), [0.5, 1]);
    // Request shape: model, fallbacks, current view in the system prompt.
    assert.equal(requests[0].model, "claude-opus-5-5");
    assert.equal(requests[0].fallbacks, "default");
    assert.match(requests[0].system, /objective=OUTCOME_AWARENESS, goal=REACH/);
  });

  test("bad tool input goes back as an error result; refusals end politely", async () => {
    const { client, requests } = scripted([
      { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "query_benchmarks", input: { period: "lately" } } as any] },
      { stop_reason: "refusal", content: [] },
    ]);
    const out = await ask("?", facts, DEFAULT_FILTERS, null, client);
    assert.equal(requests[1].messages[2].content[0].is_error, true);
    assert.match(out.answer, /couldn't answer/);
  });
});
