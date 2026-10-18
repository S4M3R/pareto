import { z } from "zod";
import { createAgent } from "../lib/auth.js";
import { ListingInputSchema } from "../lib/inputs.js";
import { createListing } from "../lib/listings.js";
import { MarketError } from "../lib/errors.js";
import { type Row, db, must, rpc } from "./common.js";
import { WhoamiOut } from "../lib/schemas.js";
import { type AnyServer, defineTool } from "./define.js";

export function registerAccount(server: AnyServer) {
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
    const key = await createAgent(a);
    return { data: { handle: a.handle, roles: a.roles, api_key: key, note: "Store this key now; it is never shown again." }, next: a.roles.includes("buyer") ? "show_topup_card so your human can add funds, then search_benchmarks." : "register_listing." };
  });

  defineTool(server, {
    name: "sign_in",
    description: "Sign in to Pareto. If you are not signed in, calling this prompts the sign-in for your human; once signed in it confirms which agent account you act as. Use it first when other tools say you are not signed in.",
    input: z.object({}),
    readOnly: true,
    signIn: true,
  }, async (_a, agent) => ({
    data: { signed_in: true, handle: agent!.handle, roles: agent!.roles },
    next: "whoami for your wallet and limits, then search_benchmarks.",
  }));

  defineTool(server, {
    name: "whoami",
    description: "Your account: handle, roles, wallet balance, earnings, spending policy, and open agreements. A good first call to confirm your key works.",
    input: z.object({}),
    readOnly: true,
    show: {
      name: "show_wallet",
      description: "Display only: shows the human a wallet card (balance, earnings, spending limits). Use it when they ask to see their wallet; for your own check use whoami.",
      view: { name: "wallet-strip", description: "Wallet, earnings, spending policy and open agreements" },
      output: WhoamiOut,
    },
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
    description: "Provider: list a capability you offer through an HTTP endpoint. The endpoint URL is private: buyers only ever reach you through the platform gateway, and it must be a public https URL. The listing is not ranked until the platform scores it: call run_benchmark next. Contract for image-classification endpoints: POST {image_base64, mime} (or {image_url}) and answer {label, confidence, units_billed: 1}.",
    input: ListingInputSchema,
    role: "provider",
  }, async (a, agent) => ({
    data: await createListing(agent!, a),
    next: "list_benchmarks for this capability, then run_benchmark with the listing_id and a benchmark_id.",
  }));
}
