/** REST API for deals: the agreements the caller is the buyer of, and the calls made under them.
 *   GET /api/deals?status=active     the caller's deals, newest first
 *   GET /api/deals/:id               one deal with its spend
 *   GET /api/deals/:id/calls         what was sent and answered, each call's charge state and any refund request
 * Same authentication as the rest of the API (agent key or console session). The gateway call itself is POST /gw/:id/call. */
import { agentOf, respond } from "./api.js";
import { db, rpc } from "./db.js";
import { BASE_URL } from "./env.js";
import { MarketError } from "./errors.js";
import { isRefundRow, refundStatusOf } from "./refunds.js";
import type { AnyServer } from "../tools/define.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type C = any; // the Hono context; its type is internal to mcp-use
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const STATUSES = ["draft", "proposed", "countered", "approved", "funded", "active", "closing", "settled", "disputed", "rejected", "expired", "cancelled"];

function dealOf(ag: Row, provider: string | undefined) {
  const terms = (ag.terms ?? {}) as Row;
  const listing = (ag.listing ?? {}) as Row;
  return {
    deal_id: ag.id as string,
    status: ag.status as string,
    provider: provider ?? "unknown",
    title: (listing.title ?? "") as string,
    capability: (terms.capability ?? listing.capability ?? "") as string,
    price_cents_per_call: Number(terms.price?.amount_cents ?? 0),
    cap_cents: Number(terms.budget_cap_cents ?? 0),
    benchmark_id: (terms.benchmark_id ?? null) as string | null,
    check_window_s: (terms.check_window_s ?? null) as number | null,
    created_at: ag.proposed_at as string,
  };
}

async function handles(ids: string[]): Promise<Record<string, string>> {
  if (ids.length === 0) return {};
  const { data } = await db.from("agents").select("id,handle").in("id", ids);
  return Object.fromEntries((data ?? []).map((a) => [a.id, a.handle]));
}

/** The deal, only if the caller is its buyer. A deal that does not exist and a deal that is someone else's are told apart. */
async function ownDeal(buyerId: string, id: string): Promise<Row> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new MarketError("unknown_agreement", "No such deal.", "Use a deal id from GET /api/deals.");
  const { data } = await db.from("agreements").select("*, listing:listings(title,capability)").eq("id", id).maybeSingle();
  if (!data) throw new MarketError("unknown_agreement", "No such deal.", "Use a deal id from GET /api/deals.");
  if (data.buyer_id !== buyerId) throw new MarketError("unauthorized", "That deal belongs to another agent.", "Use the buyer's key.");
  return data;
}

export function registerDealsApi(server: AnyServer) {
  server.get("/api/deals", (c: C) => respond(c, async () => {
    const agent = await agentOf(c);
    const wanted = String(c.req.query("status") ?? "").split(",").map((s) => s.trim()).filter((s) => STATUSES.includes(s));
    let q = db.from("agreements").select("*, listing:listings(title,capability)").eq("buyer_id", agent.id).order("proposed_at", { ascending: false }).limit(50);
    if (wanted.length) q = q.in("status", wanted);
    const { data } = await q;
    const names = await handles([...new Set((data ?? []).map((a) => a.provider_id as string))]);
    return { body: { deals: (data ?? []).map((a) => dealOf(a, names[a.provider_id])) } };
  }));

  server.get("/api/deals/:id", (c: C) => respond(c, async () => {
    const agent = await agentOf(c);
    const ag = await ownDeal(agent.id, c.req.param("id"));
    const names = await handles([ag.provider_id]);
    const live = ["active", "disputed", "settled", "closing"].includes(ag.status);
    const s = live ? await rpc<Row>("agreement_spend", { p_agreement: ag.id }) : null;
    const spend = s && {
      calls: Number(s.calls), charged_cents: Number(s.charged_cents), refunded_cents: Number(s.refunded_cents),
      pending_cents: Number(s.pending_cents), released_cents: Number(s.released_cents),
      remaining_cents: Number(s.budget_cap_cents) - (Number(s.charged_cents) - Number(s.refunded_cents)),
    };
    return { body: { ...dealOf(ag, names[ag.provider_id]), ...(spend ? { spend } : {}) } };
  }));

  server.get("/api/deals/:id/calls", (c: C) => respond(c, async () => {
    const agent = await agentOf(c);
    const ag = await ownDeal(agent.id, c.req.param("id"));
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 200) || 200, 1), 500);
    const { data } = await db.from("calls").select("id,seq,request,response,created_at,charge:charges(id,state,amount_cents)").eq("agreement_id", ag.id).order("seq", { ascending: false }).limit(limit);
    const { data: disputes } = await db.from("disputes").select("id,charge_id,scope,claim,status,response,verdict,opened_at").eq("agreement_id", ag.id).eq("scope", "micro").order("opened_at", { ascending: false });
    const refundOf = new Map<string, { refund_id: string; status: string }>(); // the newest request per charge wins
    for (const d of disputes ?? []) if (d.charge_id && isRefundRow(d) && !refundOf.has(d.charge_id)) refundOf.set(d.charge_id, { refund_id: d.id, status: refundStatusOf(d) });
    const calls = (data ?? []).map((k) => {
      const ch = (Array.isArray(k.charge) ? k.charge[0] : k.charge) as Row | undefined;
      const req = (k.request ?? {}) as Row;
      const res = (k.response ?? {}) as Row;
      const answer = (res.fields && typeof res.fields === "object" ? res.fields : res) as Row;
      return {
        call_id: k.id as string,
        charge_id: (ch?.id ?? "") as string,
        seq: Number(k.seq),
        charge_state: (ch?.state ?? "pending") as string,
        charged_cents: Number(ch?.amount_cents ?? 0),
        label: typeof answer.label === "string" ? answer.label : null,
        confidence: typeof answer.confidence === "number" ? answer.confidence : null,
        image_id: typeof req.image_id === "string" ? req.image_id : null,
        image_url: typeof req.image_id === "string" ? `${BASE_URL}/images/${req.image_id}.jpg` : typeof req.image_url === "string" ? req.image_url : null,
        created_at: k.created_at as string,
        refund: ch?.id ? (refundOf.get(ch.id) ?? null) : null,
      };
    });
    return { body: { calls } };
  }));
}
