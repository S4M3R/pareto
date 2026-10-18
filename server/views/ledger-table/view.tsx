import type { LedgerData } from "../../lib/schemas.js";
import { Card, Money, Shell, SkeletonCard, Stat, ago } from "../_ui/kit.js";

const sentence = (k: string) => { const s = k.replace(/_/g, " "); return s.charAt(0).toUpperCase() + s.slice(1); };
const label = (k: string) => k.replace(/^escrow:.*/, "escrow").replace(/_/g, " ");

export default function LedgerTable() {
  return (
    <Shell<LedgerData> skeleton={<SkeletonCard lines={5} />}>
      {(d) => {
        const balances = Object.entries(d.balances_cents);
        return (
          <Card title="Ledger" subtitle="Every movement, with the reason for it" seed="ledger" palette="sand" icon="receipt">
            {balances.length > 0 && (
              <div className="pv-stats" style={{ marginBottom: 14 }}>
                {balances.map(([k, v]) => (
                  <Stat key={k} label={label(k)}><Money cents={v} /></Stat>
                ))}
              </div>
            )}
            {d.entries.length === 0 ? (
              <div className="pv-callout">No movements yet.</div>
            ) : (
              <div className="pv-list">
                {d.entries.slice(0, 8).map((e, i) => (
                  <div className="pv-li" key={i} style={{ gridTemplateColumns: "auto 1fr auto" }}>
                    <span className="pv-dot" data-tone={e.cents >= 0 ? "mint" : "terra"} />
                    <span style={{ minWidth: 0 }}>
                      <span>{sentence(e.kind)}</span>
                      <span className="pv-faint" style={{ fontSize: 12 }}> · {e.account ?? "account"}</span>
                    </span>
                    <Money cents={e.cents} sign tone={e.cents >= 0 ? "plus" : "minus"} />
                    <span className="pv-meta">{e.reason ? `${e.reason} · ` : ""}{ago(e.at)}</span>
                  </div>
                ))}
              </div>
            )}
            {d.entries.length > 8 && <p className="pv-more">{d.entries.length - 8} older movements not shown.</p>}
          </Card>
        );
      }}
    </Shell>
  );
}
