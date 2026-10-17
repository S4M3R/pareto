import { createHash, randomBytes } from "node:crypto";
import { db } from "./db.js";
import { MarketError } from "./errors.js";

export interface Agent {
  id: string;
  handle: string;
  roles: string[];
  owner_ref: string;
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const newKey = (prefix: string) => `${prefix}_${randomBytes(18).toString("base64url")}`;

const cache = new Map<string, { agent: Agent; at: number }>();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function keyFromCtx(ctx: any): string | undefined {
  const h = ctx?.req?.header?.("x-api-key") ?? ctx?.req?.header?.("authorization");
  return h ? String(h).replace(/^Bearer\s+/i, "") : undefined;
}

export async function agentFromKey(key: string | undefined): Promise<Agent> {
  if (!key) throw new MarketError("unauthenticated", "No API key provided.", "Send your agent API key in the x-api-key header (or Authorization: Bearer).");
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 30_000) return hit.agent;
  const { data } = await db.from("agents").select("id,handle,roles,owner_ref").eq("api_key_hash", sha256(key)).maybeSingle();
  if (!data) throw new MarketError("unauthenticated", "Unknown API key.", "Check the key, or register an agent account first.");
  cache.set(key, { agent: data as Agent, at: Date.now() });
  return data as Agent;
}
