import type { ListRequestsData, ReviewProposalData } from "../../lib/schemas.js";
import { TermsRows } from "../_ui/agreement.js";
import { useToolCaller } from "../_ui/hooks.js";
import { Card, ErrorCard, Pill, Shell, SkeletonCard, StatusPill, shortId } from "../_ui/kit.js";
import { useState } from "react";

type Req = ListRequestsData["requests"][number];

function Request({ r }: { r: Req }) {
  const review = useToolCaller<ReviewProposalData>("review_proposal");
  const [decided, setDecided] = useState<string>();
  const [err, setErr] = useState<Error>();
  const decide = async (decision: "approve" | "reject") => {
    setErr(undefined);
    try {
      const out = await review.call({ agreement_id: r.agreement_id, decision });
      setDecided(out.status);
    } catch (e) {
      setErr(e as Error);
    }
  };
  return (
    <Card
      title={r.buyer ?? "buyer"}
      subtitle={`${r.listing ?? "listing"} · ${shortId(r.agreement_id)} · ${r.buyer_settled_agreements} settled deals`}
      seed={r.buyer ?? r.agreement_id}
      right={decided ? <StatusPill status={decided} /> : <StatusPill status={r.status} />}
    >
      <TermsRows terms={r.terms} />
      {err && <div style={{ marginTop: 12 }}><ErrorCard error={err} title="Could not decide" /></div>}
      {!decided && r.status === "proposed" && (
        <div className="pv-actions">
          <button className="pv-btn" disabled={review.isPending} onClick={() => void decide("approve")}>{review.isPending ? "Working…" : "Approve"}</button>
          <button className="pv-btn ghost" disabled={review.isPending} onClick={() => void decide("reject")}>Reject</button>
        </div>
      )}
      {r.status === "countered" && !decided && <div style={{ marginTop: 12 }}><Pill tone="amber">waiting for the buyer to answer your counter</Pill></div>}
    </Card>
  );
}

export default function ProposalInbox() {
  return (
    <Shell<ListRequestsData> skeleton={<SkeletonCard lines={4} />}>
      {(d) =>
        d.requests.length === 0 ? (
          <Card title="Inbox is clear" subtitle="No proposals waiting for you" seed="inbox" palette="sand" icon="inbox">
            <div className="pv-callout">New proposals from buyers appear here.</div>
          </Card>
        ) : (
          <div style={{ display: "grid", gap: 12 }}>
            {d.requests.map((r) => <Request key={r.agreement_id} r={r} />)}
          </div>
        )
      }
    </Shell>
  );
}
