import type { CloseTaskData, ReviewData } from "../../lib/schemas.js";
import { usePlainState, useToolCaller } from "../_ui/hooks.js";
import { Bar, Card, ErrorCard, GrainCircle, Money, Row, Rows, Shell, SkeletonCard, Stat } from "../_ui/kit.js";
import { useState } from "react";

const CRITERIA = [
  ["accuracy", "Accuracy"],
  ["sla", "Speed and SLA"],
  ["clarity", "Clarity"],
  ["cost_fairness", "Cost fairness"],
] as const;
type Key = (typeof CRITERIA)[number][0];
type Ratings = Record<Key, number>;
type Saved = { open: boolean; ratings: Partial<Ratings>; done?: ReviewData };

function Review({ agreementId }: { agreementId: string }) {
  const [s, setS] = usePlainState<Saved>({ open: false, ratings: {} });
  const send = useToolCaller<ReviewData>("review_provider");
  const [err, setErr] = useState<Error>();
  const complete = CRITERIA.every(([k]) => s.ratings[k]);

  if (s.done) return <div className="pv-callout" data-tone="mint" style={{ marginTop: 16 }}>Review recorded. Weight {s.done.weight}, based on {(s.done.value_cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })} of settled value.</div>;
  if (!s.open) {
    return (
      <div className="pv-actions">
        <button className="pv-btn" onClick={() => setS({ ...s, open: true })}>Leave a review</button>
      </div>
    );
  }
  return (
    <div style={{ marginTop: 16 }}>
      <div className="pv-label" style={{ marginBottom: 6 }}>Rate the provider, 1 to 5</div>
      {CRITERIA.map(([k, name]) => (
        <div className="pv-rate" key={k} role="group" aria-label={name}>
          <span>{name}</span>
          <div className="pv-stars">
            {[1, 2, 3, 4, 5].map((n) => (
              <button key={n} className="pv-chip" aria-pressed={s.ratings[k] === n} aria-label={`${name} ${n}`} onClick={() => setS({ ...s, ratings: { ...s.ratings, [k]: n } })}>{n}</button>
            ))}
          </div>
        </div>
      ))}
      {err && <div style={{ marginTop: 10 }}><ErrorCard error={err} title="Review not saved" /></div>}
      <div className="pv-actions">
        <button
          className="pv-btn"
          disabled={!complete || send.isPending}
          onClick={async () => {
            setErr(undefined);
            try {
              const done = await send.call({ agreement_id: agreementId, ratings: s.ratings as Ratings, comment: "" });
              setS({ ...s, done });
            } catch (e) {
              setErr(e as Error);
            }
          }}
        >
          {send.isPending ? "Sending…" : "Send review"}
        </button>
      </div>
    </div>
  );
}

export default function Settlement() {
  return (
    <Shell<CloseTaskData> skeleton={<SkeletonCard lines={4} />}>
      {(d, input) => {
        const f = d.final;
        const paid = f.charged_cents - f.refunded_cents;
        return (
          <Card tone="mint">
            <div className="pv-hero">
              <span className="pv-glow">
                <GrainCircle seed={d.provider ?? "settled"} palette="mint" icon="check" size={56} />
              </span>
              <h2>Settled</h2>
              <p className="pv-muted" style={{ fontSize: 13 }}>{[d.listing_title, d.provider].filter(Boolean).join(" · ")}</p>
            </div>
            <div className="pv-balance" style={{ margin: "18px 0 14px", paddingBottom: 14 }}>
              <div>
                <div className="pv-label">Returned to your wallet</div>
                <Money cents={d.returned_unspent_cents} big />
              </div>
              {d.wallet_cents !== undefined && (
                <div style={{ textAlign: "right" }}>
                  <div className="pv-label">Wallet now</div>
                  <Money cents={d.wallet_cents} />
                </div>
              )}
            </div>
            <Bar
              total={f.budget_cap_cents}
              segments={[
                { cents: paid, tone: "mint", label: "Paid to provider" },
                { cents: f.refunded_cents, tone: "terra", label: "Refunded" },
                { cents: d.returned_unspent_cents, tone: "peri", label: "Unspent" },
              ]}
            />
            <div className="pv-stats" style={{ marginTop: 16 }}>
              <Stat label="Calls"><span className="pv-money">{f.calls}</span></Stat>
              <Stat label="Holdback released"><Money cents={d.holdback_released_cents} /></Stat>
            </div>
            <Review agreementId={String(input.agreement_id ?? "")} />
          </Card>
        );
      }}
    </Shell>
  );
}
