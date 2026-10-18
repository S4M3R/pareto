import type { FileDisputeData, GetDisputeData } from "../../lib/schemas.js";
import { DisputePanel, VerdictBody, outcomeLabel, outcomeTone, type Verdict } from "../_ui/dispute.js";
import { Card, Money, Shell, SkeletonCard, StatusPill, shortId } from "../_ui/kit.js";

/** A micro dispute resolves in the same call, so the verdict is shown at once. A full dispute opens a case that
 * waits for the provider; that one hands over to the live panel. */
export default function DisputeVerdict() {
  return (
    <Shell<FileDisputeData> skeleton={<SkeletonCard lines={4} />}>
      {(d, input) => {
        if (d.outcome === undefined) {
          const opened: GetDisputeData = {
            dispute_id: d.dispute_id, scope: "full", status: d.status ?? "awaiting_response",
            claim_type: String(input.claim_type ?? "quality"),
            claim: { note: typeof input.note === "string" && input.note ? input.note : undefined, response_deadline: d.response_deadline },
            response: null, verdict: null, opened_at: new Date().toISOString(), resolved_at: null,
          };
          return <DisputePanel initial={opened} />;
        }
        const refunded = d.settlement?.refunded_cents ?? 0;
        const verdict: Verdict = { scope: "micro", outcome: d.outcome, reasoning: d.reasoning, evidence: d.evidence, rules_applied: d.rules_applied };
        return (
          <Card
            title={d.outcome === "upheld" ? "Upheld" : outcomeLabel(d.outcome)}
            subtitle={`micro dispute · ${shortId(d.dispute_id)} · resolved in seconds`}
            seed={d.dispute_id}
            palette={d.outcome === "upheld" ? "mint" : "sand"}
            icon="gavel"
            tone={outcomeTone(d.outcome)}
            right={<StatusPill status={d.outcome} />}
          >
            {d.outcome === "upheld" && (
              <div className="pv-balance" style={{ borderBottom: 0, paddingBottom: 0 }}>
                <div>
                  <div className="pv-label">Refunded to wallet</div>
                  <Money cents={refunded} big />
                </div>
              </div>
            )}
            <VerdictBody verdict={verdict} />
          </Card>
        );
      }}
    </Shell>
  );
}
