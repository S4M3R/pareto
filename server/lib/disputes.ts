import { db, must, rpc } from "./db.js";
import { MarketError } from "./errors.js";
import { type EvalSpec, type Trace, failed, runEvals } from "./evals.js";
import { percentile, round } from "./stats.js";

type CallRow = { id: string; seq: number; request: Trace["request"]; response: Trace["response"]; status_code: number; latency_ms: number; hash: string };

function traceOf(c: CallRow): Trace {
  return { request: c.request, response: c.response, status: c.status_code, latency_ms: c.latency_ms, units_measured: 1 };
}

// ───────── micro dispute: one charge, resolved automatically from its trace ─────────
export async function fileMicroDispute(buyerId: string, chargeId: string, claimType: string, note: string) {
  const charge = await must(db.from("charges").select("*, call:calls(*), agreement:agreements(*)").eq("id", chargeId).maybeSingle(), "charge");
  if ((charge.agreement as { buyer_id: string }).buyer_id !== buyerId) throw new MarketError("unauthorized", "Only the buyer can dispute this charge.", "Use the buyer's API key.");
  const disputeId = await rpc<string>("open_micro_dispute", { p_charge: chargeId, p_opened_by: buyerId, p_claim_type: claimType, p_claim: { note } });
  return resolveMicro(disputeId);
}

export async function resolveMicro(disputeId: string) {
  const d = await must(db.from("disputes").select("*").eq("id", disputeId).maybeSingle(), "dispute");
  const charge = await must(db.from("charges").select("*, call:calls(*), agreement:agreements(*)").eq("id", d.charge_id).maybeSingle(), "charge");
  const call = charge.call as CallRow;
  const terms = (charge.agreement as { terms: { evals?: EvalSpec[]; capability?: string } }).terms;
  // Re-run every eval on this trace, including ground-truth checks that were only sampled live.
  const outcomes = runEvals(terms.evals ?? [], traceOf(call), true, terms.capability);
  const bad = failed(outcomes);
  const upheld = bad.length > 0;
  const verdict = {
    scope: "micro", claim_type: d.claim_type,
    reasoning: upheld
      ? `Re-ran the agreement's evals on call #${call.seq}. ${bad.map((b) => `${b.type}: ${b.detail}`).join("; ")}. The claim is supported by the recorded trace, so the charge is refunded.`
      : `Re-ran the agreement's evals on call #${call.seq}; all checks passed (${outcomes.filter((o) => o.ran).map((o) => `${o.type}: ${o.detail}`).join("; ")}). The claim is not supported by the recorded trace.`,
    rules_applied: (terms.evals ?? []).map((e) => e.type),
    evidence: { call_id: call.id, call_hash: call.hash, outcomes },
  };
  const res = await rpc<Record<string, unknown>>("resolve_micro_dispute", {
    p_dispute: disputeId, p_outcome: upheld ? "upheld" : "rejected", p_refund_pct: upheld ? 100 : 0, p_verdict: verdict,
  });
  return { dispute_id: disputeId, outcome: upheld ? "upheld" : "rejected", reasoning: verdict.reasoning, settlement: res, evidence: verdict.evidence, rules_applied: verdict.rules_applied };
}

// ───────── full dispute: whole agreement, evidence package, reasoned split verdict ─────────
export async function fileFullDispute(buyerId: string, agreementId: string, claimType: string, note: string) {
  const ag = await must(db.from("agreements").select("*").eq("id", agreementId).maybeSingle(), "agreement");
  if (ag.buyer_id !== buyerId) throw new MarketError("unauthorized", "Only the buyer can open a full dispute here.", "Use the buyer's API key.");
  const window = Number((ag.terms as { dispute_response_s?: number }).dispute_response_s ?? 20);
  const deadline = new Date(Date.now() + window * 1000).toISOString();
  const id = await rpc<string>("open_full_dispute", { p_agreement: agreementId, p_opened_by: buyerId, p_claim_type: claimType, p_claim: { note, response_deadline: deadline } });
  return { dispute_id: id, status: "awaiting_response", response_deadline: deadline };
}

export async function respondToDispute(providerId: string, disputeId: string, response: { statement: string }) {
  const d = await must(db.from("disputes").select("*, agreement:agreements(*)").eq("id", disputeId).maybeSingle(), "dispute");
  if ((d.agreement as { provider_id: string }).provider_id !== providerId) throw new MarketError("unauthorized", "Only the provider on this agreement can respond.", "Use the provider's API key.");
  if (d.status !== "awaiting_response") throw new MarketError("wrong_status", `Dispute is ${d.status}.`, "get_dispute shows its state.");
  await db.from("disputes").update({ response, status: "under_review" }).eq("id", disputeId);
  return resolveFull(disputeId);
}

export async function resolveFull(disputeId: string) {
  const d = await must(db.from("disputes").select("*, agreement:agreements(*)").eq("id", disputeId).maybeSingle(), "dispute");
  if (d.status === "resolved") return { dispute_id: disputeId, ...(d.verdict as object) };
  const ag = d.agreement as { id: string; terms: { evals?: EvalSpec[]; capability?: string; acceptance?: { min_pass_rate?: number } } };
  const { data: calls } = await db.from("calls").select("id,seq,request,response,status_code,latency_ms,hash").eq("agreement_id", ag.id).order("seq").limit(500);
  const rows = (calls ?? []) as CallRow[];
  const specs = ag.terms.evals ?? [];

  const perCall = rows.map((c) => ({ c, bad: failed(runEvals(specs, traceOf(c), true, ag.terms.capability)) }));
  const passes = perCall.filter((x) => x.bad.length === 0).length;
  const total = perCall.length;
  const passRate = total ? passes / total : 0;
  const byType: Record<string, number> = {};
  perCall.forEach((x) => x.bad.forEach((b) => (byType[b.type] = (byType[b.type] ?? 0) + 1)));
  const minRate = ag.terms.acceptance?.min_pass_rate ?? 0.9;

  let refundPct = 0;
  let outcome: "upheld" | "partially_upheld" | "rejected" = "rejected";
  if (total === 0) {
    refundPct = 0;
  } else if (passRate < minRate) {
    // Calls that failed a check were already refunded one by one. This is a credit on what remains, sized by how far
    // the pass rate fell short of the agreed acceptance threshold (not by the raw failure rate, to avoid double penalty).
    refundPct = Math.min(100, Math.round(((minRate - passRate) / minRate) * 100));
    outcome = refundPct >= 100 ? "upheld" : "partially_upheld";
  }
  const response = (d.response as { statement?: string } | null)?.statement;
  const lat = rows.map((r) => r.latency_ms);
  const verdict = {
    scope: "full", claim_type: d.claim_type, outcome,
    reasoning:
      `Evidence package: ${total} calls, ${passes} passed every agreement eval (pass rate ${round(passRate, 2)}) against an acceptance threshold of ${minRate}. ` +
      `Failures by check: ${Object.keys(byType).length ? Object.entries(byType).map(([k, v]) => `${k}=${v}`).join(", ") : "none"}. p95 latency ${percentile(lat, 0.95)} ms. ` +
      (response ? `Provider statement considered: "${response.slice(0, 200)}"; it does not change the recorded eval results. ` : "No provider response was received before the deadline. ") +
      (outcome === "rejected"
        ? "The pass rate meets the threshold, so frozen charges and holdback are released to the provider."
        : `The pass rate is below the acceptance threshold by ${round(minRate - passRate, 2)}, so a credit of ${refundPct}% (the shortfall relative to the threshold) applies to the amount still at stake (frozen charges plus holdback); the remainder goes to the provider. Calls that individually failed a check were already refunded and stay refunded, so they are not penalized twice.`),
    rules_applied: [`pass_rate >= ${minRate} else credit (threshold - pass_rate) / threshold on remaining stake`, ...specs.map((s) => `eval:${s.type}`)],
    evidence: { calls: total, passes, pass_rate: round(passRate, 3), failures_by_check: byType, first_call_hash: rows[0]?.hash, last_call_hash: rows.at(-1)?.hash },
    appeal: "Human arbiter appeal is a stub in this build.",
  };
  const settlement = await rpc<Record<string, unknown>>("resolve_full_dispute", { p_dispute: disputeId, p_refund_pct: refundPct, p_verdict: verdict });
  return { dispute_id: disputeId, outcome, refund_pct: refundPct, reasoning: verdict.reasoning, evidence: verdict.evidence, settlement };
}

/** Called on a timer and lazily from reads: resolve overdue full disputes, release charges whose window closed. */
export async function sweep() {
  const { data: due } = await db.from("disputes").select("id,claim").eq("status", "awaiting_response").eq("scope", "full");
  for (const d of due ?? []) {
    const deadline = (d.claim as { response_deadline?: string })?.response_deadline;
    if (deadline && new Date(deadline) < new Date()) await resolveFull(d.id).catch(() => undefined);
  }
  await rpc("release_all_due", {}).catch(() => undefined);
}
