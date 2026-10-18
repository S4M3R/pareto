import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { CompareProvidersData } from "../../lib/schemas.js";
import { ms, money, q2 } from "./kit.js";

export type P = CompareProvidersData["providers"][number];
export type Metric = "frontier" | "quality" | "price" | "speed" | "value";

/** Color follows the entity, never its rank: a provider keeps its slot whatever the sort or filter. Three slots
 * validate all-pairs for scatter; any further provider folds into neutral grey rather than a generated hue. */
export function colorMap(providers: P[]): Record<string, string> {
  const ids = [...providers].map((p) => p.listing_id).sort();
  return Object.fromEntries(ids.map((id, i) => [id, i < 3 ? `var(--pv-s${i + 1})` : "var(--pv-s0)"]));
}

const valuePerDollar = (p: P) => p.quality / (p.price_cents_per_call / 100);

function niceTicks(lo: number, hi: number, target = 5): number[] {
  const span = hi - lo;
  const raw = span / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}

export function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(480);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setW(Math.max(260, Math.round(el.getBoundingClientRect().width)));
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

export function Tooltip({ x, y, width, children }: { x: number; y: number; width: number; children: ReactNode }) {
  const left = Math.min(Math.max(8, x - 90), Math.max(8, width - 190));
  return <div className="pv-tip" style={{ left, top: Math.max(0, y - 112) }} role="status">{children}</div>;
}

function Detail({ p, label }: { p: P; label: string }) {
  return (
    <>
      <b>{p.provider}</b>
      <div className="pv-tip-row"><span>{label}</span><span>{q2(p.quality)} ({q2(p.ci95[0])}–{q2(p.ci95[1])})</span></div>
      <div className="pv-tip-row"><span>Price</span><span>{money(p.price_cents_per_call)}/call</span></div>
      <div className="pv-tip-row"><span>Latency p95</span><span>{ms(p.p95_ms)}</span></div>
      <div className="pv-tip-row"><span>n</span><span>{p.n}</span></div>
      <div style={{ marginTop: 6 }}>{p.on_frontier ? "On the Pareto frontier" : `Dominated by ${p.dominated_by}${p.confidently_dominated ? "" : " (within noise)"}`}</div>
    </>
  );
}

/** Quality against price. Up and to the left is better; the staircase is the efficient frontier. */
export function ParetoScatter({ providers, metric, height, colors }: { providers: P[]; metric: string; height: number; colors: Record<string, string> }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<string | null>(null);
  const m = { top: 22, right: 20, bottom: 40, left: 46 };
  const w = width - m.left - m.right;
  const h = height - m.top - m.bottom;

  const maxPrice = Math.max(...providers.map((p) => p.price_cents_per_call));
  const xMax = maxPrice * 1.2; // headroom: the priciest point never sits on the edge
  const xTicks = niceTicks(0, xMax, 5);
  const lo = Math.min(...providers.map((p) => p.ci95[0]));
  const hi = Math.max(...providers.map((p) => p.ci95[1]));
  const yMin = Math.max(0, Math.floor((lo - 0.02) * 20) / 20);
  const yMax = Math.min(1, Math.max(Math.ceil(hi * 20) / 20, hi + 0.02));
  const yTicks = niceTicks(yMin, yMax, 4);
  const x = (c: number) => (c / xMax) * w;
  const y = (q: number) => h - ((q - yMin) / (yMax - yMin)) * h;

  const frontier = providers.filter((p) => p.on_frontier).sort((a, b) => a.price_cents_per_call - b.price_cents_per_call);
  const stair = frontier.length
    ? `M${x(frontier[0].price_cents_per_call)},${y(frontier[0].quality)}` +
      frontier.slice(1).map((p) => `H${x(p.price_cents_per_call)}V${y(p.quality)}`).join("") +
      `H${w}`
    : "";
  const labelled = providers.slice(0, 8); // every point is named when there are few; the tooltip carries the numbers
  const hovered = providers.find((p) => p.listing_id === hover);

  return (
    <div className="pv-plot" ref={ref}>
      <svg width={width} height={height} role="img" aria-label={`${metric} against price per call for ${providers.length} providers. ${frontier.length} are on the Pareto frontier.`}>
        <g transform={`translate(${m.left},${m.top})`}>
          {yTicks.map((t) => (
            <g key={t}>
              <line x1={0} x2={w} y1={y(t)} y2={y(t)} stroke="var(--pv-line)" strokeWidth={1} />
              <text x={-10} y={y(t)} textAnchor="end" dominantBaseline="middle">{q2(t)}</text>
            </g>
          ))}
          {xTicks.map((t) => (
            <text key={t} x={x(t)} y={h + 18} textAnchor="middle">{money(t)}</text>
          ))}
          <line x1={0} x2={w} y1={h} y2={h} stroke="var(--pv-line-2)" strokeWidth={1} />
          <text className="pv-axis-title" x={0} y={-10}>{metric} · 95% interval</text>
          <text className="pv-axis-title" x={w} y={h + 34} textAnchor="end">price per call</text>

          {stair && <path d={stair} fill="none" stroke="var(--pv-text-2)" strokeOpacity={0.6} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />}

          {providers.map((p) => {
            const px = x(p.price_cents_per_call);
            const col = colors[p.listing_id];
            const on = hover === p.listing_id;
            return (
              <g key={p.listing_id}>
                <line x1={px} x2={px} y1={y(p.ci95[0])} y2={y(p.ci95[1])} stroke={col} strokeWidth={2} strokeLinecap="round" opacity={0.85} />
                <line x1={px - 4} x2={px + 4} y1={y(p.ci95[0])} y2={y(p.ci95[0])} stroke={col} strokeWidth={2} strokeLinecap="round" opacity={0.85} />
                <line x1={px - 4} x2={px + 4} y1={y(p.ci95[1])} y2={y(p.ci95[1])} stroke={col} strokeWidth={2} strokeLinecap="round" opacity={0.85} />
                <circle cx={px} cy={y(p.quality)} r={on ? 8 : 6} fill={p.on_frontier ? col : "var(--pv-ring)"} stroke={p.on_frontier ? "var(--pv-ring)" : col} strokeWidth={2} />
                {labelled.includes(p) && (
                  <text className="pv-label-direct" x={px > w - 90 ? px - 12 : px + 12} y={y(p.quality) + 4} textAnchor={px > w - 90 ? "end" : "start"}>{p.provider}</text>
                )}
                <circle
                  className="pv-hit" cx={px} cy={y(p.quality)} r={16} tabIndex={0}
                  aria-label={`${p.provider}: quality ${q2(p.quality)}, ${money(p.price_cents_per_call)} per call, ${p.on_frontier ? "on the frontier" : "dominated"}`}
                  onMouseEnter={() => setHover(p.listing_id)} onMouseLeave={() => setHover(null)}
                  onFocus={() => setHover(p.listing_id)} onBlur={() => setHover(null)}
                />
              </g>
            );
          })}
        </g>
      </svg>
      {hovered && <Tooltip x={m.left + x(hovered.price_cents_per_call)} y={m.top + y(hovered.quality)} width={width}><Detail p={hovered} label={metric} /></Tooltip>}
    </div>
  );
}

const METRICS: Record<Exclude<Metric, "frontier">, { label: string; better: "high" | "low"; value: (p: P) => number; fmt: (v: number) => string }> = {
  quality: { label: "Quality", better: "high", value: (p) => p.quality, fmt: q2 },
  price: { label: "Price per call", better: "low", value: (p) => p.price_cents_per_call, fmt: (v) => money(v) },
  speed: { label: "Latency p95", better: "low", value: (p) => p.p95_ms, fmt: ms },
  value: { label: "Quality per dollar", better: "high", value: valuePerDollar, fmt: (v) => v.toFixed(1) },
};
export const metricTitle = (m: Exclude<Metric, "frontier">) => METRICS[m].label;
export const metricNote = (m: Exclude<Metric, "frontier">) =>
  m === "quality" ? "Bars start at zero; whiskers are the 95% interval on the hidden test set." :
  m === "price" ? "Lower is better." :
  m === "speed" ? "Lower is better. Bars are p95; the tick is the median." :
  "Quality divided by price in dollars: how much quality each dollar buys.";

/** Horizontal bars, one per provider, from a zero baseline. Sorted best first; the best is starred. */
export function BarCompare({ providers, metric, colors }: { providers: P[]; metric: Exclude<Metric, "frontier">; colors: Record<string, string> }) {
  const spec = METRICS[metric];
  const rows = [...providers].sort((a, b) => (spec.better === "high" ? spec.value(b) - spec.value(a) : spec.value(a) - spec.value(b)));
  const max = metric === "quality" ? 1 : Math.max(...providers.map((p) => (metric === "speed" ? p.p95_ms : spec.value(p)))) * 1.05;
  const pct = (v: number) => `${Math.min(100, (v / max) * 100)}%`;
  return (
    <div className="pv-bars" role="list" aria-label={spec.label}>
      {rows.map((p, i) => (
        <div className="pv-bar-row" role="listitem" key={p.listing_id} data-best={i === 0} style={{ ["--sw" as string]: colors[p.listing_id] }}>
          <span className="pv-bar-name"><span className="pv-sw" /><span>{p.provider}</span></span>
          <div className="pv-hbar" title={`${p.provider}: ${spec.fmt(spec.value(p))}`}>
            <div className="pv-hbar-fill" style={{ width: pct(spec.value(p)) }} />
            {metric === "quality" && <div className="pv-hbar-ci" style={{ left: pct(p.ci95[0]), width: `calc(${pct(p.ci95[1])} - ${pct(p.ci95[0])})` }} />}
            {metric === "speed" && <div className="pv-hbar-tick" style={{ left: pct(p.p50_ms) }} />}
          </div>
          <span className="pv-bar-val">{spec.fmt(spec.value(p))}</span>
        </div>
      ))}
    </div>
  );
}
