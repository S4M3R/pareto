import type { EarningsData } from "../../lib/schemas.js";
import { usePolledTool } from "../_ui/hooks.js";
import { Card, Money, Pill, Shell, SkeletonCard, Stat, money } from "../_ui/kit.js";

const ago = (iso: string) => {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  return s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
};

function Earnings({ initial }: { initial: EarningsData }) {
  // hires settle (and pay the referral) while the card is open, so keep it live
  const live = usePolledTool<EarningsData>("get_earnings", {}, true, 6000);
  const d = live ?? initial;
  const hires = d.benchmarks.reduce((n, b) => n + b.hires, 0);
  const agents = d.benchmarks.reduce((n, b) => n + b.agents, 0);
  const spend = d.benchmarks.reduce((n, b) => n + b.spend_cents, 0);
  const recent = d.benchmarks
    .flatMap((b) => b.recent.map((r) => ({ ...r, bench: b.slug })))
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
    .slice(0, 5);
  return (
    <Card
      title="Referral earnings"
      subtitle={`${d.owner} · ${d.referral_pct}% of what agents spend through your benchmarks`}
      seed={d.owner}
      palette="mint"
      icon="coins"
      right={<Pill tone="mint">live</Pill>}
    >
      <div className="pv-balance" style={{ borderBottom: 0, paddingBottom: 0, marginBottom: 12 }}>
        <div>
          <div className="pv-label">Earned</div>
          <Money cents={d.earned_total_cents} big tone="plus" />
        </div>
      </div>
      <div className="pv-stats" style={{ marginTop: 4, gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}>
        <Stat label="Hires"><span className="pv-money">{hires}</span></Stat>
        <Stat label="Agents"><span className="pv-money">{agents}</span></Stat>
        <Stat label="They spent"><span className="pv-money">{money(spend)}</span></Stat>
      </div>
      {d.benchmarks.length === 0 ? (
        <div className="pv-callout" style={{ marginTop: 14 }}>You have not published a benchmark yet. Agents that choose a provider with one of yours will show up here.</div>
      ) : (
        <>
          <div className="pv-label" style={{ margin: "16px 0 6px" }}>By benchmark</div>
          {d.benchmarks.map((b) => (
            <div key={b.benchmark_id} style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, padding: "7px 0", borderTop: "1px solid var(--pv-line, rgba(255,255,255,0.1))" }}>
              <span style={{ minWidth: 0 }}>
                <b style={{ fontWeight: 600 }}>{b.title}</b>
                <div className="pv-mono" style={{ opacity: 0.6, fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b.slug} · {b.hires} hire{b.hires === 1 ? "" : "s"}</div>
              </span>
              <span style={{ flex: "none" }}><Money cents={b.earned_cents} tone={b.earned_cents ? "plus" : undefined} /></span>
            </div>
          ))}
          {recent.length > 0 && (
            <>
              <div className="pv-label" style={{ margin: "16px 0 6px" }}>Recent hires</div>
              {recent.map((r, i) => (
                <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "5px 0", fontSize: 13 }}>
                  <span style={{ opacity: 0.85, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.agent} hired a provider · {ago(r.at)}</span>
                  <span className="pv-money" style={{ flex: "none" }}>{r.referral_cents ? `+${money(r.referral_cents)}` : money(r.spend_cents)}</span>
                </div>
              ))}
            </>
          )}
        </>
      )}
    </Card>
  );
}

export default function EarningsCard() {
  return (
    <Shell<EarningsData> skeleton={<SkeletonCard lines={4} />}>
      {(d) => <Earnings initial={d} />}
    </Shell>
  );
}
