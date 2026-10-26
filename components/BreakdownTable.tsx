"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import type { Row } from "@/lib/benchmarks";
import { type Filters, filtersToQuery } from "@/lib/filters";
import { type ColumnKey, formatMetric } from "@/lib/format";

const COLUMNS: { key: ColumnKey; label: string }[] = [
  { key: "spend", label: "Spend" },
  { key: "impressions", label: "Impressions" },
  { key: "cpm", label: "CPM" },
  { key: "cpc", label: "CPC" },
  { key: "ctr", label: "CTR" },
  { key: "cpa", label: "CPA" },
  { key: "roas", label: "ROAS" },
  { key: "cpl", label: "CPL" },
];

const value = (r: Row, k: ColumnKey): number | null =>
  k === "spend" ? r.totals.spend : k === "impressions" ? r.totals.impressions : r.metrics[k];

type Props = { title: string; firstColumn: string; rows: Row[]; filters: Filters };

export function BreakdownTable({ title, firstColumn, rows, filters }: Props) {
  const router = useRouter();
  const [sort, setSort] = useState<{ key: ColumnKey | "label"; dir: 1 | -1 }>({ key: "spend", dir: -1 });

  const sorted = useMemo(() => {
    const out = [...rows];
    out.sort((a, b) => {
      if (sort.key === "label") return a.label.localeCompare(b.label) * sort.dir;
      const av = value(a, sort.key);
      const bv = value(b, sort.key);
      if (av === null && bv === null) return 0;
      if (av === null) return 1; // blanks always last
      if (bv === null) return -1;
      return (av - bv) * sort.dir;
    });
    return out;
  }, [rows, sort]);

  const toggle = (key: ColumnKey | "label") =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: key === "label" ? 1 : -1 }));

  const apply = (r: Row) => router.push(`/?${filtersToQuery({ ...filters, ...r.filter })}`, { scroll: false });

  const header = (key: ColumnKey | "label", label: string, numeric: boolean) => (
    <th
      scope="col"
      className={numeric ? "num" : undefined}
      aria-sort={sort.key === key ? (sort.dir === 1 ? "ascending" : "descending") : "none"}
    >
      <button onClick={() => toggle(key)}>
        {label}
        <span className="sort-mark" aria-hidden>{sort.key === key ? (sort.dir === 1 ? "▲" : "▼") : ""}</span>
      </button>
    </th>
  );

  return (
    <section className="panel">
      <h2>{title}</h2>
      {rows.length === 0 ? (
        <p className="muted">Nothing to show.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                {header("label", firstColumn, false)}
                {COLUMNS.map((c) => header(c.key, c.label, true))}
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => (
                <tr
                  key={r.key}
                  tabIndex={0}
                  onClick={() => apply(r)}
                  onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), apply(r))}
                  title="Filter to this row"
                >
                  <th scope="row">{r.label}</th>
                  {COLUMNS.map((c) => (
                    <td key={c.key} className="num">{formatMetric(c.key, value(r, c.key))}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
