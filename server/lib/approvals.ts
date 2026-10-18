import { randomBytes } from "node:crypto";

/** A human approval link for adding funds. The agent can only create the link; money moves when a person opens it in a
 * browser and clicks. Works in any client, because it does not depend on the host being able to draw a card.
 * Held in memory with a short life: a restart or an expiry just means asking for a fresh link. */
export interface TopupApproval {
  agentId: string;
  handle: string;
  neededCents: number | null;
  reason: string | null;
  expires: number;
  /** Last amount added through this link. */
  doneCents?: number;
  /** How many top-ups this link has made, so each attempt has its own idempotency key. */
  adds?: number;
}

const store = new Map<string, TopupApproval>();
const TTL_MS = 30 * 60 * 1000;

export function createTopupApproval(a: Omit<TopupApproval, "expires">): string {
  const now = Date.now();
  for (const [k, v] of store) if (v.expires < now) store.delete(k);
  if (store.size > 500) store.delete(store.keys().next().value as string);
  const token = randomBytes(18).toString("base64url");
  store.set(token, { ...a, expires: now + TTL_MS });
  return token;
}

export const getTopupApproval = (token: string): TopupApproval | undefined => {
  const a = store.get(token);
  return a && a.expires > Date.now() ? a : undefined;
};

/** The same idea for adding a card: the agent can only mint the link; the human opens it and enters the card on Stripe. */
export interface CardApproval { agentId: string; handle: string; expires: number }

const cardStore = new Map<string, CardApproval>();

export function createCardApproval(a: Omit<CardApproval, "expires">): string {
  const now = Date.now();
  for (const [k, v] of cardStore) if (v.expires < now) cardStore.delete(k);
  if (cardStore.size > 500) cardStore.delete(cardStore.keys().next().value as string);
  const token = randomBytes(18).toString("base64url");
  cardStore.set(token, { ...a, expires: now + TTL_MS });
  return token;
}

export const getCardApproval = (token: string): CardApproval | undefined => {
  const a = cardStore.get(token);
  return a && a.expires > Date.now() ? a : undefined;
};
