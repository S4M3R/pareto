import type { Agent } from "./auth.js";
import { knownCapabilities } from "./capabilities.js";
import { db, must } from "./db.js";
import { assertPublicUrl } from "./endpoints.js";
import { MarketError } from "./errors.js";

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface ListingInput {
  title: string;
  capability: string;
  kind: "agent" | "mcp" | "llm" | "api";
  endpoint_url: string;
  price_cents_per_call: number;
  max_latency_ms?: number;
}

/** One place that creates a listing, used by the MCP tool and the REST API alike. */
export async function createListing(agent: Agent, a: ListingInput, opts: { seeded?: boolean } = {}) {
  if (!agent.roles.includes("provider")) throw new MarketError("wrong_role", `${agent.handle} is not a provider.`, "Use an account with the provider role (register_agent with roles [\"provider\"]).");
  if (!knownCapabilities().includes(a.capability)) {
    throw new MarketError("unsupported_capability", `'${a.capability}' is not a capability the platform can meter and check yet.`, `Supported capabilities: ${knownCapabilities().join(", ")}.`);
  }
  if (a.title.trim().length < 3 || a.title.length > 80) throw new MarketError("bad_input", "title must be 3 to 80 characters.", "Shorten or lengthen the title.");
  if (!Number.isInteger(a.price_cents_per_call) || a.price_cents_per_call < 1) throw new MarketError("bad_input", "price_cents_per_call must be a whole number of cents, at least 1.", "Prices are integer cents.");
  const url = assertPublicUrl(a.endpoint_url);
  const l = await must<Row>(db.from("listings").insert({
    provider_id: agent.id, title: a.title.trim(), capability: a.capability, kind: a.kind, endpoint_type: "http", endpoint_url: url.href,
    pricing: { model: "per_call", amount_cents: a.price_cents_per_call }, sla: { p95_ms: a.max_latency_ms ?? 3000 }, seeded: opts.seeded ?? false,
  }).select("id,title,capability,kind,pricing,sla,created_at").single(), "listing");
  return {
    listing_id: l.id as string, title: l.title as string, capability: l.capability as string, kind: l.kind as string,
    price_cents_per_call: Number(l.pricing.amount_cents), max_latency_ms: Number(l.sla.p95_ms),
    note: "Not ranked until the platform scores it: run_benchmark with a benchmark for this capability.",
  };
}

/** Public view of active listings. The provider's endpoint URL is never included. */
export async function listListings(f: { capability?: string; mine?: string } = {}) {
  let q = db.from("listings").select("id,provider_id,title,capability,kind,pricing,sla,seeded,created_at").eq("active", true).order("created_at", { ascending: false }).limit(100);
  if (f.capability) q = q.eq("capability", f.capability);
  if (f.mine) q = q.eq("provider_id", f.mine);
  const { data } = await q;
  const ids = [...new Set((data ?? []).map((l) => l.provider_id))];
  const { data: agents } = ids.length ? await db.from("agents").select("id,handle").in("id", ids) : { data: [] };
  const handle = Object.fromEntries((agents ?? []).map((a) => [a.id, a.handle]));
  return (data ?? []).map((l) => ({
    listing_id: l.id as string, provider: handle[l.provider_id] as string, title: l.title as string, capability: l.capability as string, kind: l.kind as string,
    price_cents_per_call: Number((l.pricing as Row).amount_cents), max_latency_ms: Number((l.sla as Row).p95_ms ?? 0), platform_operated: Boolean(l.seeded),
  }));
}
