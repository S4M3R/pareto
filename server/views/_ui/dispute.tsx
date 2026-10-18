import type { GetDisputeData } from "../../lib/schemas.js";
import { usePolledTool, useNow } from "./hooks.js";
import { Card, Money, Pill, Row, Rows, StatusPill, shortId, type Tone } from "./kit.js";

type Check = { type: string; ran: boolean; passed: boolean; detail: string };
type Evidence = {
  outcomes?: Check[];
  calls?: number; passes?: number; pass_rate?: number; failures_by_check?: Record<string, number>;
};
export type Verdict = NonNullable<GetDisputeData["verdict"]> & { settlement?: { refunded_cents?: number; paid_to_provider_cents?: number } };

const outcomeTone = (o?: string): Exclude<Tone, "peri" | "neutral"> => (o === "upheld" ? "mint" : "amber");
const outcomeLabel = (o?: string) => (o === "upheld" ? "Upheld" : o === "partially_upheld" ? "Partly upheld" : o === "rejected" ? "Rejected" : "Resolved");

/** What was decided, why, and on what evidence. Every verdict states the rule applied and the evidence used. */
export function VerdictBody({ verdict, refundedCents }: { verdict: Verdict; refundedCents?: number }) {
  const ev = (verdict.evidence ?? {}) as Evidence;
  const refunded = refundedCents ?? verdict.refunded_cents ?? verdict.settlement?.refunded_cents;
  return (
    <>
      <div className="pv-callout" data-tone={outcomeTone(verdict.outcome)} style={{ marginBottom: 14 }}>
        {verdict.reasoning}
      </div>
      {ev.outcomes && (
        <div className="pv-list" aria-label="Checks re-run on the recorded trace" style={{ marginBottom: 6 }}>
          {ev.outcomes.filter((c) => c.ran).map((c) => (
            <div className="pv-li" key={c.type} style={{ gridTemplateColumns: "auto 1fr" }}>
              <span className="pv-dot" data-tone={c.passed ? "mint" : "terra"} />
              <span>
                {c.type.replace(/_/g, " ")} <span className="pv-faint" style={{ fontSize: 12 }}>· {c.detail}</span>
              </span>
            </div>
          ))}
        </div>
      )}
      {ev.calls !== undefined && (
        <Rows>
          <Row label="Calls reviewed">{ev.calls}</Row>
          <Row label="Passed every check">{ev.passes} ({Math.round((ev.pass_rate ?? 0) * 100)}%)</Row>
          {ev.failures_by_check && Object.keys(ev.failures_by_check).length > 0 && (
            <Row label="Failures">{Object.entries(ev.failures_by_check).map(([k, v]) => `${k.replace(/_/g, " ")} ×${v}`).join(", ")}</Row>
          )}
        </Rows>
      )}
      {(refunded !== undefined || verdict.paid_to_provider_cents !== undefined) && (
        <>
          <hr className="pv-divider" />
          <Rows>
            {refunded !== undefined && <Row label="Refunded to buyer"><Money cents={refunded} /></Row>}
            {verdict.paid_to_provider_cents !== undefined && <Row label="Paid to provider"><Money cents={verdict.paid_to_provider_cents} /></Row>}
            {verdict.returned_unspent_cents !== undefined && <Row label="Unspent returned"><Money cents={verdict.returned_unspent_cents} /></Row>}
          </Rows>
        </>
      )}
      {verdict.rules_applied && verdict.rules_applied.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div className="pv-label" style={{ marginBottom: 4 }}>Rules applied</div>
          {verdict.rules_applied.map((r) => <div className="pv-code pv-faint" key={r} style={{ padding: "2px 0" }}>{r}</div>)}
        </div>
      )}
      {verdict.appeal && <p className="pv-faint" style={{ fontSize: 11.5, marginTop: 12 }}>{verdict.appeal}</p>}
    </>
  );
}

export { outcomeLabel, outcomeTone };

/** A dispute in any state. While it waits on the provider or the arbiter it polls get_dispute and switches to the verdict. */
export function DisputePanel({ initial }: { initial: GetDisputeData }) {
  const open = initial.status !== "resolved";
  const live = usePolledTool<GetDisputeData>("get_dispute", { dispute_id: initial.dispute_id }, open, 2000);
  const d = live ?? initial;
  const waiting = d.status === "awaiting_response";
  const deadline = d.claim?.response_deadline ? new Date(d.claim.response_deadline).getTime() : undefined;
  const now = useNow(waiting && deadline !== undefined);
  const left = deadline ? Math.max(0, Math.ceil((deadline - now) / 1000)) : undefined;
  const tone = d.verdict ? outcomeTone(d.verdict.outcome) : "amber";
  return (
    <Card
      title={d.verdict ? outcomeLabel(d.verdict.outcome) : d.scope === "full" ? "Full dispute open" : "Dispute open"}
      subtitle={`${d.scope} dispute · ${d.claim_type.replace(/_/g, " ")} · ${shortId(d.dispute_id)}`}
      seed={d.dispute_id}
      palette={d.verdict ? (tone === "mint" ? "mint" : tone === "amber" ? "sand" : "terra") : "sand"}
      icon="gavel"
      tone={tone}
      right={<StatusPill status={d.verdict ? (d.verdict.outcome ?? d.status) : d.status} />}
    >
      {d.claim?.note && <blockquote className="pv-quote" style={{ marginBottom: 14 }}>{d.claim.note}</blockquote>}
      {waiting && (
        <div className="pv-callout" data-tone="amber" style={{ marginBottom: 14 }}>
          Remaining escrow is <b>frozen</b> and access is revoked. The provider has {left !== undefined ? <b>{left}s</b> : "a short window"} to respond, then an arbiter decides on the recorded evidence.
        </div>
      )}
      {d.response?.statement && (
        <>
          <div className="pv-label" style={{ marginBottom: 6 }}>Provider's response</div>
          <blockquote className="pv-quote" style={{ marginBottom: 14 }}>{d.response.statement}</blockquote>
        </>
      )}
      {d.status === "under_review" && <div className="pv-callout" style={{ marginBottom: 14 }}>The arbiter is reviewing the evidence package.</div>}
      {d.verdict && <VerdictBody verdict={d.verdict} />}
      {!d.verdict && open && <Pill tone="amber">live · checking for a verdict</Pill>}
    </Card>
  );
}

