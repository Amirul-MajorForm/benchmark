"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import type { View } from "@/lib/benchmarks";
import { type Filters, filtersToQuery } from "@/lib/filters";

type Props = { filters: Filters; options: View["options"] };

export function FilterBar({ filters, options }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const set = (patch: Partial<Filters>) => {
    const next = { ...filters, ...patch };
    // Goals depend on the objective: reset to All when the objective changes.
    if ("objective" in patch && patch.objective !== filters.objective) next.goal = "";
    startTransition(() => router.push(`/?${filtersToQuery(next)}`, { scroll: false }));
  };

  const select = (key: keyof Filters, label: string, opts: { value: string; label: string }[]) => (
    <label className="filter">
      <span>{label}</span>
      <select value={filters[key]} onChange={(e) => set({ [key]: e.target.value })}>
        <option value="">All</option>
        {opts.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <div className={`filters${pending ? " is-pending" : ""}`} aria-busy={pending}>
      <label className="filter">
        <span>Period</span>
        <select value={filters.period} onChange={(e) => set({ period: e.target.value })}>
          <option value="">All</option>
          <optgroup label="Years">
            {options.periods.years.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </optgroup>
          <optgroup label="Quarters">
            {options.periods.quarters.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </optgroup>
          <optgroup label="Months">
            {options.periods.months.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </optgroup>
        </select>
      </label>
      {select("platform", "Platform", options.platforms)}
      {select("objective", "Objective", options.objectives)}
      {select("goal", "Optimisation goal", options.goals)}
      {select("client", "Client", options.clients)}
      {select("market", "Market", options.markets)}
      {select("type", "Account type", options.types)}
      {filters.account && (
        <button className="chip" onClick={() => set({ account: "" })} title="Remove account filter">
          Account {filters.account} ×
        </button>
      )}
    </div>
  );
}
