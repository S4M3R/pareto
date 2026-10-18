import { z } from "zod";
import { callThroughGateway } from "../lib/gateway.js";
import { MarketError } from "../lib/errors.js";
import { sweep } from "../lib/disputes.js";
import { BASE_URL } from "../lib/env.js";
import { CallProviderOut, GetSpendOut, ListCallsOut } from "../lib/schemas.js";
import { type Row, agreementFor, db, must, rpc } from "./common.js";
import { type AnyServer, defineTool } from "./define.js";

export function registerUse(server: AnyServer) {
  defineTool(server, {
    name: "call_provider",
    description: "Buyer: use the provider through the platform gateway. Each call is metered, traced, checked against the agreement's evals, and creates a pending charge you can still dispute during the check window. Failed checks are refunded automatically. Input depends on the capability: profile-extraction takes page_id; image-classification takes exactly one of image_id (a live-pool image from list_sample_images), image_url (public https) or image_base64 (your own, under 1 MB).",
    input: z.object({
      agreement_id: z.string().uuid(),
      page_id: z.number().int().optional().describe("profile-extraction: which profile page to extract"),
      image_id: z.string().optional().describe("image-classification: a live-pool image id from list_sample_images"),
      image_url: z.string().url().optional().describe("image-classification: a public https image URL"),
      image_base64: z.string().optional().describe("image-classification: your own image, base64, under 1 MB"),
    }),
    role: "buyer",
  }, async (a, agent) => {
    const { agreement_id, ...input } = a;
    const r = await callThroughGateway(agreement_id, input, { agentId: agent!.id });
    const failed = r.checks.filter((c) => !c.passed);
    return { data: r, next: failed.length ? "Auto-refunded because a check failed. Keep going, or file_dispute if you see other problems." : "list_calls to review traces, get_spend for the meter, file_dispute if a result looks wrong." };
  });

  defineTool(server, {
    name: "get_access",
    description: "How to reach the provider through the gateway for an active agreement (URL, header, rate limit, expiry). The grant key itself is only shown once, by fund_escrow.",
    input: z.object({ agreement_id: z.string().uuid() }),
    readOnly: true,
  }, async ({ agreement_id }, agent) => {
    const ag = await agreementFor(agent!, agreement_id);
    const { data: g } = await db.from("access_grants").select("budget_cap_cents,rate_limit_per_min,expires_at,revoked_at").eq("agreement_id", ag.id).maybeSingle();
    if (!g) throw new MarketError("no_grant", "No access grant yet.", "The buyer must fund_escrow first.");
    return { data: { gateway_url: `${BASE_URL}/gw/${ag.id}/call`, header: "x-grant-key", mcp_alternative: "call_provider", ...g, active: !g.revoked_at && new Date(g.expires_at) > new Date() } };
  });

  defineTool(server, {
    name: "get_spend",
    description: "Live spend meter for an agreement: charged, pending, released, held back, refunded, escrow balance, and remaining budget.",
    input: z.object({ agreement_id: z.string().uuid() }),
    readOnly: true,
    show: {
      name: "show_spend",
      description: "Display only: shows the human a live spend meter for an agreement. To read the numbers yourself use get_spend.",
      view: { name: "spend-meter", description: "Live spend meter for an agreement" },
      output: GetSpendOut,
    },
  }, async ({ agreement_id }, agent) => {
    await agreementFor(agent!, agreement_id);
    await sweep();
    const s = await rpc<Row>("agreement_spend", { p_agreement: agreement_id });
    return { data: { ...s, remaining_budget_cents: Number(s.budget_cap_cents) - (Number(s.charged_cents) - Number(s.refunded_cents)) }, next: "list_calls to see each charge." };
  });

  defineTool(server, {
    name: "list_calls",
    description: "Calls made under an agreement with each charge's state and eval results. Use only='failed' to find problems; use a charge_id with file_dispute.",
    input: z.object({ agreement_id: z.string().uuid(), only: z.enum(["all", "failed"]).default("all"), limit: z.number().int().min(1).max(50).default(15) }),
    readOnly: true,
  }, async (a, agent) => {
    await agreementFor(agent!, a.agreement_id);
    await sweep();
    let q = db.from("calls").select("id,seq,latency_ms,passed,eval_results,created_at,charge:charges(id,state,amount_cents,release_at)").eq("agreement_id", a.agreement_id).order("seq", { ascending: false }).limit(a.limit);
    if (a.only === "failed") q = q.eq("passed", false);
    const { data } = await q;
    const calls = (data ?? []).map((c) => {
      const ch = Array.isArray(c.charge) ? c.charge[0] : c.charge;
      return { seq: c.seq, call_id: c.id, charge_id: ch?.id, charge_state: ch?.state, cents: ch?.amount_cents, passed: c.passed, latency_ms: c.latency_ms,
        failed_checks: ((c.eval_results as Row)?.outcomes ?? []).filter((o: Row) => o.ran && !o.passed).map((o: Row) => o.detail) };
    });
    return { data: { calls }, next: "get_trace for a full record; file_dispute with a charge_id if a pending charge looks wrong." };
  });

  defineTool(server, {
    name: "get_trace",
    description: "The full recorded trace of one call: request, response, latency, eval outcomes, and its hash-chain links. Both parties and the arbiter see this same record.",
    input: z.object({ call_id: z.string().uuid() }),
    readOnly: true,
  }, async ({ call_id }, agent) => {
    const c = await must<Row>(db.from("calls").select("*").eq("id", call_id).maybeSingle(), "call");
    await agreementFor(agent!, c.agreement_id);
    return { data: { seq: c.seq, request: c.request, response: c.response, status_code: c.status_code, latency_ms: c.latency_ms, cost_cents: c.cost_cents, eval_results: c.eval_results, prev_hash: c.prev_hash, hash: c.hash, at: c.created_at } };
  });
}
