/**
 * "Ask": answers natural-language questions about the benchmarks with Claude. Claude never sees raw
 * data up front; it calls query_benchmarks, which runs the dashboard's own aggregation code, so every
 * figure in an answer is computed the same way as the page (ratios from summed components).
 */
import Anthropic from "@anthropic-ai/sdk";
import type { Fact } from "./metrics";
import { type Filters, filtersToQuery, parsePeriod } from "./filters";
import { goalLabel, marketLabel, objectiveLabel } from "./labels";
import { GROUP_BYS, parseQueryInput, runBenchmarkQuery } from "./query";

const MODEL = process.env.ASK_MODEL || "claude-opus-5-5";
const MAX_STEPS = 8;

const FILTER_PROPS = {
  period: { type: "string", description: 'Year "2025", quarter "2025-Q2", month "2025-04", or "all". Omit for all time.' },
  platform: { type: "string", description: 'Platform id, e.g. "meta".' },
  objective: { type: "string", description: "Raw objective id, e.g. OUTCOME_AWARENESS." },
  goal: { type: "string", description: "Raw optimisation goal id, e.g. REACH." },
  client: { type: "string", description: "Client name exactly as listed." },
  market: { type: "string", description: "Market code, e.g. SG, MY." },
  type: { type: "string", enum: ["Brand", "CPAS"], description: "Account type." },
  account: { type: "string", description: "Ad account id (digits)." },
} as const;

const TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: "query_benchmarks",
    description:
      "Aggregate synced ad data for a filter set and return totals and ratios (CPM, CPC, CTR, CPA, ROAS, CPL, CPI) " +
      "computed from summed components. Use group_by for trends (month, quarter, year) or breakdowns " +
      "(market, client, objective, objective_goal, account, account_type). Omitted filters mean All. " +
      "Call it as many times as needed; never estimate or average numbers yourself.",
    input_schema: {
      type: "object",
      properties: {
        ...FILTER_PROPS,
        group_by: { type: "string", enum: [...GROUP_BYS], description: "How to split the result. Default none (one total row)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "show_on_dashboard",
    description:
      "Offer the user a link that sets the dashboard filters to the view that best illustrates the answer. " +
      "Call at most once, after you have the numbers. Omitted filters mean All.",
    input_schema: { type: "object", properties: FILTER_PROPS, additionalProperties: false },
  },
];

function systemPrompt(facts: Fact[], current: Filters, lastSyncedAt: string | null): string {
  const uniq = (xs: string[]) => [...new Set(xs)].sort();
  const months = uniq(facts.map((f) => f.month));
  const objectives = uniq(facts.map((f) => f.objective));
  const goalsBy = objectives.map((o) => `  ${o} (${objectiveLabel(o)}): ${uniq(facts.filter((f) => f.objective === o).map((f) => f.goal)).map((g) => `${g} (${goalLabel(g)})`).join(", ")}`);
  const view = Object.entries(current).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(", ") || "everything (all filters set to All)";
  const today = new Date().toISOString().slice(0, 10);

  return `You answer questions about MajorForm's paid media benchmarks: monthly ad performance across clients, markets and platforms, all money in SGD.

Today is ${today}. Data covers ${months[0] ?? "nothing yet"} to ${months.at(-1) ?? "-"}${lastSyncedAt ? `, last synced ${lastSyncedAt}` : ""}. The latest month and quarter are usually partial; say so when they appear in a comparison.

Dimensions and values in the data:
- platform: ${uniq(facts.map((f) => f.platform)).join(", ")}
- clients: ${uniq(facts.map((f) => f.client)).join(", ")}
- markets: ${uniq(facts.map((f) => f.market)).map((m) => `${m} (${marketLabel(m)})`).join(", ")}
- account types: Brand (client's own ad accounts), CPAS (collaborative ads with a retailer such as Shopee or Lazada)
- objectives and their optimisation goals:
${goalsBy.join("\n")}
"Unknown Optimization Goal" means Meta did not report one (Advantage+ and some legacy campaigns); call it "Not reported".

Metrics: CPM = spend / impressions x 1000; CPC = spend / link clicks; CTR = link clicks / impressions; CPA and ROAS use Sales-objective spend from accounts that report purchases; CPL uses Leads-objective spend and Meta leads; CPI uses App promotion spend and app installs. Lower is better for CPM, CPC, CPA, CPL and CPI; higher is better for CTR and ROAS. Ratios are always computed from summed totals; never average ratios across rows.

The user is currently looking at the dashboard filtered to: ${view}. Read questions that don't name a filter ("what's the QoQ trend") as being about this view. "QoQ" means quarter on quarter, "MoM" month on month, "YoY" year on year.

How to answer:
- Get every number from query_benchmarks; never invent or estimate figures.
- Lead with the direct answer in one or two sentences, then up to six short "- " bullets with the key figures and percentage changes. Format money as S$1,234 (spend) or S$0.39 (unit costs).
- Plain text only: no tables, no headings. **Bold** is fine for the one or two most important figures.
- If the data can't answer the question, say what is missing in one sentence.
- When a specific dashboard view would help, call show_on_dashboard once at the end.`;
}

export type AskResult = { answer: string; view: string | null };

export async function ask(
  question: string,
  facts: Fact[],
  current: Filters,
  lastSyncedAt: string | null,
  client: Pick<Anthropic, "beta"> = new Anthropic(),
): Promise<AskResult> {
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: question }];
  const system = systemPrompt(facts, current, lastSyncedAt);
  let view: string | null = null;

  for (let step = 0; step < MAX_STEPS; step++) {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      output_config: { effort: "medium" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system,
      tools: TOOLS,
      messages,
    });

    if (response.stop_reason === "refusal") {
      return { answer: "Claude couldn't answer that question. Try rephrasing it as a question about the benchmark data.", view };
    }
    if (response.stop_reason === "max_tokens") {
      return { answer: "That answer ran too long. Try a narrower question.", view };
    }

    const toolUses = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (response.stop_reason !== "tool_use" || !toolUses.length) {
      const answer = response.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      return { answer: answer || "No answer came back. Try again.", view };
    }

    messages.push({ role: "assistant", content: response.content });
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = toolUses.map((tool) => {
      const input = parseQueryInput(tool.input);
      if (typeof input === "string") return { type: "tool_result", tool_use_id: tool.id, content: input, is_error: true };
      if (tool.name === "query_benchmarks") {
        return { type: "tool_result", tool_use_id: tool.id, content: JSON.stringify(runBenchmarkQuery(facts, input)) };
      }
      if (tool.name === "show_on_dashboard") {
        const f: Filters = { period: "", platform: "", objective: "", goal: "", client: "", market: "", type: "", account: "" };
        for (const [k, v] of Object.entries(input)) if (k in f && typeof v === "string") f[k as keyof Filters] = v;
        if (f.period && !parsePeriod(f.period)) f.period = "";
        view = filtersToQuery(f);
        return { type: "tool_result", tool_use_id: tool.id, content: "Link shown to the user." };
      }
      return { type: "tool_result", tool_use_id: tool.id, content: `Unknown tool ${tool.name}.`, is_error: true };
    });
    messages.push({ role: "user", content: results });
  }
  return { answer: "That question needed too many lookups. Try a more specific question.", view };
}
