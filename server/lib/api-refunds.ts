/** Refund requests over REST, and the provider's phone console.
 *   POST /api/deals/:id/refunds        buyer asks for one call's charge back        -> 201 Refund
 *   GET  /api/refunds/:id              buyer or provider of the deal                -> Refund
 *   POST /api/refunds/:id/appeal       buyer, only after a rejection                -> Refund (platform review runs inline)
 *   GET  /api/provider/refunds         provider's queue (?status=awaiting_provider) -> {refunds}
 *   POST /api/refunds/:id/decision     the deal's provider: approve | reject        -> Refund
 *   GET  /console/refunds?t=<token>    the provider's page, made for a phone
 * Same auth as the rest of the API (agentOf): an API key or a console session token. */
import { z } from "zod";
import { agentOf, body, respond } from "./api.js";
import { MarketError } from "./errors.js";
import { refundsPage } from "./console-refunds-page.js";
import { appealRefund, decideRefund, getRefund, listRefunds, requestRefund, type RefundStatus } from "./refunds.js";
import type { AnyServer } from "../tools/define.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type C = any;

const STATUSES = ["awaiting_provider", "refunded", "rejected", "under_review", "refunded_on_appeal", "denied_on_appeal"] as const;
const RequestBody = z.object({ charge_id: z.string().uuid(), reason: z.string().min(3).max(500) });
const AppealBody = z.object({ note: z.string().max(300).optional() });
const DecisionBody = z.object({ decision: z.enum(["approve", "reject"]), note: z.string().max(300).optional() });

export function registerRefundsApi(server: AnyServer) {
  server.post("/api/deals/:id/refunds", (c: C) => respond(c, async () => {
    const agent = await agentOf(c);
    const b = await body(c, RequestBody);
    return { status: 201, body: await requestRefund(agent, { dealId: c.req.param("id"), chargeId: b.charge_id, reason: b.reason }) };
  }));
  server.get("/api/refunds/:id", (c: C) => respond(c, async () => ({ body: await getRefund(await agentOf(c), c.req.param("id")) })));
  server.post("/api/refunds/:id/appeal", (c: C) => respond(c, async () => {
    const agent = await agentOf(c);
    const b = await body(c, AppealBody);
    return { body: await appealRefund(agent, { refundId: c.req.param("id"), note: b.note }) };
  }));
  server.get("/api/provider/refunds", (c: C) => respond(c, async () => {
    const agent = await agentOf(c);
    if (!agent.roles.includes("provider")) throw new MarketError("wrong_role", "The refund queue is for provider agents.", "Sign in as the provider.");
    const status = c.req.query("status");
    if (status && !(STATUSES as readonly string[]).includes(status)) throw new MarketError("bad_input", `status must be one of ${STATUSES.join(", ")}.`, "Drop the filter to see everything.");
    return { body: { refunds: await listRefunds(agent, { as: "provider", status: status as RefundStatus | undefined }) } };
  }));
  server.post("/api/refunds/:id/decision", (c: C) => respond(c, async () => {
    const agent = await agentOf(c);
    const b = await body(c, DecisionBody);
    return { body: await decideRefund(agent, { refundId: c.req.param("id"), decision: b.decision, note: b.note }) };
  }));
  // who the session token belongs to; the console pages show it in their header
  server.get("/api/console/me", (c: C) => respond(c, async () => {
    const a = await agentOf(c);
    return { body: { handle: a.handle, roles: a.roles } };
  }));
  server.get("/console/refunds", (c: C) => c.html(refundsPage));
}
