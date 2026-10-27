"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { View } from "@/lib/benchmarks";
import { fmt } from "@/lib/format";

type Point = View["chart"][number];

const HEIGHT = 240;
const PAD = { top: 16, right: 12, bottom: 28, left: 52 };

/** Round the axis max up to a clean step (1, 2, 2.5, 5 x 10^n). */
function niceTicks(max: number, count = 4): number[] {
  if (max <= 0) return [0];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((s) => s * mag).find((s) => s >= raw)!;
  const ticks = [];
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(Number(v.toFixed(6)));
  if (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + step);
  return ticks;
}

export function CpmChart({ points }: { points: Point[] }) {
  const [width, setWidth] = useState(720);
  const [hover, setHover] = useState<number | null>(null);
  const observer = useRef<ResizeObserver | null>(null);

  // Callback ref: (re)attach whenever the chart element mounts. A plain mount-time effect missed it
  // when the chart first rendered empty and only later got data, leaving it stuck at 720px.
  const ref = useCallback((el: HTMLDivElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!el) return;
    setWidth(Math.max(280, Math.floor(el.clientWidth)));
    observer.current = new ResizeObserver(([entry]) => setWidth(Math.max(280, Math.floor(entry.contentRect.width))));
    observer.current.observe(el);
  }, []);
  useEffect(() => () => observer.current?.disconnect(), []);

  if (!points.some((p) => p.cpm !== null)) {
    return <p className="muted">No impressions for these filters in any month.</p>;
  }

  const ticks = niceTicks(Math.max(...points.map((p) => Math.max(p.cpm ?? 0, p.quarterCpm ?? 0))));
  const yMax = ticks[ticks.length - 1];
  const plotW = width - PAD.left - PAD.right;
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const band = plotW / points.length;
  const barW = Math.min(24, Math.max(4, band - 2)); // >= 2px surface gap between adjacent bars
  const y = (v: number) => PAD.top + plotH - (v / yMax) * plotH;
  // Month labels ("Apr '25") need ~56px each; past every other month, step in calendar quarters/halves/years.
  const labelEvery = [1, 2, 3, 6, 12].find((n) => band * n >= 56) ?? 12;
  const active = hover === null ? null : points[hover];
  // Runs of consecutive months in the same quarter (the first and last can be partial).
  const quarters: { key: string; label: string; cpm: number | null; from: number; to: number }[] = [];
  points.forEach((p, i) => {
    const last = quarters[quarters.length - 1];
    if (last && last.key === p.quarter) last.to = i;
    else quarters.push({ key: p.quarter, label: p.quarterLabel, cpm: p.quarterCpm, from: i, to: i });
  });
  const money = (v: number) => `S$${v.toLocaleString("en-SG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  return (
    <div className="chart" ref={ref}>
      <div className="legend" aria-hidden>
        <span><i className="swatch swatch-selected" /> Selected period</span>
        <span><i className="swatch swatch-other" /> Other months</span>
        <span><i className="swatch-line" /> Quarter CPM</span>
      </div>
      <div className="plot">
      <svg width={width} height={HEIGHT} role="img" aria-label="CPM by month" onMouseLeave={() => setHover(null)}>
        {ticks.map((t) => (
          <g key={t}>
            <line className="grid" x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} />
            <text className="axis" x={PAD.left - 8} y={y(t)} dy="0.32em" textAnchor="end">
              {`S$${t.toLocaleString("en-SG", { maximumFractionDigits: 2 })}`}
            </text>
          </g>
        ))}
        {points.map((p, i) => {
          const cx = PAD.left + band * i + band / 2;
          const monthIndex = Number(p.month.slice(5, 7)) - 1;
          const showLabel = labelEvery >= 3 ? monthIndex % labelEvery === 0 : i % labelEvery === 0;
          const h = p.cpm === null ? 0 : Math.max(1, plotH - (y(p.cpm) - PAD.top));
          const r = Math.min(4, barW / 2, h);
          const x0 = cx - barW / 2;
          const top = PAD.top + plotH - h;
          return (
            <g key={p.month} onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} tabIndex={-1}>
              {/* Hit target spans the whole band, larger than the mark */}
              <rect x={PAD.left + band * i} y={PAD.top} width={band} height={plotH} fill="transparent" />
              {p.cpm !== null && (
                <path
                  className={p.selected ? "bar bar-selected" : "bar bar-other"}
                  opacity={hover !== null && hover !== i ? 0.55 : 1}
                  d={`M${x0},${PAD.top + plotH} V${top + r} Q${x0},${top} ${x0 + r},${top} H${x0 + barW - r} Q${x0 + barW},${top} ${x0 + barW},${top + r} V${PAD.top + plotH} Z`}
                />
              )}
              {showLabel && (
                <text className="axis" x={cx} y={HEIGHT - 8} textAnchor="middle">
                  {p.label.replace(/ (\d{2})(\d{2})$/, " '$2")}
                </text>
              )}
            </g>
          );
        })}
        {quarters.map((q) => {
          if (q.cpm === null) return null;
          const x1 = PAD.left + band * q.from + 2;
          const x2 = PAD.left + band * (q.to + 1) - 2;
          const span = x2 - x1;
          const label = span >= 104 ? `${q.label} · ${money(q.cpm)}` : span >= 46 ? money(q.cpm) : "";
          return (
            <g key={q.key} className="quarter" pointerEvents="none">
              <line x1={x1} x2={x2} y1={y(q.cpm)} y2={y(q.cpm)} />
              {label && (
                <text x={(x1 + x2) / 2} y={y(q.cpm) - 6} textAnchor="middle">
                  {label}
                </text>
              )}
            </g>
          );
        })}
        <line className="baseline" x1={PAD.left} x2={width - PAD.right} y1={PAD.top + plotH} y2={PAD.top + plotH} />
      </svg>
      {active && hover !== null && (
        <div
          className="tooltip"
          style={{
            left: Math.min(Math.max(PAD.left + band * hover + band / 2, 90), width - 90),
            top: Math.max(84, active.cpm === null ? PAD.top : y(active.cpm) - 8),
          }}
        >
          <strong>{active.label}</strong>
          <span>CPM {fmt.money(active.cpm)}</span>
          <span>Spend {fmt.money0(active.spend)}</span>
          <span>Impr. {fmt.int(active.impressions)}</span>
          <span className="tooltip-q">{active.quarterLabel} CPM {fmt.money(active.quarterCpm)}</span>
        </div>
      )}
      </div>
    </div>
  );
}
