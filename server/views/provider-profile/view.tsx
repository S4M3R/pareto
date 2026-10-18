import type { GetProviderData } from "../../lib/schemas.js";
import { Card, Money, Pill, Row, Rows, Shell, SkeletonCard, Stat, Tags, ms, q2, shortId } from "../_ui/kit.js";

const CRITERIA = ["accuracy", "sla", "clarity", "cost_fairness"] as const;

export default function ProviderProfile() {
  return (
    <Shell<GetProviderData> skeleton={<SkeletonCard lines={5} />}>
      {(d) => {
        const rep = d.reputation;
        const reviews = d.recent_reviews;
        const avg = (k: (typeof CRITERIA)[number]) => (reviews.length ? reviews.reduce((s, r) => s + r.ratings[k], 0) / reviews.length : null);
        return (
          <Card title={d.listing.title} subtitle={`${d.provider ?? "provider"} · ${d.listing.kind} · ${d.listing.capability}`} seed={d.provider ?? d.listing.id} right={<Pill>{<Money cents={d.listing.pricing.amount_cents} />}/call</Pill>}>
            <div className="pv-stats" style={{ marginBottom: 16 }}>
              <Stat label="Settled deals"><span className="pv-money">{rep.settled_agreements ?? 0}</span></Stat>
              <Stat label="Disputes upheld"><span className="pv-money">{rep.disputes_upheld_against ?? 0} / {rep.disputes_against ?? 0}</span></Stat>
              <Stat label="Reviews"><span className="pv-money">{rep.avg_accuracy != null ? `${Number(rep.avg_accuracy).toFixed(1)} ★` : "none"}</span></Stat>
            </div>

            {d.results.length > 0 && (
              <>
                <div className="pv-label" style={{ marginBottom: 6 }}>Benchmark results</div>
                <Rows>
                  {d.results.map((r) => (
                    <Row key={r.benchmark_id + r.n} label={`benchmark ${shortId(r.benchmark_id)} · n=${r.n}`}>
                      {q2(r.quality)} <span className="pv-faint">({q2(r.ci_low)}–{q2(r.ci_high)}) · p95 {ms(r.p95_ms)}</span>
                    </Row>
                  ))}
                </Rows>
                <hr className="pv-divider" />
              </>
            )}

            {reviews.length > 0 ? (
              <>
                <div className="pv-label" style={{ marginBottom: 6 }}>What buyers said</div>
                <div className="pv-tags" style={{ marginBottom: 10 }}>
                  {CRITERIA.map((k) => (
                    <Pill key={k}>{k.replace("_", " ")} {avg(k)?.toFixed(1)}</Pill>
                  ))}
                </div>
                {reviews.slice(0, 2).filter((r) => r.comment).map((r, i) => (
                  <blockquote className="pv-quote" key={i} style={{ marginTop: i ? 8 : 0 }}>{r.comment}</blockquote>
                ))}
              </>
            ) : (
              <div className="pv-callout">No reviews yet. Reviews are only possible after a settled agreement.</div>
            )}
            <div style={{ marginTop: 14 }}>
              <Tags seeded={d.listing.seeded} />
            </div>
          </Card>
        );
      }}
    </Shell>
  );
}
