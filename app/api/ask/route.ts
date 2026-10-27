import Anthropic from "@anthropic-ai/sdk";
import { NextResponse, type NextRequest } from "next/server";
import { ask } from "@/lib/ask";
import { loadFacts, loadSyncStatus } from "@/lib/benchmarks";
import { parseFilters } from "@/lib/filters";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// The app has no login, so cap usage per visitor: 30 questions an hour.
const LIMIT = 30;
const WINDOW_MS = 60 * 60_000;
const recent = new Map<string, number[]>();

function rateLimited(key: string): boolean {
  const now = Date.now();
  const hits = (recent.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  hits.push(now);
  recent.set(key, hits);
  return hits.length > LIMIT;
}

/** POST /api/ask { question, view: "<dashboard query string>" } -> { answer, view } */
export async function POST(req: NextRequest) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: "Ask needs ANTHROPIC_API_KEY set on the web service." }, { status: 503 });
  }
  const body = (await req.json().catch(() => null)) as { question?: unknown; view?: unknown } | null;
  const question = typeof body?.question === "string" ? body.question.trim() : "";
  if (!question) return NextResponse.json({ error: "Type a question first." }, { status: 400 });
  if (question.length > 500) return NextResponse.json({ error: "Keep questions under 500 characters." }, { status: 400 });

  const who = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (rateLimited(who)) return NextResponse.json({ error: "Too many questions this hour. Try again later." }, { status: 429 });

  const current = parseFilters(Object.fromEntries(new URLSearchParams(typeof body?.view === "string" ? body.view : "")));
  const sync = await loadSyncStatus();
  const facts = await loadFacts(sync.lastSuccessAt);
  if (!facts.length) return NextResponse.json({ error: "No data has been synced yet." }, { status: 409 });

  try {
    return NextResponse.json(await ask(question, facts, current, sync.lastSuccessAt));
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) {
      return NextResponse.json({ error: "Claude is busy right now. Try again in a minute." }, { status: 429 });
    }
    if (err instanceof Anthropic.AuthenticationError) {
      return NextResponse.json({ error: "ANTHROPIC_API_KEY was rejected." }, { status: 500 });
    }
    if (err instanceof Anthropic.APIError) {
      console.error("ask: Claude API error", err.status, err.message);
      return NextResponse.json({ error: `Claude API error (${err.status ?? "network"}). Try again.` }, { status: 502 });
    }
    console.error("ask failed:", err);
    return NextResponse.json({ error: "Something went wrong answering that." }, { status: 500 });
  }
}
