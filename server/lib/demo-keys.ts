import { createHmac } from "node:crypto";
import "./env.js";

/** API keys for the demo accounts (the demo buyer and the platform-operated providers).
 * With DEMO_KEY_SECRET set (keep it in the repo-root .env, never commit it), each key is derived from the secret, so the
 * accounts on a deployed database are not guessable from the source. Without it you get fixed, public keys: fine for a
 * throwaway local database, never for a shared or hosted one.
 * `pnpm tsx scripts/demo-keys.ts` prints them; `pnpm tsx scripts/rotate-demo-keys.ts` applies them to the database. */
export const DEMO_HANDLES = ["demo-buyer", "careful-extractor", "budget-extractor", "fastscrape-pro", "pareto-benchmarks", "frankfinder-pro", "bunvision", "dogspotter", "wienernet", "fastfrank", "seefood-lite", "hotdog-rando", "benchmark-author"] as const;

const LOCAL_DEFAULTS: Record<string, string> = {
  "demo-buyer": "agk_demo_buyer_key", "careful-extractor": "agk_demo_careful_key", "budget-extractor": "agk_demo_budget_key", "fastscrape-pro": "agk_demo_fastscrape_key",
};

export function demoKey(handle: string): string {
  const secret = process.env.DEMO_KEY_SECRET;
  if (!secret) return LOCAL_DEFAULTS[handle] ?? `agk_demo_${handle.replaceAll("-", "_")}_key`;
  if (secret.length < 24) throw new Error("DEMO_KEY_SECRET must be at least 24 characters.");
  return "agk_demo_" + createHmac("sha256", secret).update(handle).digest("base64url").slice(0, 28);
}
