import { type Agent, newKey, sha256 } from "../lib/auth.js";
import { createTopupApproval } from "../lib/approvals.js";
import { BASE_URL } from "../lib/env.js";
import { db, must, rpc } from "../lib/db.js";
import { MarketError } from "../lib/errors.js";

export type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Load an agreement and require the caller to be one of its parties. */
export async function agreementFor(agent: Agent, id: string): Promise<Row> {
  const ag = await must<Row>(db.from("agreements").select("*, listing:listings(id,title,capability,pricing,sla)").eq("id", id).maybeSingle(), "agreement");
  if (ag.buyer_id !== agent.id && ag.provider_id !== agent.id) {
    throw new MarketError("unauthorized", "You are not a party to this agreement.", "Use an account that is the buyer or provider.");
  }
  return ag;
}

/** Wallet balance in cents (0 when the agent has no wallet account yet). */
export async function walletCents(agentId: string): Promise<number> {
  const { data } = await db.from("ledger_accounts").select("id").eq("agent_id", agentId).eq("kind", "wallet").maybeSingle();
  return data ? await rpc<number>("account_balance", { p_account: data.id }) : 0;
}

export const TOPUP_PRESETS_CENTS = [500, 1000, 2000, 5000];
export const MAX_TOPUP_CENTS = 5000;

/** Everything the top-up card needs. Display data only: building it moves no money. */
export async function topupCard(agent: { id: string; handle: string }, opts: { needed_cents?: number; reason?: string } = {}) {
  const wallet = await walletCents(agent.id);
  const shortfall = opts.needed_cents ? Math.max(0, opts.needed_cents - wallet) : 0;
  const suggested = shortfall > 0 ? (TOPUP_PRESETS_CENTS.find((p) => p >= shortfall) ?? MAX_TOPUP_CENTS) : 1000;
  return {
    handle: agent.handle, wallet_cents: wallet, needed_cents: opts.needed_cents ?? null, suggested_cents: suggested,
    presets_cents: TOPUP_PRESETS_CENTS, max_topup_cents: MAX_TOPUP_CENTS,
    rail: (process.env.STRIPE_SECRET_KEY ? "stripe-test" : "mock") as "stripe-test" | "mock", reason: opts.reason ?? null,
    // For clients that cannot draw the card: a link the human opens in a browser to approve.
    approval_url: `${BASE_URL}/approve/topup/${createTopupApproval({ agentId: agent.id, handle: agent.handle, neededCents: opts.needed_cents ?? null, reason: opts.reason ?? null })}`,
  };
}

/** agent id -> handle, for views that show who is on each side of a deal. */
export async function handlesOf(ids: string[]): Promise<Record<string, string>> {
  const { data } = await db.from("agents").select("id,handle").in("id", ids);
  return Object.fromEntries((data ?? []).map((a) => [a.id, a.handle]));
}

export const roleIn = (agent: Agent, ag: Row) => (ag.buyer_id === agent.id ? "buyer" : "provider");

/** Spending policy set by the human principal. Defaults are deliberately small. */
export async function checkPolicy(buyerId: string, capCents: number, capability: string, excludeAgreement?: string) {
  let { data: pol } = await db.from("spending_policies").select("*").eq("agent_id", buyerId).maybeSingle();
  if (!pol) {
    await db.from("spending_policies").insert({ agent_id: buyerId });
    pol = (await db.from("spending_policies").select("*").eq("agent_id", buyerId).single()).data;
  }
  if (capCents > Number(pol.max_per_agreement_cents)) {
    throw new MarketError("policy_per_agreement", `Budget ${capCents}c exceeds your per-agreement limit of ${pol.max_per_agreement_cents}c.`, "Lower budget_cap_cents, or have your human principal raise it with set_spending_policy.");
  }
  if (pol.allowed_capabilities && !pol.allowed_capabilities.includes(capability)) {
    throw new MarketError("policy_capability", `Capability '${capability}' is not allowed by your spending policy.`, "Ask your human principal to allow it via set_spending_policy.");
  }
  let q = db.from("agreements").select("id, terms").eq("buyer_id", buyerId).in("status", ["proposed", "countered", "approved", "active", "disputed"]);
  if (excludeAgreement) q = q.neq("id", excludeAgreement);
  const { data: open } = await q;
  const committed = (open ?? []).reduce((s, a) => s + Number((a.terms as Row).budget_cap_cents ?? 0), 0);
  if (committed + capCents > Number(pol.max_total_cents)) {
    throw new MarketError("policy_total", `Open budgets ${committed}c + ${capCents}c exceed your total limit of ${pol.max_total_cents}c.`, "Close finished agreements or raise the total limit with set_spending_policy.");
  }
}

export async function createGrant(agreementId: string, capCents: number, deadline?: string) {
  const key = newKey("grant");
  const expires = deadline ? new Date(deadline) : new Date(Date.now() + 24 * 3600 * 1000);
  await db.from("access_grants").upsert({
    agreement_id: agreementId, key_hash: sha256(key), budget_cap_cents: capCents, expires_at: expires.toISOString(), revoked_at: null,
  }, { onConflict: "agreement_id" });
  return { key, expires_at: expires.toISOString() };
}

export const event = (agreementId: string, actorId: string | null, kind: string, payload: Row = {}) =>
  db.from("agreement_events").insert({ agreement_id: agreementId, actor_id: actorId, kind, payload });

export { rpc, db, must };
