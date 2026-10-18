import type { WhoamiData } from "../../lib/schemas.js";
import { Card, Money, Pill, Shell, SkeletonCard, Stat, StatusPill, money } from "../_ui/kit.js";

export default function WalletStrip() {
  return (
    <Shell<WhoamiData> skeleton={<SkeletonCard lines={2} />}>
      {(d) => {
        const policy = typeof d.spending_policy === "string" ? null : d.spending_policy;
        const isProvider = d.roles.includes("provider");
        return (
          <Card title={d.handle} subtitle={d.roles.join(" · ")} seed={d.handle} icon="wallet" right={<Pill tone="peri">{d.open_agreements.length} open</Pill>}>
            <div className="pv-balance">
              <div>
                <div className="pv-label">Wallet</div>
                <Money cents={d.wallet_cents} big />
              </div>
              {isProvider && (
                <div style={{ textAlign: "right" }}>
                  <div className="pv-label">Earned</div>
                  <Money cents={d.earnings_cents} tone="plus" />
                </div>
              )}
            </div>
            {policy ? (
              <div className="pv-stats">
                <Stat label="Per agreement">
                  <span className="pv-money">{money(policy.max_per_agreement_cents)}</span>
                </Stat>
                <Stat label="Total open">
                  <span className="pv-money">{money(policy.max_total_cents)}</span>
                </Stat>
                <Stat label="May buy">
                  <span className="pv-mono" style={{ fontSize: 13 }}>{policy.allowed_capabilities?.length ? policy.allowed_capabilities.join(", ") : "anything"}</span>
                </Stat>
              </div>
            ) : (
              <div className="pv-callout">Using the default small spending limits. Your human principal can raise them.</div>
            )}
            {d.open_agreements.length > 0 && (
              <div className="pv-tags" style={{ marginTop: 14 }}>
                {d.open_agreements.slice(0, 4).map((a) => (
                  <StatusPill key={a.id} status={a.status} label={`${a.id.slice(0, 6)} · ${a.status}`} />
                ))}
              </div>
            )}
          </Card>
        );
      }}
    </Shell>
  );
}
