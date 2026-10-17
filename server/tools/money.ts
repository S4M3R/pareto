import type { MCPServer } from "mcp-use";
import { z } from "zod";
import { topupViaRail } from "../lib/payments.js";
import { type Row, db, rpc } from "./common.js";
import { defineTool } from "./define.js";

export function registerMoney(server: MCPServer) {
  defineTool(server, {
    name: "topup_wallet",
    description: "Add funds to your wallet (test mode only: Stripe test card if configured, otherwise a labelled mock rail). Max 5000 cents per call.",
    input: z.object({ amount_cents: z.number().int().min(1).max(5000), idempotency_key: z.string().min(6).max(64).optional() }),
    role: "buyer",
  }, async (a, agent) => {
    const r = await topupViaRail(agent!.id, a.amount_cents, a.idempotency_key ?? crypto.randomUUID());
    return { data: r, next: "propose_agreement, then fund_escrow." };
  });

  defineTool(server, {
    name: "set_spending_policy",
    description: "Limits the human principal places on this agent, enforced server-side before any agreement is proposed or funded: max per agreement, max total across open agreements, and optionally which capabilities may be bought.",
    input: z.object({
      max_per_agreement_cents: z.number().int().min(0), max_total_cents: z.number().int().min(0),
      allowed_capabilities: z.array(z.string()).optional(),
    }),
    role: "buyer",
    idempotent: true,
  }, async (a, agent) => {
    await db.from("spending_policies").upsert({
      agent_id: agent!.id, max_per_agreement_cents: a.max_per_agreement_cents, max_total_cents: a.max_total_cents,
      allowed_capabilities: a.allowed_capabilities ?? null, updated_at: new Date().toISOString(),
    });
    return { data: { policy: a } };
  });

  defineTool(server, {
    name: "get_ledger",
    description: "Money movements with reasons: your wallet and earnings, plus the escrow of an agreement if you pass agreement_id. Every movement shows why it happened and the evidence behind it. Balances are derived from these entries.",
    input: z.object({ agreement_id: z.string().uuid().optional(), limit: z.number().int().min(1).max(60).default(25) }),
    readOnly: true,
  }, async (a, agent) => {
    const { data: own } = await db.from("ledger_accounts").select("id,kind").eq("agent_id", agent!.id);
    const accounts = [...(own ?? [])];
    if (a.agreement_id) {
      const { data: ag } = await db.from("agreements").select("buyer_id,provider_id").eq("id", a.agreement_id).maybeSingle();
      if (ag && (ag.buyer_id === agent!.id || ag.provider_id === agent!.id)) {
        const { data: esc } = await db.from("ledger_accounts").select("id,kind").eq("agreement_id", a.agreement_id).eq("kind", "escrow");
        accounts.push(...(esc ?? []));
      }
    }
    const kind = Object.fromEntries(accounts.map((x) => [x.id, x.kind]));
    const balances: Record<string, number> = {};
    for (const x of accounts) balances[`${x.kind}${x.kind === "escrow" ? ":" + a.agreement_id?.slice(0, 8) : ""}`] = await rpc<number>("account_balance", { p_account: x.id });
    let q = db.from("ledger_entries").select("created_at,account_id,amount_cents,kind,reason,evidence").in("account_id", accounts.map((x) => x.id)).order("id", { ascending: false }).limit(a.limit);
    if (a.agreement_id) q = q.eq("agreement_id", a.agreement_id);
    const { data } = await q;
    const entries = (data ?? []).map((e: Row) => ({ at: e.created_at, account: kind[e.account_id], cents: e.amount_cents, kind: e.kind, reason: e.reason, evidence: e.evidence }));
    return { data: { balances_cents: balances, entries } };
  });
}
