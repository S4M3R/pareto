import type { SearchBenchmarksData } from "../../lib/schemas.js";
import { Card, CiBar, GrainCircle, Icon, Money, Pill, Shell, SkeletonCard, Tags, pct, q2, useFollowUp } from "../_ui/kit.js";

type Match = SearchBenchmarksData["matches"][number];

function Leaderboard({ rows }: { rows: NonNullable<Match["leaderboard"]> }) {
  return (
    <div className="pv-list" role="list" aria-label="Verified leaderboard">
      {rows.map((r, i) => (
        <div className="pv-li" role="listitem" key={r.provider}>
          <GrainCircle seed={r.provider} size={28} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 500 }}>{r.provider}</div>
            <div className="pv-faint" style={{ fontSize: 12 }}>
              #{i + 1} · 95% interval {q2(r.ci95[0])}–{q2(r.ci95[1])} · n={r.n}
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div className="pv-money" style={{ fontSize: 17 }}>{q2(r.quality)}</div>
            <div className="pv-faint pv-mono" style={{ fontSize: 11 }}>
              <Money cents={r.price_cents_per_call} />/call
            </div>
          </div>
          <div style={{ gridColumn: "2 / 4" }}>
            <CiBar q={r.quality} lo={r.ci95[0]} hi={r.ci95[1]} />
          </div>
        </div>
      ))}
    </div>
  );
}

export default function BenchmarkCard() {
  const follow = useFollowUp();
  return (
    <Shell<SearchBenchmarksData> skeleton={<SkeletonCard lines={4} />}>
      {(d) => {
        const [top, ...rest] = d.matches;
        if (!top) {
          return (
            <Card title="No benchmark matches" subtitle="Nothing public fits this task well" seed="no-match" palette="sand" icon="scale">
              <div className="pv-callout" data-tone="amber">{d.note ?? "Describe the task differently."}</div>
              {d.next && <p className="pv-more">{d.next}</p>}
            </Card>
          );
        }
        return (
          <>
            <Card
              title={top.title}
              subtitle={top.category ? `${top.category} · ${top.metric ?? "accuracy"}` : top.slug}
              seed={top.slug}
              icon="scale"
              right={<Pill tone="peri">match {pct(top.match_confidence)}</Pill>}
            >
              <p className="pv-muted" style={{ fontSize: 13, marginBottom: 14 }}>{top.why}</p>
              <div className="pv-tags" style={{ marginBottom: 14 }}>
                {top.n_test !== undefined && <Pill>{top.n_test} hidden tests</Pill>}
                {top.fingerprint && <Pill>fingerprint {top.fingerprint.slice(0, 8)}</Pill>}
                {top.version !== undefined && <Pill>v{top.version}</Pill>}
              </div>
              {top.leaderboard && top.leaderboard.length > 0 ? (
                <>
                  <div className="pv-label" style={{ marginBottom: 2 }}>Verified results on the hidden set</div>
                  <Leaderboard rows={top.leaderboard} />
                </>
              ) : (
                <div className="pv-callout">No provider has been scored on this benchmark yet.</div>
              )}
              <div style={{ marginTop: 12 }}>
                <Tags verified seeded={top.seeded} />
              </div>
              {follow.available && top.leaderboard && top.leaderboard.length > 0 && (
                <div className="pv-actions">
                  <button className="pv-btn" disabled={follow.sent} onClick={() => void follow.ask(`Find providers for the "${top.title}" benchmark (benchmark_id ${top.benchmark_id}) and compare them on quality, price and dispute record.`)}>
                    {follow.sent ? "Asked" : "Compare providers"}
                  </button>
                </div>
              )}
            </Card>
            {rest.length > 0 && (
              <p className="pv-more">
                <Icon name="scale" size={12} /> Also close: {rest.map((m) => `${m.title} (${pct(m.match_confidence)})`).join(", ")}
              </p>
            )}
          </>
        );
      }}
    </Shell>
  );
}
