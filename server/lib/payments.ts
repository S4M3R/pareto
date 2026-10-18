import { defaultCard } from "./cards.js";
import { rpc } from "./db.js";
import { MarketError } from "./errors.js";

/** Funding rail for wallet top-ups. The internal ledger is the source of truth; Stripe (test mode only) is the rail.
 * Without STRIPE_SECRET_KEY the rail is a clearly labelled mock, so the whole flow still runs. */
export async function topupViaRail(agentId: string, cents: number, idempotencyKey: string) {
  const sk = process.env.STRIPE_SECRET_KEY;
  let rail = "mock";
  let ref = "mock:" + idempotencyKey;
  let cardLabel = "";
  if (sk) {
    if (!/^(sk|rk|rkcs)_test_/.test(sk)) throw new MarketError("unsafe_key", "Refusing to use a non-test Stripe key.", "Set STRIPE_SECRET_KEY to a test-mode key (sk_test_..., rk_test_... or a claimable-sandbox rkcs_test_...).");
    // The person's own saved card when they have added one; otherwise the Stripe test card, as before.
    const card = await defaultCard(agentId);
    cardLabel = card ? ` (${card.brand} ****${card.last4})` : " (default test card)";
    const body = new URLSearchParams({
      amount: String(cents), currency: "usd", confirm: "true",
      ...(card
        ? { customer: card.stripe_customer_id, payment_method: card.stripe_pm_id, off_session: "true" }
        : { payment_method: "pm_card_visa", "automatic_payment_methods[enabled]": "true", "automatic_payment_methods[allow_redirects]": "never" }),
      description: "Pareto wallet top-up (test mode)",
    });
    const r = await fetch("https://api.stripe.com/v1/payment_intents", {
      method: "POST",
      headers: { Authorization: `Bearer ${sk}`, "Content-Type": "application/x-www-form-urlencoded", "Idempotency-Key": idempotencyKey },
      body,
    });
    const pi = (await r.json()) as { id?: string; status?: string; error?: { message: string; type?: string } };
    if (pi.error?.type === "idempotency_error") throw new MarketError("in_progress", "That top-up is already being processed.", "Wait a few seconds; your balance updates when it finishes.");
    if (!r.ok || pi.status !== "succeeded") throw new MarketError("payment_failed", pi.error?.message ?? `Stripe returned ${pi.status}`, "Check the Stripe test key and try again.");
    rail = "stripe-test";
    ref = pi.id!;
  }
  const balance = await rpc<number>("topup", { p_agent: agentId, p_cents: cents, p_key: `topup:${idempotencyKey}`, p_ref: `${rail}:${ref}${cardLabel}` });
  return { rail, ref, wallet_cents: balance };
}
