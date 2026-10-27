"use client";

import Link from "next/link";
import { type FormEvent, Fragment, type ReactNode, useEffect, useRef, useState } from "react";

const SUGGESTIONS = [
  "What's the QoQ CPM trend for this view?",
  "Which market has the lowest CPM for Reach this year?",
  "How did CPA and ROAS change month on month for CPAS?",
  "Which client spent the most last quarter, and at what CPM?",
];

/** **bold** inside a line. */
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith("**") && part.endsWith("**") ? <strong key={i}>{part.slice(2, -2)}</strong> : <Fragment key={i}>{part}</Fragment>,
  );
}

/** Paragraphs and "- " bullet lists: all the formatting the answers use. */
function Answer({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let bullets: string[] = [];
  const flush = () => {
    if (bullets.length) blocks.push(<ul key={blocks.length}>{bullets.map((b, i) => <li key={i}>{inline(b)}</li>)}</ul>);
    bullets = [];
  };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (/^[-*•] /.test(line)) bullets.push(line.slice(2));
    else {
      flush();
      if (line) blocks.push(<p key={blocks.length}>{inline(line)}</p>);
    }
  }
  flush();
  return <div className="ask-answer">{blocks}</div>;
}

export function AskPanel({ view }: { view: string }) {
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [state, setState] = useState<{ status: "idle" | "loading" | "done" | "error"; answer?: string; link?: string | null; asked?: string }>({ status: "idle" });
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);

  const submit = async (q: string) => {
    const text = q.trim();
    if (!text || state.status === "loading") return;
    setQuestion(text);
    setState({ status: "loading", asked: text });
    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: text, view }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) setState({ status: "error", answer: json.error ?? `Request failed (${res.status})`, asked: text });
      else setState({ status: "done", answer: json.answer, link: json.view, asked: text });
    } catch {
      setState({ status: "error", answer: "Couldn't reach the server. Check your connection and try again.", asked: text });
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void submit(question);
  };

  if (!open) {
    return (
      <button className="ask-open" onClick={() => setOpen(true)} aria-expanded={false} aria-controls="ask-panel">
        <span aria-hidden>✦</span> Ask a question about these benchmarks…
      </button>
    );
  }

  return (
    <section id="ask-panel" className="ask-panel" aria-label="Ask about the benchmarks">
      <div className="ask-head">
        <h2>Ask about the benchmarks</h2>
        <button className="btn btn-quiet" onClick={() => setOpen(false)} aria-expanded={true} aria-controls="ask-panel">
          Close
        </button>
      </div>
      <form onSubmit={onSubmit} className="ask-form">
        <textarea
          ref={input}
          value={question}
          maxLength={500}
          rows={2}
          placeholder="Ask in plain English, e.g. what's the QoQ trend?"
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void submit(question);
            }
          }}
        />
        <button className="btn btn-primary" type="submit" disabled={state.status === "loading" || !question.trim()}>
          {state.status === "loading" ? "Thinking…" : "Ask"}
        </button>
      </form>
      {state.status === "idle" && (
        <div className="ask-suggestions">
          {SUGGESTIONS.map((s) => (
            <button key={s} className="chip" onClick={() => void submit(s)}>
              {s}
            </button>
          ))}
        </div>
      )}
      {state.status === "loading" && <p className="muted small ask-status">Looking through the numbers… this usually takes 10 to 30 seconds.</p>}
      {(state.status === "done" || state.status === "error") && (
        <div className={state.status === "error" ? "ask-result is-error" : "ask-result"} aria-live="polite">
          <p className="ask-q">{state.asked}</p>
          {state.status === "error" ? <p className="error-text">{state.answer}</p> : <Answer text={state.answer ?? ""} />}
          {state.link && (
            <Link className="ask-link" href={`/?${state.link}`} scroll={false}>
              Open this view on the dashboard →
            </Link>
          )}
        </div>
      )}
      <p className="muted ask-note">Answers come from Claude using the synced data and the same calculations as the dashboard. Check important numbers against the tables.</p>
    </section>
  );
}
