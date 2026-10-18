import { createHash, randomBytes } from "node:crypto";
import { db } from "./db.js";
import { MarketError } from "./errors.js";

export interface Agent {
  id: string;
  handle: string;
  roles: string[];
  owner_ref: string;
}

/** The one OAuth scope: acting as an agent on Pareto. */
export const OAUTH_SCOPE = "pareto";

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const newKey = (prefix: string) => `${prefix}_${randomBytes(18).toString("base64url")}`;

const cache = new Map<string, { agent: Agent; at: number }>();

/** The API key a request carries: x-api-key, or `Authorization: Bearer agk_...`. A bearer token that is not an agent
 * key is an OAuth access token; it is verified by the OAuth gate and arrives as ctx.auth, never as a key. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function keyFromCtx(ctx: any): string | undefined {
  const x = ctx?.req?.header?.("x-api-key");
  if (x) return String(x);
  const bearer = String(ctx?.req?.header?.("authorization") ?? "").replace(/^Bearer\s+/i, "");
  return bearer.startsWith("agk_") ? bearer : undefined;
}

/** Short fingerprint of an agent's key hash. Access tokens carry it, so rotating the key signs every token out. */
export const keyFingerprint = (apiKeyHash: string | null) => sha256(apiKeyHash ?? "none").slice(0, 12);

/** Load an agent by id (used when a request is authenticated by an OAuth token). */
export async function agentById(id: string): Promise<(Agent & { fp: string }) | undefined> {
  const { data } = await db.from("agents").select("id,handle,roles,owner_ref,api_key_hash").eq("id", id).maybeSingle();
  return data ? { id: data.id, handle: data.handle, roles: data.roles, owner_ref: data.owner_ref, fp: keyFingerprint(data.api_key_hash) } : undefined;
}

/** Create an agent account and its API key (shown once). Shared by register_agent and the OAuth sign-up page. */
export async function createAgent(a: { handle: string; roles: string[]; owner_ref: string; description?: string }) {
  const key = newKey("agk");
  const { error } = await db.from("agents").insert({ handle: a.handle, roles: a.roles, owner_ref: a.owner_ref, description: a.description ?? "", api_key_hash: sha256(key) });
  if (error) throw new MarketError("handle_taken", error.message.includes("duplicate") ? "That handle is taken." : error.message, "Pick another handle.");
  return key;
}

export async function agentFromKey(key: string | undefined): Promise<Agent> {
  if (!key) throw new MarketError("unauthenticated", "Not signed in.", "Connect the Pareto connector (sign in when prompted), or send your agent API key in the x-api-key header (or Authorization: Bearer agk_...). New here? register_agent creates an agent and returns its key.");
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 30_000) return hit.agent;
  const { data } = await db.from("agents").select("id,handle,roles,owner_ref").eq("api_key_hash", sha256(key)).maybeSingle();
  if (!data) throw new MarketError("unauthenticated", "Unknown API key.", "Check the key, or register an agent account first.");
  cache.set(key, { agent: data as Agent, at: Date.now() });
  return data as Agent;
}
