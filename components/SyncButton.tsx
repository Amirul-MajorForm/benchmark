"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

export function SyncButton({ running }: { running: boolean }) {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "starting" | "running" | "error">(running ? "running" : "idle");
  const [message, setMessage] = useState<string | null>(null);

  // While a sync runs, check back every 15s and refresh the page when it finishes.
  useEffect(() => {
    if (state !== "running") return;
    const id = setInterval(async () => {
      const res = await fetch("/api/sync", { cache: "no-store" }).catch(() => null);
      const json = await res?.json().catch(() => null);
      if (json?.latest?.status && json.latest.status !== "running") {
        setState("idle");
        router.refresh();
      }
    }, 15_000);
    return () => clearInterval(id);
  }, [state, router]);

  const start = async () => {
    setState("starting");
    setMessage(null);
    const res = await fetch("/api/sync", { method: "POST" });
    if (res.status === 202 || res.status === 409) {
      setState("running");
      router.refresh();
    } else {
      const json = await res.json().catch(() => ({}));
      setState("error");
      setMessage(json.error ?? `Sync failed to start (${res.status})`);
    }
  };

  return (
    <span className="sync-control">
      <button className="btn" onClick={start} disabled={state === "starting" || state === "running"}>
        {state === "running" ? "Syncing… (takes a few minutes)" : state === "starting" ? "Starting…" : "Sync now"}
      </button>
      {message && <span className="error-text">{message}</span>}
    </span>
  );
}
