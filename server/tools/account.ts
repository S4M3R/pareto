import type { MCPServer } from "mcp-use";
import { z } from "zod";
import { newKey, sha256 } from "../lib/auth.js";
import { MarketError } from "../lib/errors.js";
import { type Row, db, must, rpc } from "./common.js";
import { defineTool } from "./define.js";

export function registerAccount(server: MCPServer) {
  defineTool(server, {
    name: "register_agent",
    description: "Create an agent account and receive its API key (shown once). Roles: buyer, provider, or both. owner_ref names the human principal responsible for this agent. Send the key as x-api-key on every later call.",
    input: z.object({
      handle: z.string().regex(/^[a-z0-9][a-z0-9_-]{1,38}$/).describe("lowercase handle, e.g. acme-research-bot"),
      roles: z.array(z.enum(["buyer", "provider"])).min(1), owner_ref: z.string().min(2).describe("The human or org responsible for this agent"),
      description: z.string().max(300).default(""),
    }),
    auth: false,
  }, async (a) => {
    const key = newKey("agk");
    const { error } = await db.from("agents").insert({ handle: a.handle, roles: a.roles, owner_ref: a.owner_ref, description: a.description, api_key_hash: sha256(key) });
    if (error) throw new MarketError("handle_taken", error.message.includes("duplicate") ? "That handle is taken." : error.message, "Pick another handle.");
    return { data: { handle: a.handle, roles: a.roles, api_key: key, note: "Store this key now; it is never shown again." }, next: a.roles.includes("buyer") ? "topup_wallet, then search_benchmarks." : "register_listing." };
  });

  defineTool(server, {
    name: "whoami",
    description: "Your account: handle, roles, wallet balance, earnings, spending policy, and open agreements. A good first call to confirm your key works.",
    input: z.object({}),
    readOnly: true,
  }, async (_a, agent) => {
    const bal = async (kind: string) => {
      const { data } = await db.from("ledger_accounts").select("id").eq("agent_id", agent!.id).eq("kind", kind).maybeSingle();
      return data ? await rpc<number>("account_balance", { p_account: data.id }) : 0;
    };
    const { data: pol } = await db.from("spending_policies").select("max_per_agreement_cents,max_total_cents,allowed_capabilities").eq("agent_id", agent!.id).maybeSingle();
    const { data: open } = await db.from("agreements").select("id,status").or(`buyer_id.eq.${agent!.id},provider_id.eq.${agent!.id}`).in("status", ["proposed", "countered", "approved", "active", "disputed"]);
    return { data: { handle: agent!.handle, roles: agent!.roles, wallet_cents: await bal("wallet"), earnings_cents: await bal("earnings"), spending_policy: pol ?? "default (small) limits", open_agreements: open ?? [] },
      next: agent!.roles.includes("provider") ? "list_requests to see proposals." : "search_benchmarks to find a capability." };
  });

  defineTool(server, {
    name: "register_listing",
    description: "Provider: list a capability you offer through an HTTP endpoint. The endpoint URL is private: buyers only ever reach you through the platform gateway. Submitted listings are queued for verified benchmark runs.",
    input: z.object({
      title: z.string().min(3), capability: z.string().min(3).describe("e.g. profile-extraction"),
      kind: z.enum(["agent", "mcp", "llm", "api"]), endpoint_url: z.string().url(),
      price_cents_per_call: z.number().int().positive(), max_latency_ms: z.number().int().positive().default(3000),
    }),
    role: "provider",
  }, async (a, agent) => {
    const l = await must<Row>(db.from("listings").insert({
      provider_id: agent!.id, title: a.title, capability: a.capability, kind: a.kind, endpoint_type: "http", endpoint_url: a.endpoint_url,
      pricing: { model: "per_call", amount_cents: a.price_cents_per_call }, sla: { p95_ms: a.max_latency_ms },
    }).select("id").single(), "listing");
    return { data: { listing_id: l.id, note: "Not ranked until a verified benchmark run completes." }, next: "list_requests to see proposals once buyers find you." };
  });
}
