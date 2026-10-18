/** Refund requests: the provider decides first, the platform decides on appeal.
 *
 * A refund is a micro dispute whose claim carries `mode: "provider_first"`. It uses the existing `disputes` table and
 * SQL functions, with the phase kept in `status`, `response` and `verdict`:
 *
 *   request           open_micro_dispute (the charge becomes `disputed`), then status -> awaiting_response
 *   provider approves resolve_micro_dispute(upheld, 100)                          -> refunded
 *   provider rejects  status -> open, response.provider_decision.decision = reject -> rejected (the charge stays held)
 *   buyer appeals     status -> under_review, response.appeal = {...}, then the platform re-runs the agreement's
 *                     ground-truth check on the recorded trace (resolveMicro)     -> refunded_on_appeal | denied_on_appeal
 *
 * Money only moves on a final outcome. A held charge is not released by the sweep (it only releases `pending` charges)
 * and close_task refuses while any dispute is unresolved, so an open refund request cannot be bypassed. */
import { capabilityFor } from "./capabilities.js";
import { type Agent } from "./auth.js";
import { db, must, rpc } from "./db.js";
import { BASE_URL } from "./env.js";
import { MarketError } from "./errors.js";
import { resolveMicro } from "./disputes.js";
import { liveLabel } from "./image-data.js";

type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export type RefundStatus = "awaiting_provider" | "refunded" | "rejected" | "under_review" | "refunded_on_appeal" | "denied_on_appeal";

export interface Refund {
  refund_id: string;
  deal_id: string;
  charge_id: string;
  status: RefundStatus;
  amount_cents: number;
  call_seq: number | null;
  buyer: string | null;
  provider: string | null;
  image_id: string | null;
  image_url: string | null;
  answered: { label: string | null; confidence: number | null };
  claim: { reason: string; at: string };
  provider_decision: { decision: "approve" | "reject"; note: string | null; at: string } | null;
  appeal: { note: string | null; at: string } | null;
  final: { outcome: "refunded" | "denied"; reasoning: string; evidence: Record<string, unknown> } | null;
  created_at: string;
}

/** What a disputes row alone does not say: who, which call, what it answered, how much. */
export interface RefundContext {
  amount_cents: number;
  call_seq: number | null;
  buyer: string | null;
  provider: string | null;
  request: Obj | null;
  answered: { label: string | null; confidence: number | null };
}

/** True for disputes opened as refund requests (the provider decides first), false for the automatic micro disputes. */
export const isRefundRow = (d: { scope?: string; claim?: Obj | null }): boolean => d.scope === "micro" && d.claim?.mode === "provider_first";

/** The refund status a disputes row stands for. Pure: depends only on the row. */
export function refundStatusOf(d: { status?: string; response?: Obj | null; verdict?: Obj | null }): RefundStatus {
  switch (d.status) {
    case "awaiting_response": return "awaiting_provider";
    case "open": return "rejected";
    case "under_review": return "under_review";
    case "resolved": {
      const upheld = d.verdict?.outcome === "upheld";
      if (d.response?.appeal) return upheld ? "refunded_on_appeal" : "denied_on_appeal";
      return "refunded"; // without an appeal, the only way to resolve a refund is the provider approving it
    }
    default: return "awaiting_provider";
  }
}

/** A disputes row (plus its context) as the contract's `Refund`. Pure. */
export function refundFromRow(d: Obj, ctx: RefundContext): Refund {
  const status = refundStatusOf(d);
  const imageId = typeof ctx.request?.image_id === "string" ? (ctx.request.image_id as string) : null;
  const imageUrl = imageId ? `${BASE_URL}/images/${imageId}.jpg` : typeof ctx.request?.image_url === "string" ? (ctx.request.image_url as string) : null;
  const resolved = d.status === "resolved";
  const upheld = d.verdict?.outcome === "upheld";
  return {
    refund_id: d.id, deal_id: d.agreement_id, charge_id: d.charge_id, status,
    amount_cents: ctx.amount_cents, call_seq: ctx.call_seq, buyer: ctx.buyer, provider: ctx.provider,
    image_id: imageId, image_url: imageUrl, answered: ctx.answered,
    claim: { reason: String(d.claim?.reason ?? d.claim?.note ?? ""), at: String(d.claim?.at ?? d.opened_at) },
    provider_decision: d.response?.provider_decision ?? null,
    appeal: d.response?.appeal ?? null,
    final: resolved
      ? { outcome: upheld ? "refunded" : "denied", reasoning: String(d.verdict?.reasoning ?? ""), evidence: (d.verdict?.evidence ?? {}) as Record<string, unknown> }
      : null,
    created_at: d.opened_at,
  };
}

const SELECT = "*, charge:charges(id,amount_cents,state,agreement_id,call:calls(id,seq,request,response,hash)), agreement:agreements(id,buyer_id,provider_id,terms)";

async function toRefunds(rows: Obj[]): Promise<Refund[]> {
  const ids = [...new Set(rows.flatMap((r) => [r.agreement?.buyer_id, r.agreement?.provider_id]).filter(Boolean))] as string[];
  const { data: agents } = ids.length ? await db.from("agents").select("id,handle").in("id", ids) : { data: [] };
  const handle = Object.fromEntries((agents ?? []).map((a) => [a.id, a.handle as string]));
  return rows.map((r) => {
    const call = (Array.isArray(r.charge?.call) ? r.charge.call[0] : r.charge?.call) as Obj | undefined;
    const cap = capabilityFor(r.agreement?.terms?.capability);
    const fields = cap.fieldsOf(call?.response) ?? {};
    return refundFromRow(r, {
      amount_cents: Number(r.charge?.amount_cents ?? 0), call_seq: call?.seq ?? null,
      buyer: handle[r.agreement?.buyer_id] ?? null, provider: handle[r.agreement?.provider_id] ?? null, request: call?.request ?? null,
      answered: { label: typeof fields.label === "string" ? fields.label : null, confidence: typeof fields.confidence === "number" ? fields.confidence : null },
    });
  });
}

async function loadRow(refundId: string): Promise<Obj> {
  if (!/^[0-9a-f-]{36}$/i.test(refundId)) throw new MarketError("unknown_refund", "That refund id is not valid.", "Use a refund_id from list_refunds.");
  const { data } = await db.from("disputes").select(SELECT).eq("id", refundId).maybeSingle();
  if (!data || !isRefundRow(data)) throw new MarketError("unknown_refund", "No refund request with that id.", "Use a refund_id from list_refunds or request_refund.");
  return data;
}

const oneRefund = async (row: Obj) => (await toRefunds([row]))[0];

/** Buyer or provider of the deal only. */
export async function getRefund(agent: Agent, refundId: string): Promise<Refund> {
  const row = await loadRow(refundId);
  if (row.agreement.buyer_id !== agent.id && row.agreement.provider_id !== agent.id) throw new MarketError("unauthorized", "You are not a party to this deal.", "Use the buyer's or the provider's account.");
  return oneRefund(row);
}

/** Refund requests the agent is party to, newest first. `as` limits to one side. */
export async function listRefunds(agent: Agent, f: { agreementId?: string; as?: "buyer" | "provider"; status?: RefundStatus } = {}): Promise<Refund[]> {
  const sides = f.as ? [f.as === "buyer" ? "buyer_id" : "provider_id"] : ["buyer_id", "provider_id"];
  const agr = new Set<string>();
  for (const col of sides) {
    let q = db.from("agreements").select("id").eq(col, agent.id).limit(500);
    if (f.agreementId) q = q.eq("id", f.agreementId);
    for (const a of (await q).data ?? []) agr.add(a.id);
  }
  if (agr.size === 0) return [];
  const { data } = await db.from("disputes").select(SELECT).eq("scope", "micro").eq("claim->>mode", "provider_first").neq("status", "withdrawn").in("agreement_id", [...agr]).order("opened_at", { ascending: false }).limit(200);
  const all = await toRefunds(data ?? []);
  return f.status ? all.filter((r) => r.status === f.status) : all;
}

/** The buyer asks for one call's charge back. The provider decides first. */
export async function requestRefund(buyer: Agent, a: { dealId?: string; chargeId: string; reason: string }): Promise<Refund> {
  const reason = a.reason.trim();
  if (reason.length < 3 || reason.length > 500) throw new MarketError("bad_input", "Say why in 3 to 500 characters.", "For example: 'It is a dog, not a hot dog.'");
  const charge = await must<Obj>(db.from("charges").select("id,state,agreement_id,agreement:agreements(buyer_id,provider_id)").eq("id", a.chargeId).maybeSingle(), "charge");
  const ag = (Array.isArray(charge.agreement) ? charge.agreement[0] : charge.agreement) as Obj;
  if (a.dealId && charge.agreement_id !== a.dealId) throw new MarketError("bad_input", "That charge belongs to a different deal.", "Take the charge_id from this deal's calls.");
  if (ag.buyer_id !== buyer.id) throw new MarketError("unauthorized", "Only the buyer can ask for this refund.", "Use the buyer's account.");
  const { data: prior } = await db.from("disputes").select("id").eq("charge_id", charge.id).limit(1);
  if (prior?.length) throw new MarketError("refund_exists", "A refund was already requested for this call.", "Use list_refunds to see where it stands.");
  const id = await rpc<string>("open_micro_dispute", {
    p_charge: charge.id, p_opened_by: buyer.id, p_claim_type: "wrong_output",
    p_claim: { reason, mode: "provider_first", at: new Date().toISOString() },
  });
  await db.from("disputes").update({ status: "awaiting_response" }).eq("id", id);
  return oneRefund(await loadRow(id));
}

/** The provider of the deal approves (refund from escrow) or rejects (the buyer may appeal). */
export async function decideRefund(provider: Agent, a: { refundId: string; decision: "approve" | "reject"; note?: string }): Promise<Refund> {
  const row = await loadRow(a.refundId);
  if (row.agreement.provider_id !== provider.id) throw new MarketError("unauthorized", "Only the deal's provider can decide this refund.", "Use the provider's account.");
  if (row.status !== "awaiting_response") throw new MarketError("wrong_status", `This refund is already ${refundStatusOf(row)}.`, "Only requests that are awaiting_provider can be decided.");
  const note = a.note?.trim() ? a.note.trim().slice(0, 300) : null;
  const decision = { decision: a.decision, note, at: new Date().toISOString() };
  const response = { ...(row.response ?? {}), provider_decision: decision };
  // claim the request atomically so two clicks (or two devices) cannot both decide
  const next = a.decision === "approve" ? "under_review" : "open";
  const { data: claimed } = await db.from("disputes").update({ status: next, response }).eq("id", row.id).eq("status", "awaiting_response").select("id");
  if (!claimed?.length) throw new MarketError("wrong_status", "Someone just decided this refund.", "Reload to see the outcome.");
  if (a.decision === "approve") {
    const call = (Array.isArray(row.charge?.call) ? row.charge.call[0] : row.charge?.call) as Obj;
    await rpc("resolve_micro_dispute", {
      p_dispute: row.id, p_outcome: "upheld", p_refund_pct: 100,
      p_verdict: {
        scope: "micro", mode: "provider_first", claim_type: row.claim_type, rules_applied: ["provider_decision"],
        reasoning: `${provider.handle} approved the refund${note ? `: ${note}` : "."}`,
        evidence: { call_id: call?.id, call_hash: call?.hash, decided_by: provider.handle },
      },
    });
  }
  return oneRefund(await loadRow(row.id));
}

/** The buyer appeals a rejection. The platform reviews on the recorded trace and returns the final state. */
export async function appealRefund(buyer: Agent, a: { refundId: string; note?: string }): Promise<Refund> {
  const row = await loadRow(a.refundId);
  if (row.agreement.buyer_id !== buyer.id) throw new MarketError("unauthorized", "Only the buyer can appeal.", "Use the buyer's account.");
  if (row.status !== "open") throw new MarketError("wrong_status", `This refund is ${refundStatusOf(row)}; only a rejected refund can be appealed.`, "Wait for the provider's decision, or check list_refunds.");
  const appeal = { note: a.note?.trim() ? a.note.trim().slice(0, 300) : null, at: new Date().toISOString() };
  const { data: claimed } = await db.from("disputes").update({ status: "under_review", response: { ...(row.response ?? {}), appeal } }).eq("id", row.id).eq("status", "open").select("id");
  if (!claimed?.length) throw new MarketError("wrong_status", "This refund was just appealed.", "Reload to see the outcome.");

  const call = (Array.isArray(row.charge?.call) ? row.charge.call[0] : row.charge?.call) as Obj;
  const cap = capabilityFor(row.agreement.terms?.capability);
  const reference = cap.check(call?.request ?? {}, cap.fieldsOf(call?.response));
  if (!reference) {
    // The platform decides on evidence it holds. With no reference answer for this input, the provider's decision stands.
    await rpc("resolve_micro_dispute", {
      p_dispute: row.id, p_outcome: "rejected", p_refund_pct: 0,
      p_verdict: {
        scope: "micro", mode: "provider_first", claim_type: row.claim_type, rules_applied: ["reference_required"],
        reasoning: "The platform has no independent reference answer for this input (an image URL or your own upload), so it cannot overturn the provider's decision. Only calls on the platform's sample images can be verified on appeal.",
        evidence: { call_id: call?.id, call_hash: call?.hash },
      },
    });
  } else {
    const res = await resolveMicro(row.id); // re-runs the agreement's evals with ground truth on the recorded trace, then refunds or releases
    // The eval log is exact but dense. Put the plain statement first: what the reference says, what the provider answered, and the result.
    const want = typeof call?.request?.image_id === "string" ? liveLabel(call.request.image_id) : undefined;
    const got = cap.fieldsOf(call?.response)?.label;
    if (want && typeof got === "string") {
      const who = row.agreement?.provider_id ? (await db.from("agents").select("handle").eq("id", row.agreement.provider_id).maybeSingle()).data?.handle ?? "The provider" : "The provider";
      const plain = `The reference answer for this photo is ${want}. ${who} answered ${got}. ` + (res.outcome === "upheld" ? "The answer was wrong, so the appeal is upheld and the charge is refunded." : "The answer was correct, so the appeal is denied.");
      const { data: d } = await db.from("disputes").select("verdict").eq("id", row.id).single();
      await db.from("disputes").update({ verdict: { ...(d?.verdict ?? {}), reasoning: plain, detail: d?.verdict?.reasoning } }).eq("id", row.id);
    }
  }
  return oneRefund(await loadRow(row.id));
}
