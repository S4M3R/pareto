import { z } from "zod";
import { fileFullDispute, fileMicroDispute, resolveFull, respondToDispute, sweep } from "../lib/disputes.js";
import { MarketError } from "../lib/errors.js";
import { usd } from "../lib/format.js";
import { CloseTaskOut, FileDisputeOut, GetDisputeOut, ReviewOut } from "../lib/schemas.js";
import { type Row, agreementFor, db, handlesOf, must, rpc, walletCents } from "./common.js";
import { type AnyServer, defineTool } from "./define.js";

export function registerDisputes(server: AnyServer) {
  defineTool(server, {
    name: "file_dispute",
    description: "Buyer: dispute a result. scope='micro' targets ONE pending charge (give charge_id): the platform re-runs the agreement's evals on that call's trace and refunds it in seconds if the trace shows the problem. scope='full' targets the whole agreement (give agreement_id): it FREEZES remaining escrow and revokes access, assembles an evidence package, gives the provider a response window, then an arbiter returns a reasoned split verdict. Use micro first; full is for systemic failure.",
    input: z.object({
      scope: z.enum(["micro", "full"]),
      charge_id: z.string().uuid().optional(), agreement_id: z.string().uuid().optional(),
      claim_type: z.enum(["wrong_output", "over_billed", "late", "malformed", "non_delivery", "sla_breach", "quality"]),
      note: z.string().max(500).default(""),
    }),
    role: "buyer",
    destructive: true,
    output: FileDisputeOut,
    view: { name: "dispute-verdict", description: "The verdict on a dispute, with the evidence and the refund" },
  }, async (a, agent) => {
    if (a.scope === "micro") {
      if (!a.charge_id) throw new MarketError("bad_input", "Micro disputes need charge_id.", "Get one from list_calls.");
      const r = await fileMicroDispute(agent!.id, a.charge_id, a.claim_type, a.note);
      const refunded = Number((r.settlement as { refunded_cents?: number } | undefined)?.refunded_cents ?? 0);
      return { data: r, next: r.outcome === "upheld" ? "The charge was refunded. Continue, or close_task." : "Claim rejected: the trace passed every check. Consider a full dispute only if the problem is systemic.", say: `Micro dispute ${r.outcome}${refunded ? `, ${usd(refunded)} refunded` : ""}. The verdict card is on screen with the evidence; reply in one short sentence.` };
    }
    if (!a.agreement_id) throw new MarketError("bad_input", "Full disputes need agreement_id.", "Use the agreement you want to dispute.");
    const r = await fileFullDispute(agent!.id, a.agreement_id, a.claim_type, a.note);
    return { data: r, next: "The provider has until response_deadline. get_dispute shows the verdict once it is issued.", say: "Full dispute opened and the remaining escrow is frozen. The card on screen tracks the verdict; reply in one short sentence." };
  });

  defineTool(server, {
    name: "respond_to_dispute",
    description: "Provider: answer a full dispute with your statement. Responding triggers the arbiter, which weighs recorded evidence (traces, eval results, meter) and may refund part or all of the amount at stake. Statements do not change recorded eval results.",
    input: z.object({ dispute_id: z.string().uuid(), statement: z.string().min(5).max(1000) }),
    role: "provider",
  }, async (a, agent) => {
    const r = await respondToDispute(agent!.id, a.dispute_id, { statement: a.statement });
    return { data: r, next: "review_buyer once the agreement is settled." };
  });

  defineTool(server, {
    name: "get_dispute",
    description: "State of a dispute you are party to: claim, provider response, and the reasoned verdict with evidence once resolved. Overdue full disputes are resolved on read.",
    input: z.object({ dispute_id: z.string().uuid() }),
    readOnly: true,
    show: {
      name: "show_dispute",
      description: "Display only: shows the human where a dispute stands (claim, response, verdict) as a card. To read it yourself use get_dispute.",
      view: { name: "dispute-status", description: "Where a dispute stands: claim, response, verdict" },
      output: GetDisputeOut,
    },
  }, async ({ dispute_id }, agent) => {
    let d = await must<Row>(db.from("disputes").select("*, agreement:agreements(buyer_id,provider_id)").eq("id", dispute_id).maybeSingle(), "dispute");
    if (d.agreement.buyer_id !== agent!.id && d.agreement.provider_id !== agent!.id) throw new MarketError("unauthorized", "Not your dispute.", "Use a party's key.");
    if (d.status === "awaiting_response" && new Date(d.claim?.response_deadline ?? 0) < new Date()) {
      await resolveFull(dispute_id);
      d = await must<Row>(db.from("disputes").select("*, agreement:agreements(buyer_id,provider_id)").eq("id", dispute_id).maybeSingle(), "dispute");
    }
    return { data: { dispute_id, scope: d.scope, status: d.status, claim_type: d.claim_type, claim: d.claim, response: d.response, verdict: d.verdict, opened_at: d.opened_at, resolved_at: d.resolved_at },
      next: d.status === "resolved" ? "get_ledger shows the money movements this verdict caused." : "Waiting on the provider's response or the deadline." };
  });

  defineTool(server, {
    name: "close_task",
    description: "Buyer: finish the work. Remaining pending charges are released to the provider, holdback is released, unspent budget returns to your wallet, access is revoked, and the agreement becomes settled so both sides can review.",
    input: z.object({ agreement_id: z.string().uuid() }),
    role: "buyer",
    destructive: true,
    output: CloseTaskOut,
    view: { name: "settlement", description: "Settlement: what was spent, refunded and returned" },
  }, async ({ agreement_id }, agent) => {
    const ag = await agreementFor(agent!, agreement_id);
    if (ag.buyer_id !== agent!.id) throw new MarketError("unauthorized", "Only the buyer can close.", "Use the buyer's key.");
    const r = await rpc<Row>("close_agreement", { p_agreement: agreement_id, p_actor: agent!.id });
    const spend = await rpc<Row>("agreement_spend", { p_agreement: agreement_id });
    const provider = (await handlesOf([ag.provider_id]))[ag.provider_id];
    return { data: { status: "settled", ...r, final: spend, wallet_cents: await walletCents(agent!.id), provider, listing_title: ag.listing?.title }, next: "review_provider to leave a review.", say: `Settled: ${usd(spend.charged_cents - spend.refunded_cents)} paid to the provider, ${usd(spend.refunded_cents)} refunded, ${usd(r.returned_unspent_cents)} returned to the wallet. The settlement card is on screen (the user can leave a review there); reply in one short sentence.` };
  });

  const ratings = z.object({
    accuracy: z.number().int().min(1).max(5), sla: z.number().int().min(1).max(5),
    clarity: z.number().int().min(1).max(5), cost_fairness: z.number().int().min(1).max(5),
  });
  const submit = async (agentId: string, ownerRef: string, agreementId: string, r: z.infer<typeof ratings>, comment: string, side: "buyer" | "provider") => {
    const ag = await must<Row>(db.from("agreements").select("*").eq("id", agreementId).maybeSingle(), "agreement");
    const mine = side === "buyer" ? ag.buyer_id : ag.provider_id;
    if (mine !== agentId) throw new MarketError("unauthorized", `Only the ${side} can leave this review.`, "Use the right account.");
    if (ag.status !== "settled") throw new MarketError("wrong_status", `Agreement is ${ag.status}; reviews open once it is settled.`, "Finish with close_task or wait for a dispute verdict.");
    const other = side === "buyer" ? ag.provider_id : ag.buyer_id;
    const { data: o } = await db.from("agents").select("owner_ref").eq("id", other).single();
    if (o?.owner_ref === ownerRef) throw new MarketError("self_dealing", "Same-owner agents cannot review each other.", "Reviews must come from independent parties.");
    const { data: ch } = await db.from("charges").select("amount_cents,refunded_cents").eq("agreement_id", agreementId);
    const value = (ch ?? []).reduce((s, c) => s + c.amount_cents - c.refunded_cents, 0);
    const weight = 1 + Math.min(4, Math.floor(value / 50));
    const { error } = await db.from("reviews").insert({ agreement_id: agreementId, reviewer_id: agentId, reviewee_id: other, ratings: r, comment, weight });
    if (error) throw new MarketError("review_exists", error.message.includes("duplicate") ? "You already reviewed this agreement." : error.message);
    return { review: "recorded", weight, value_cents: value };
  };
  defineTool(server, {
    name: "review_provider",
    description: "Buyer: review the provider once the agreement is settled. Ratings 1-5 for accuracy, sla, clarity, cost_fairness. Reviews are tied to this agreement and weighted by its value; they appear beside platform-measured metrics.",
    input: z.object({ agreement_id: z.string().uuid(), ratings, comment: z.string().max(500).default("") }),
    role: "buyer",
    output: ReviewOut,
  }, async (a, agent) => ({ data: await submit(agent!.id, (await db.from("agents").select("owner_ref").eq("id", agent!.id).single()).data!.owner_ref, a.agreement_id, a.ratings, a.comment, "buyer") }));
  defineTool(server, {
    name: "review_buyer",
    description: "Provider: review the buyer once the agreement is settled (clear specs, fair disputes, prompt funding). Same rules as review_provider.",
    input: z.object({ agreement_id: z.string().uuid(), ratings, comment: z.string().max(500).default("") }),
    role: "provider",
    output: ReviewOut,
  }, async (a, agent) => ({ data: await submit(agent!.id, (await db.from("agents").select("owner_ref").eq("id", agent!.id).single()).data!.owner_ref, a.agreement_id, a.ratings, a.comment, "provider") }));

  void sweep;
}
