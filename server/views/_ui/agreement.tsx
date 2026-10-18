import type { AgreementData, SpendData, TermsData } from "../../lib/schemas.js";
import { usePolledTool } from "./hooks.js";
import { Bar, Card, Money, Pill, Row, Rows, StatusPill, Stepper, ago, ms, shortId, type Tone } from "./kit.js";
import type { ReactNode } from "react";

const STEPS = ["Proposed", "Approved", "Active", "Settled"];
const stepOf = (status: string) =>
  status === "proposed" || status === "countered" ? 0 : status === "approved" ? 1 : status === "settled" ? 3 : status === "active" || status === "disputed" || status === "closing" ? 2 : -1;
const toneOf = (status: string): Exclude<Tone, "peri" | "neutral"> | undefined =>
  status === "settled" ? "mint" : status === "disputed" || status === "rejected" ? "terra" : status === "proposed" || status === "countered" ? "amber" : undefined;

export function TermsRows({ terms }: { terms: TermsData }) {
  return (
    <Rows>
      <Row label="Price per call"><Money cents={terms.price.amount_cents} /></Row>
      <Row label="Budget cap"><Money cents={terms.budget_cap_cents} /></Row>
      {terms.holdback_pct !== undefined && <Row label="Holdback until close">{terms.holdback_pct}%</Row>}
      {terms.check_window_s !== undefined && <Row label="Dispute window per call">{terms.check_window_s}s</Row>}
      {terms.sla?.max_latency_ms !== undefined && <Row label="Latency SLA">{ms(terms.sla.max_latency_ms)}</Row>}
    </Rows>
  );
}

export function SpendBar({ spend }: { spend: NonNullable<AgreementData["spend"]> | SpendData }) {
  return (
    <Bar
      total={spend.budget_cap_cents}
      segments={[
        { cents: spend.released_cents, tone: "mint", label: "Paid" },
        { cents: spend.holdback_cents, tone: "peri", label: "Holdback" },
        { cents: spend.pending_cents, tone: "amber", label: "Pending" },
        { cents: spend.refunded_cents, tone: "terra", label: "Refunded" },
      ]}
    />
  );
}

type Shown = Pick<AgreementData, "agreement_id" | "status" | "terms" | "next"> & Partial<Pick<AgreementData, "listing_title" | "buyer" | "provider" | "spend" | "recent_events" | "role">>;

/** One agreement, any stage. While it is waiting on someone (proposed, countered, approved) it polls
 * get_agreement, so the card flips to "approved" when the provider decides, without anyone asking. */
export function AgreementView({ initial, extra }: { initial: Shown; extra?: ReactNode }) {
  const waiting = ["proposed", "countered", "approved"].includes(initial.status);
  const live = usePolledTool<AgreementData>("get_agreement", { agreement_id: initial.agreement_id }, waiting, 2500);
  const d: Shown = live ?? initial;
  const idx = stepOf(d.status);
  const events = d.recent_events ?? [];
  return (
    <Card
      title={d.listing_title ?? "Service agreement"}
      subtitle={`${d.buyer ?? "buyer"} → ${d.provider ?? "provider"} · ${shortId(d.agreement_id)}`}
      seed={d.provider ?? d.agreement_id}
      tone={toneOf(d.status)}
      right={<StatusPill status={d.status} />}
    >
      {idx >= 0 ? <Stepper steps={STEPS} current={idx} /> : null}
      {d.status === "countered" && <div className="pv-callout" data-tone="amber" style={{ marginBottom: 14 }}>The provider changed the terms. The buyer needs to accept or decline.</div>}
      {d.status === "rejected" && <div className="pv-callout" data-tone="terra" style={{ marginBottom: 14 }}>This proposal was rejected. Propose different terms or pick another provider.</div>}
      <TermsRows terms={d.terms} />
      {d.spend && (
        <>
          <hr className="pv-divider" />
          <div className="pv-label" style={{ marginBottom: 8 }}>Escrow of <Money cents={d.spend.budget_cap_cents} /> · {d.spend.calls} calls</div>
          <SpendBar spend={d.spend} />
        </>
      )}
      {extra}
      {events.length > 0 && (
        <>
          <hr className="pv-divider" />
          <div className="pv-list" aria-label="History">
            {events.slice(0, 3).map((e, i) => (
              <div className="pv-li" key={i} style={{ gridTemplateColumns: "1fr auto" }}>
                <span>{e.kind.charAt(0).toUpperCase() + e.kind.replace(/_/g, " ").slice(1)}</span>
                <span className="pv-faint pv-mono" style={{ fontSize: 11.5 }}>{ago(e.created_at)}</span>
              </div>
            ))}
          </div>
        </>
      )}
      {waiting && (
        <div style={{ marginTop: 14 }}>
          <Pill tone="amber">live · waiting for the {d.status === "approved" ? "buyer to fund escrow" : d.status === "countered" ? "buyer to respond" : "provider to decide"}</Pill>
        </div>
      )}
    </Card>
  );
}
