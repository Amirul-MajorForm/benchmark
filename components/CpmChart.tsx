"use client";

import { useEffect, useRef, useState } from "react";
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
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.max(280, Math.floor(entry.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  if (!points.some((p) => p.cpm !== null)) {
    return <p className="muted">No impressions for these filters in any month.</p>;
  }

  const ticks = niceTicks(Math.max(...points.map((p) => p.cpm ?? 0)));
  const yMax = ticks[ticks.length - 1];
  const plotW = width - PAD.left - PAD.right;
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const band = plotW / points.length;
  const barW = Math.min(24, Math.max(4, band - 2)); // >= 2px surface gap between adjacent bars
  const y = (v: number) => PAD.top + plotH - (v / yMax) * plotH;
  const labelEvery = band >= 44 ? 1 : band >= 22 ? 2 : 3;
  const active = hover === null ? null : points[hover];

  return (
    <div className="chart" ref={ref}>
      <div className="legend" aria-hidden>
        <span><i className="swatch swatch-selected" /> Selected period</span>
        <span><i className="swatch swatch-other" /> Other months</span>
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
          const showLabel = i % labelEvery === 0;
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
        </div>
      )}
      </div>
    </div>
  );
}
