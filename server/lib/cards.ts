import { db } from "./db.js";
import { BASE_URL } from "./env.js";
import { MarketError } from "./errors.js";

/** Cards on file, test mode only. Stripe's hosted Checkout (setup mode) collects the card, so the number never reaches
 * this server or any agent. We store Stripe ids plus display data (brand, last four, expiry). */

function secretKey(): string {
  const sk = process.env.STRIPE_SECRET_KEY;
  if (!sk) throw new MarketError("stripe_not_configured", "Cards need a Stripe test key on the server.", "Set STRIPE_SECRET_KEY to a test-mode key and redeploy.");
  if (!/^(sk|rk|rkcs)_test_/.test(sk)) throw new MarketError("unsafe_key", "Refusing to use a non-test Stripe key.", "Set STRIPE_SECRET_KEY to a test-mode key.");
  return sk;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function stripe(method: "GET" | "POST", path: string, params?: Record<string, string>, idem?: string): Promise<any> {
  const r = await fetch(`https://api.stripe.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${secretKey()}`,
      ...(method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      ...(idem ? { "Idempotency-Key": idem } : {}),
    },
    body: method === "POST" ? new URLSearchParams(params ?? {}) : undefined,
  });
  const j = await r.json();
  if (!r.ok) throw new MarketError("stripe_error", j?.error?.message ?? `Stripe returned ${r.status}`, "Try again; if it persists, check the Stripe test key.");
  return j;
}

export interface Card {
  id: string;
  brand: string;
  last4: string;
  exp_month: number | null;
  exp_year: number | null;
  is_default: boolean;
}

const COLS = "id,brand,last4,exp_month,exp_year,is_default";

export async function listCards(agentId: string): Promise<Card[]> {
  const { data } = await db.from("payment_methods").select(COLS).eq("agent_id", agentId).is("removed_at", null).order("created_at", { ascending: false });
  return (data ?? []) as Card[];
}

export async function defaultCard(agentId: string): Promise<(Card & { stripe_pm_id: string; stripe_customer_id: string }) | null> {
  const { data: pm } = await db.from("payment_methods").select(`${COLS},stripe_pm_id`).eq("agent_id", agentId).eq("is_default", true).is("removed_at", null).maybeSingle();
  if (!pm) return null;
  const { data: cust } = await db.from("payment_customers").select("stripe_customer_id").eq("agent_id", agentId).maybeSingle();
  return cust ? ({ ...pm, stripe_customer_id: cust.stripe_customer_id } as never) : null;
}

async function ensureCustomer(agent: { id: string; handle: string }): Promise<string> {
  const { data } = await db.from("payment_customers").select("stripe_customer_id").eq("agent_id", agent.id).maybeSingle();
  if (data) return data.stripe_customer_id;
  const c = await stripe("POST", "/customers", { name: agent.handle, "metadata[pareto_agent_id]": agent.id, description: "Pareto agent account (test mode)" }, `pareto-customer:${agent.id}`);
  await db.from("payment_customers").upsert({ agent_id: agent.id, stripe_customer_id: c.id });
  return c.id;
}

/** Create the Stripe-hosted page where the human types the card. `token` brings them back to the right approval page. */
export async function startAddCard(agent: { id: string; handle: string }, token: string): Promise<{ url: string }> {
  const customer = await ensureCustomer(agent);
  const s = await stripe("POST", "/checkout/sessions", {
    mode: "setup", customer, currency: "usd",
    success_url: `${BASE_URL}/approve/card/${token}/return?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${BASE_URL}/approve/card/${token}`,
    "metadata[pareto_agent_id]": agent.id,
  });
  return { url: s.url };
}

/** After Stripe sends the person back: verify the session is theirs and complete, then record the card. Idempotent. */
export async function finishAddCard(agentId: string, sessionId: string): Promise<Card> {
  if (!/^cs_test_[A-Za-z0-9]+$/.test(sessionId)) throw new MarketError("bad_session", "That is not a test-mode Checkout session.", "Start again from your agent's add_card link.");
  const s = await stripe("GET", `/checkout/sessions/${sessionId}?expand[]=setup_intent.payment_method`);
  const { data: cust } = await db.from("payment_customers").select("stripe_customer_id").eq("agent_id", agentId).maybeSingle();
  if (!cust || s.customer !== cust.stripe_customer_id) throw new MarketError("wrong_account", "This card setup belongs to a different account.", "Open the link your own agent gave you.");
  if (s.livemode) throw new MarketError("unsafe_key", "Refusing a live-mode session.", "Use Stripe test mode.");
  if (s.status !== "complete" || s.setup_intent?.status !== "succeeded") throw new MarketError("not_completed", "The card was not saved.", "Try adding it again.");
  const pm = s.setup_intent.payment_method;
  if (!pm?.card) throw new MarketError("not_a_card", "Only cards are supported.", "Add a card.");
  const { data: existing } = await db.from("payment_methods").select(COLS).eq("stripe_pm_id", pm.id).is("removed_at", null).maybeSingle();
  if (existing) return existing as Card;
  const first = (await listCards(agentId)).length === 0;
  const { data, error } = await db.from("payment_methods").insert({
    agent_id: agentId, stripe_pm_id: pm.id, brand: pm.card.brand, last4: pm.card.last4,
    exp_month: pm.card.exp_month, exp_year: pm.card.exp_year, is_default: first,
  }).select(COLS).single();
  if (error) throw new MarketError("database_error", error.message);
  return data as Card;
}

export async function setDefaultCard(agentId: string, cardId: string): Promise<void> {
  const { data } = await db.from("payment_methods").select("id").eq("id", cardId).eq("agent_id", agentId).is("removed_at", null).maybeSingle();
  if (!data) throw new MarketError("unknown_card", "No such card on this account.", "list_cards shows the cards on file.");
  await db.from("payment_methods").update({ is_default: false }).eq("agent_id", agentId).eq("is_default", true);
  await db.from("payment_methods").update({ is_default: true }).eq("id", cardId);
}

export async function removeCard(agentId: string, cardId: string): Promise<void> {
  const { data: row } = await db.from("payment_methods").select("id,stripe_pm_id,is_default").eq("id", cardId).eq("agent_id", agentId).is("removed_at", null).maybeSingle();
  if (!row) throw new MarketError("unknown_card", "No such card on this account.", "list_cards shows the cards on file.");
  await stripe("POST", `/payment_methods/${row.stripe_pm_id}/detach`);
  await db.from("payment_methods").update({ removed_at: new Date().toISOString(), is_default: false }).eq("id", cardId);
  if (row.is_default) {
    const next = (await listCards(agentId))[0];
    if (next) await db.from("payment_methods").update({ is_default: true }).eq("id", next.id);
  }
}

export const brandName = (b: string) => (b ? b[0].toUpperCase() + b.slice(1) : "Card");
