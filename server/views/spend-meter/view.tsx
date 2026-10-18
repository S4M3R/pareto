import type { SpendData } from "../../lib/schemas.js";
import { SpendBar } from "../_ui/agreement.js";
import { usePolledTool } from "../_ui/hooks.js";
import { Card, Money, Pill, Shell, SkeletonCard, Stat } from "../_ui/kit.js";

function Meter({ initial, agreementId }: { initial: SpendData; agreementId?: string }) {
  // pending charges settle as their check windows close, so keep the meter live until none are left
  const live = usePolledTool<SpendData>("get_spend", { agreement_id: agreementId }, Boolean(agreementId) && initial.pending_cents > 0, 2500);
  const d = live ?? initial;
  const net = d.charged_cents - d.refunded_cents;
  const remaining = d.remaining_budget_cents ?? d.budget_cap_cents - net;
  return (
    <Card
      title="Spend"
      subtitle={`${d.calls} call${d.calls === 1 ? "" : "s"}`}
      seed={agreementId ?? "spend"}
      palette="mint"
      icon="coins"
      right={d.pending_cents > 0 ? <Pill tone="amber">live · settling</Pill> : <Pill tone="mint">settled</Pill>}
    >
      <div className="pv-balance" style={{ borderBottom: 0, paddingBottom: 0, marginBottom: 12 }}>
        <div>
          <div className="pv-label">Spent</div>
          <Money cents={net} big />
        </div>
        <div style={{ textAlign: "right" }}>
          <div className="pv-label">of cap</div>
          <Money cents={d.budget_cap_cents} />
        </div>
      </div>
      <SpendBar spend={d} />
      <div className="pv-stats" style={{ marginTop: 16 }}>
        <Stat label="Remaining"><Money cents={remaining} /></Stat>
        <Stat label="In escrow"><Money cents={d.escrow_balance_cents} /></Stat>
      </div>
    </Card>
  );
}

export default function SpendMeter() {
  return (
    <Shell<SpendData> skeleton={<SkeletonCard lines={3} />}>
      {(d, input) => <Meter initial={d} agreementId={typeof input.agreement_id === "string" ? input.agreement_id : undefined} />}
    </Shell>
  );
}
