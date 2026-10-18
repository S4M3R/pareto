import { createHash } from "node:crypto";
import { agentFromKey, sha256 } from "./auth.js";
import { BASE_URL } from "./env.js";
import { db, must, rpc } from "./db.js";
import { MarketError } from "./errors.js";
import { capabilityFor } from "./capabilities.js";
import { type EvalSpec, type Trace, failed, runEvals } from "./evals.js";

/** The per-agreement access point. Every call is authorized, rate limited, forwarded, timed, metered,
 * checked against the agreement's evals, hash-chained into the trace, and recorded as a pending charge. */
const buckets = new Map<string, { n: number; reset: number }>();

function rateLimit(grantId: string, perMin: number) {
  const now = Date.now();
  const b = buckets.get(grantId);
  if (!b || now > b.reset) buckets.set(grantId, { n: 1, reset: now + 60_000 });
  else if (++b.n > perMin) throw new MarketError("rate_limited", `Rate limit ${perMin}/min reached.`, "Wait for the window to reset or ask the provider for a higher limit in a new agreement.");
}

/** Platform-operated providers are served by this very server. Their stored URL names the origin they were seeded from,
 * which is not ours once the server is deployed, so resolve the path against our own origin. Everyone else's endpoint
 * is called as registered. */
export function endpointFor(l: { endpoint_url: string; seeded?: boolean }): string {
  try {
    const u = new URL(l.endpoint_url);
    if (l.seeded && u.pathname.startsWith("/providers/")) return BASE_URL + u.pathname;
  } catch {
    /* not a URL: let fetch report it */
  }
  return l.endpoint_url;
}

export interface Caller { agentId?: string; grantKey?: string }

export async function callThroughGateway(agreementId: string, input: Record<string, unknown>, caller: Caller) {
  // Authorization: either the buyer agent itself (MCP path) or the scoped grant key (HTTP path).
  const ag = await must(db.from("agreements").select("*, listing:listings(*)").eq("id", agreementId).maybeSingle(), "agreement");
  const { data: grant } = await db.from("access_grants").select("*").eq("agreement_id", agreementId).maybeSingle();
  if (caller.grantKey) {
    if (!grant || grant.key_hash !== sha256(caller.grantKey)) throw new MarketError("unauthorized", "Invalid grant key.", "Use the grant key returned by fund_escrow, in the x-grant-key header.");
  } else if (caller.agentId !== ag.buyer_id) {
    throw new MarketError("unauthorized", "Only the buyer of this agreement can use it.", "Use the buyer's API key.");
  }
  if (ag.status !== "active") throw new MarketError("not_active", `Agreement is ${ag.status}.`);
  if (grant) {
    if (grant.revoked_at) throw new MarketError("grant_revoked", "Access was revoked.", "Call get_agreement to see why (closed or disputed).");
    if (new Date(grant.expires_at) < new Date()) throw new MarketError("grant_expired", "Access grant expired.", "Open a new agreement.");
    rateLimit(grant.id, grant.rate_limit_per_min);
  }

  const terms = ag.terms as { capability?: string; price: { amount_cents: number }; sla?: { p95_ms?: number }; evals?: EvalSpec[]; check_window_s?: number; auto_refund_failed?: boolean };
  const capabilityId = terms.capability ?? (ag.listing as { capability?: string }).capability;
  const cap = capabilityFor(capabilityId);
  const { request, body } = cap.prepare(input ?? {});
  const listing = ag.listing as { endpoint_url: string; endpoint_type: string; seeded?: boolean };
  if (listing.endpoint_type !== "http") throw new MarketError("unsupported", "Only HTTP providers are supported by this gateway version.", "Pick a provider with an HTTP endpoint.");

  // Forward to the provider, measuring latency ourselves.
  const t0 = Date.now();
  let status = 502;
  let response: Trace["response"] = null;
  try {
    const r = await fetch(endpointFor(listing), {
      method: "POST",
      headers: { "content-type": "application/json", "x-agreement-id": agreementId },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    status = r.status;
    response = (await r.json().catch(() => null)) as Trace["response"];
  } catch {
    /* provider unreachable: recorded as a failed, non-billable call */
  }
  const latency_ms = Date.now() - t0;

  const unitsMeasured = 1; // one page per call; measured by the platform, independent of what the provider claims
  const trace: Trace = { request, response, status, latency_ms, units_measured: unitsMeasured };
  const outcomes = runEvals(terms.evals ?? [], trace, false, capabilityId);
  const bad = failed(outcomes);
  const charge = status === 200 ? terms.price.amount_cents * unitsMeasured : 0;

  const rec = await rpc<{ call_id: string; charge_id: string; seq: number; hash: string; spent_cents: number; cap_cents: number }>("append_call", {
    p_agreement: agreementId,
    p_request: request,
    p_response: response ?? { error: "provider_unreachable_or_invalid" },
    p_status: status,
    p_latency: latency_ms,
    p_eval: { outcomes },
    p_passed: bad.length === 0,
    p_charge_cents: charge,
    p_window_s: terms.check_window_s ?? 30,
  });

  let callStatus: "pending" | "auto_refunded" = "pending";
  if (bad.length > 0 && terms.auto_refund_failed === true && charge > 0) {
    await rpc("refund_charge", {
      p_charge: rec.charge_id, p_pct: 100,
      p_reason: `auto-refund: ${bad.map((b) => b.type).join(", ")} failed`,
      p_evidence: { call_id: rec.call_id, hash: rec.hash, failed: bad },
    });
    callStatus = "auto_refunded";
  }

  return {
    call_id: rec.call_id, charge_id: rec.charge_id, seq: rec.seq, hash: rec.hash.slice(0, 16),
    result: cap.fieldsOf(response) ?? null,
    status: callStatus,
    charged_cents: callStatus === "auto_refunded" ? 0 : charge,
    checks: outcomes.filter((o) => o.ran).map((o) => ({ type: o.type, passed: o.passed, detail: o.detail })),
    check_window_s: terms.check_window_s ?? 30,
    spent_cents: rec.spent_cents, cap_cents: rec.cap_cents,
    latency_ms,
  };
}

export const hashShort = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);
export { agentFromKey };
