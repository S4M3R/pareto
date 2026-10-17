import type { MCPServer } from "mcp-use";
import { z } from "zod";
import { BASE_URL } from "../lib/env.js";
import { MarketError } from "../lib/errors.js";
import { type Row, agreementFor, checkPolicy, createGrant, db, event, must, roleIn, rpc } from "./common.js";
import { defineTool } from "./define.js";

const NEXT_BY_STATUS: Record<string, { buyer: string; provider: string }> = {
  proposed: { buyer: "Wait for the provider to review_proposal.", provider: "review_proposal: approve, counter, or reject." },
  countered: { buyer: "respond_to_counter: accept or decline the provider's terms.", provider: "Wait for the buyer to respond_to_counter." },
  approved: { buyer: "fund_escrow to activate and receive your access grant.", provider: "Wait for the buyer to fund escrow." },
  active: { buyer: "call_provider to use it; close_task when done; file_dispute if something is wrong.", provider: "Serve calls; respond_to_dispute if one is opened." },
  disputed: { buyer: "get_dispute for the state of the case.", provider: "respond_to_dispute with your statement." },
  settled: { buyer: "review_provider to leave a review.", provider: "review_buyer to leave a review." },
  rejected: { buyer: "propose_agreement with different terms or another provider.", provider: "Nothing further." },
};

export function registerDeal(server: MCPServer) {
  defineTool(server, {
    name: "create_task",
    description: "Describe the work you need done. Creating a task costs nothing; money only moves when you fund an agreement.",
    input: z.object({ title: z.string().min(3), description: z.string().min(10), inputs_hint: z.string().optional() }),
    role: "buyer",
  }, async (a, agent) => {
    const t = await must<Row>(db.from("tasks").insert({ buyer_id: agent!.id, title: a.title, description: a.description, spec: { inputs_hint: a.inputs_hint ?? null } }).select("id").single(), "task");
    return { data: { task_id: t.id }, next: "propose_agreement with this task_id and a listing_id from find_providers." };
  });

  defineTool(server, {
    name: "propose_agreement",
    description: "Propose the service agreement for a task with a chosen provider listing: price, budget cap, SLA, acceptance evals, holdback and dispute windows. The platform runs the evals on your traffic and uses them to settle disputes. Your human-set spending policy is enforced here.",
    input: z.object({
      task_id: z.string().uuid(), listing_id: z.string().uuid(),
      budget_cap_cents: z.number().int().positive().describe("Hard cap. Escrow is funded to exactly this amount."),
      price_cents_per_call: z.number().int().positive().optional().describe("Defaults to the listing price"),
      max_latency_ms: z.number().int().positive().optional().describe("SLA per call; defaults to the listing's SLA"),
      min_field_accuracy: z.number().min(0).max(1).default(0.8).describe("Per-call accuracy a sampled call must reach"),
      sample_rate: z.number().min(0).max(1).default(0.3).describe("Share of live calls checked against ground truth (all are re-checked in a dispute)"),
      holdback_pct: z.number().int().min(0).max(50).default(20).describe("Percent of each payment held until close"),
      check_window_s: z.number().int().min(1).max(3600).default(30).describe("Seconds a charge stays disputable before release"),
      acceptance_min_pass_rate: z.number().min(0.5).max(1).default(0.9).describe("Pass rate the arbiter requires in a full dispute"),
      dispute_response_s: z.number().int().min(1).max(3600).default(20).describe("Seconds the provider has to respond to a full dispute"),
    }),
    role: "buyer",
  }, async (a, agent) => {
    const l = await must<Row>(db.from("listings").select("*").eq("id", a.listing_id).eq("active", true).maybeSingle(), "listing");
    const task = await must<Row>(db.from("tasks").select("id,buyer_id").eq("id", a.task_id).maybeSingle(), "task");
    if (task.buyer_id !== agent!.id) throw new MarketError("unauthorized", "That task belongs to another agent.", "Create your own task with create_task.");
    if (l.provider_id === agent!.id) throw new MarketError("self_dealing", "You cannot hire your own listing.", "Pick a listing from another agent.");
    await checkPolicy(agent!.id, a.budget_cap_cents, l.capability);
    const price = a.price_cents_per_call ?? Number(l.pricing.amount_cents);
    const maxLatency = a.max_latency_ms ?? Number(l.sla?.p95_ms ?? 3000);
    const terms = {
      price: { model: "per_call", amount_cents: price },
      budget_cap_cents: a.budget_cap_cents,
      sla: { max_latency_ms: maxLatency },
      evals: [
        { type: "schema" }, { type: "latency", max_ms: maxLatency }, { type: "billing_matches" },
        { type: "field_accuracy", min: a.min_field_accuracy, sample_rate: a.sample_rate },
      ],
      holdback_pct: a.holdback_pct, check_window_s: a.check_window_s, dispute_response_s: a.dispute_response_s,
      acceptance: { min_pass_rate: a.acceptance_min_pass_rate }, auto_refund_failed: true,
    };
    const ag = await must<Row>(db.from("agreements").insert({ task_id: a.task_id, listing_id: a.listing_id, buyer_id: agent!.id, provider_id: l.provider_id, status: "proposed", terms }).select("id").single(), "agreement");
    await event(ag.id, agent!.id, "proposed", { terms });
    return { data: { agreement_id: ag.id, status: "proposed", terms }, next: "The provider must review_proposal. Poll get_agreement." };
  });

  defineTool(server, {
    name: "list_requests",
    description: "Provider: agreement proposals waiting for your decision, with the terms and the buyer's reputation.",
    input: z.object({}),
    role: "provider",
    readOnly: true,
  }, async (_a, agent) => {
    const { data } = await db.from("agreements").select("id,status,terms,buyer_id,version,proposed_at,listing:listings(title)").eq("provider_id", agent!.id).in("status", ["proposed", "countered"]).order("proposed_at");
    const ids = [...new Set((data ?? []).map((r) => r.buyer_id))];
    const { data: rep } = await db.from("agent_reputation").select("agent_id,handle,settled_agreements,disputes_against").in("agent_id", ids);
    const byId = Object.fromEntries((rep ?? []).map((r) => [r.agent_id, r]));
    return { data: { requests: (data ?? []).map((r) => ({ agreement_id: r.id, status: r.status, listing: (r.listing as Row)?.title, buyer: byId[r.buyer_id]?.handle, buyer_settled_agreements: byId[r.buyer_id]?.settled_agreements ?? 0, terms: r.terms })) }, next: "review_proposal for any agreement_id." };
  });

  defineTool(server, {
    name: "review_proposal",
    description: "Provider: approve, counter, or reject a buyer's proposal. A counter changes the terms you list and sends them back to the buyer.",
    input: z.object({
      agreement_id: z.string().uuid(), decision: z.enum(["approve", "counter", "reject"]),
      counter: z.object({
        price_cents_per_call: z.number().int().positive().optional(), budget_cap_cents: z.number().int().positive().optional(),
        holdback_pct: z.number().int().min(0).max(50).optional(), max_latency_ms: z.number().int().positive().optional(),
      }).optional(), note: z.string().optional(),
    }),
    role: "provider",
  }, async (a, agent) => {
    const ag = await agreementFor(agent!, a.agreement_id);
    if (ag.provider_id !== agent!.id) throw new MarketError("unauthorized", "Only the provider can review this.", "Use the provider's key.");
    if (ag.status !== "proposed") throw new MarketError("wrong_status", `Agreement is ${ag.status}; only 'proposed' agreements can be reviewed.`, "get_agreement shows what is next.");
    if (a.decision === "approve") {
      await db.from("agreements").update({ status: "approved" }).eq("id", ag.id);
      await event(ag.id, agent!.id, "approved", { note: a.note });
      return { data: { agreement_id: ag.id, status: "approved" }, next: "The buyer funds escrow; then you will see calls." };
    }
    if (a.decision === "reject") {
      await db.from("agreements").update({ status: "rejected" }).eq("id", ag.id);
      await event(ag.id, agent!.id, "rejected", { note: a.note });
      return { data: { agreement_id: ag.id, status: "rejected" } };
    }
    if (!a.counter) throw new MarketError("bad_input", "A counter needs at least one changed term.", "Add counter: {price_cents_per_call | budget_cap_cents | holdback_pct | max_latency_ms}.");
    const t = { ...ag.terms };
    if (a.counter.price_cents_per_call) t.price = { ...t.price, amount_cents: a.counter.price_cents_per_call };
    if (a.counter.budget_cap_cents) t.budget_cap_cents = a.counter.budget_cap_cents;
    if (a.counter.holdback_pct !== undefined) t.holdback_pct = a.counter.holdback_pct;
    if (a.counter.max_latency_ms) {
      t.sla = { max_latency_ms: a.counter.max_latency_ms };
      t.evals = t.evals.map((e: Row) => (e.type === "latency" ? { ...e, max_ms: a.counter!.max_latency_ms } : e));
    }
    await db.from("agreements").update({ status: "countered", terms: t, version: ag.version + 1 }).eq("id", ag.id);
    await event(ag.id, agent!.id, "countered", { counter: a.counter, note: a.note });
    return { data: { agreement_id: ag.id, status: "countered", terms: t }, next: "The buyer must respond_to_counter." };
  });

  defineTool(server, {
    name: "respond_to_counter",
    description: "Buyer: accept or decline the provider's counter-offer. Accepting makes the agreement approved; then fund_escrow.",
    input: z.object({ agreement_id: z.string().uuid(), accept: z.boolean() }),
    role: "buyer",
  }, async (a, agent) => {
    const ag = await agreementFor(agent!, a.agreement_id);
    if (ag.buyer_id !== agent!.id) throw new MarketError("unauthorized", "Only the buyer can respond to a counter.", "Use the buyer's key.");
    if (ag.status !== "countered") throw new MarketError("wrong_status", `Agreement is ${ag.status}, not countered.`);
    if (a.accept) await checkPolicy(agent!.id, Number(ag.terms.budget_cap_cents), ag.listing.capability, ag.id);
    await db.from("agreements").update({ status: a.accept ? "approved" : "rejected" }).eq("id", ag.id);
    await event(ag.id, agent!.id, a.accept ? "counter_accepted" : "counter_declined");
    return { data: { agreement_id: ag.id, status: a.accept ? "approved" : "rejected" }, next: a.accept ? "fund_escrow to activate." : "propose_agreement with different terms." };
  });

  defineTool(server, {
    name: "fund_escrow",
    description: "Buyer: fund the approved agreement's escrow to its budget cap from your wallet, activate it, and receive your access grant (the grant key is shown once). Funds are held by the platform and released per call only after checks.",
    input: z.object({ agreement_id: z.string().uuid() }),
    role: "buyer",
  }, async (a, agent) => {
    const ag = await agreementFor(agent!, a.agreement_id);
    if (ag.buyer_id !== agent!.id) throw new MarketError("unauthorized", "Only the buyer funds escrow.", "Use the buyer's key.");
    await checkPolicy(agent!.id, Number(ag.terms.budget_cap_cents), ag.listing.capability, ag.id);
    const res = await rpc<Row>("fund_escrow", { p_agreement: ag.id, p_key: `fund:${ag.id}` });
    const grant = await createGrant(ag.id, Number(ag.terms.budget_cap_cents), ag.terms.deadline);
    return {
      data: {
        agreement_id: ag.id, status: "active", ...res,
        access: { gateway_url: `${BASE_URL}/gw/${ag.id}/call`, header: "x-grant-key", grant_key: grant.key, expires_at: grant.expires_at, note: "Shown once. You can also use the call_provider tool, which needs no grant key." },
      },
      next: "call_provider with {agreement_id, page_id}.",
    };
  });

  defineTool(server, {
    name: "get_agreement",
    description: "Status, terms, spend, and history of an agreement you are party to, plus the next action for your role.",
    input: z.object({ agreement_id: z.string().uuid() }),
    readOnly: true,
  }, async ({ agreement_id }, agent) => {
    const ag = await agreementFor(agent!, agreement_id);
    const role = roleIn(agent!, ag);
    const spend = ag.status === "active" || ag.status === "disputed" || ag.status === "settled" ? await rpc<Row>("agreement_spend", { p_agreement: ag.id }) : null;
    const { data: events } = await db.from("agreement_events").select("kind,created_at,payload").eq("agreement_id", ag.id).order("created_at", { ascending: false }).limit(8);
    return { data: { agreement_id: ag.id, role, status: ag.status, terms: ag.terms, version: ag.version, spend, recent_events: events ?? [] }, next: NEXT_BY_STATUS[ag.status]?.[role] };
  });
}
