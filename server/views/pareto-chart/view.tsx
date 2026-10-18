import { useDisplayMode } from "mcp-use/react";
import { useState } from "react";
import type { CompareProvidersData } from "../../lib/schemas.js";
import { BarCompare, ParetoScatter, colorMap, metricNote, metricTitle, type Metric } from "../_ui/charts.js";
import { Card, Money, Shell, SkeletonCard, ms, q2, useFollowUp } from "../_ui/kit.js";

const TABS: { id: Metric; label: string }[] = [
  { id: "frontier", label: "Price vs quality" },
  { id: "quality", label: "Quality" },
  { id: "price", label: "Price" },
  { id: "speed", label: "Speed" },
  { id: "value", label: "Value" },
];

function Chart({ d }: { d: CompareProvidersData }) {
  const [metric, setMetric] = useState<Metric>("frontier");
  const [table, setTable] = useState(false);
  const { displayMode, availableDisplayModes, requestDisplayMode } = useDisplayMode();
  const follow = useFollowUp();
  const colors = colorMap(d.providers);
  const colored = d.providers.filter((p) => colors[p.listing_id] !== "var(--pv-s0)"); // three validated colors; the rest are grey
  const others = d.providers.length - colored.length;
  const full = displayMode === "fullscreen";
  const dominated = d.providers.filter((p) => !p.on_frontier);
  const pick = d.recommendation;
  const picked = pick ? d.providers.find((p) => p.listing_id === pick.listing_id) : undefined;
  const n = d.providers[0]?.n;

  return (
    <Card title={table ? "Comparison table" : metric === "frontier" ? "Quality vs price" : metricTitle(metric)} subtitle={`${d.benchmark.title} · ${d.benchmark.metric}${n ? ` · n=${n}` : ""}`} seed={d.benchmark.slug} icon="scale">
      <div className="pv-controls">
        <div className="pv-seg" role="tablist" aria-label="Comparison">
          {TABS.map((t) => (
            <button key={t.id} role="tab" aria-selected={!table && metric === t.id} onClick={() => { setMetric(t.id); setTable(false); }}>{t.label}</button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button className="pv-mini" aria-pressed={table} onClick={() => setTable((v) => !v)}>Table</button>
          {availableDisplayModes.includes("fullscreen") && (
            <button className="pv-mini" onClick={() => void requestDisplayMode({ mode: full ? "inline" : "fullscreen" })}>{full ? "Close" : "Expand"}</button>
          )}
        </div>
      </div>

      {table ? (
        <div className="pv-scroll-x">
          <table className="pv-table">
            <thead>
              <tr><th>Provider</th><th className="num">Quality</th><th className="num">Price</th><th className="num">p95</th><th>Frontier</th></tr>
            </thead>
            <tbody>
              {d.providers.map((p) => (
                <tr key={p.listing_id}>
                  <td>{p.provider}</td>
                  <td className="num">{q2(p.quality)} <span className="pv-faint">({q2(p.ci95[0])}–{q2(p.ci95[1])})</span></td>
                  <td className="num"><Money cents={p.price_cents_per_call} /></td>
                  <td className="num">{ms(p.p95_ms)}</td>
                  <td>{p.on_frontier ? "yes" : `no, ${p.dominated_by}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : metric === "frontier" ? (
        <>
          <ParetoScatter providers={d.providers} metric={d.benchmark.metric} height={full ? 420 : 280} colors={colors} />
          <div className="pv-key">
            {colored.map((p) => (
              <span key={p.listing_id} style={{ ["--sw" as string]: colors[p.listing_id] }}><i className={`pv-sw${p.on_frontier ? "" : " hollow"}`} />{p.provider}</span>
            ))}
            {others > 0 && <span><i className="pv-sw" />{others} other{others === 1 ? "" : "s"} (grey, named on the chart)</span>}
            <span><i className="pv-sw line" />Pareto frontier</span>
            {dominated.length > 0 && <span><i className="pv-sw hollow" />hollow = dominated</span>}
          </div>
        </>
      ) : (
        <>
          <BarCompare providers={d.providers} metric={metric} colors={colors} />
          <p className="pv-more">{metricNote(metric)}</p>
        </>
      )}

      {metric === "frontier" && !table && (
        <p className="pv-more">
          {dominated.length === 0
            ? "Every provider is on the frontier: each is better than the others on one side of the trade-off."
            : `${dominated.map((p) => p.provider).join(", ")} ${dominated.length === 1 ? "is" : "are"} dominated: another provider is at least as good and no more expensive.`}
        </p>
      )}

      {picked && pick && (
        <div className="pv-callout" data-tone="mint" style={{ marginTop: 14 }}>
          <b>{picked.provider}</b>. {pick.reason}
        </div>
      )}
      {picked && follow.available && (
        <div className="pv-actions">
          <button className="pv-btn" disabled={follow.sent} onClick={() => void follow.ask(`Hire ${picked.provider} (listing_id ${picked.listing_id}) for this task: create the task and propose an agreement.`)}>
            {follow.sent ? "Asked" : `Hire ${picked.provider}`}
          </button>
        </div>
      )}
    </Card>
  );
}

export default function ParetoChart() {
  return (
    <Shell<CompareProvidersData> skeleton={<SkeletonCard lines={5} />}>
      {(d) =>
        d.providers.length === 0 ? (
          <Card title="Nothing to compare" subtitle={d.benchmark.title} seed={d.benchmark.slug} palette="sand" icon="scale">
            <div className="pv-callout" data-tone="amber">{d.note ?? "No provider meets the constraints."}</div>
          </Card>
        ) : (
          <Chart d={d} />
        )
      }
    </Shell>
  );
}
