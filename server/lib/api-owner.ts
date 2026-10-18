import { db, rpc } from "./db.js";
import { agentOf, respond } from "./api.js";
import { ownerPage } from "./console-owner-page.js";
import { REFERRAL_PCT } from "./referrals.js";
import { createSessionToken } from "./session.js";
import { BASE_URL } from "./env.js";
import type { AnyServer } from "../tools/define.js";

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type C = any;

/** What a benchmark owner sees: who uses each benchmark, what they spent, and the referral income it produced. */
export async function ownerStats(ownerId: string) {
  const { data: bms } = await db.from("benchmarks").select("id,slug,title,category,n_test,created_at,seeded").eq("owner_id", ownerId).order("created_at", { ascending: false });
  const { data: acct } = await db.from("ledger_accounts").select("id").eq("agent_id", ownerId).eq("kind", "earnings").maybeSingle();
  const balance = acct ? await rpc<number>("account_balance", { p_account: acct.id }) : 0;
  const out: Row[] = [];
  for (const b of bms ?? []) {
    const usage = await rpc<Row>("benchmark_usage", { p_benchmark: b.id });
    const recent = await rpc<Row[]>("benchmark_recent", { p_benchmark: b.id, p_limit: 8 });
    out.push({
      benchmark_id: b.id, slug: b.slug, title: b.title, category: b.category, n_test: b.n_test, created_at: b.created_at,
      hires: Number(usage.hires), agents: Number(usage.agents), spend_cents: Number(usage.spend_cents), earned_cents: Number(usage.earned_cents),
      recent: (recent ?? []).map((r) => ({ agent: r.agent, at: r.at, status: r.status, spend_cents: Number(r.spend_cents), referral_cents: Number(r.referral_cents) })),
    });
  }
  return { referral_pct: REFERRAL_PCT, earnings_balance_cents: Number(balance), earned_total_cents: out.reduce((s, b) => s + b.earned_cents, 0), benchmarks: out };
}

export function registerOwnerApi(server: AnyServer) {
  server.get("/api/owner/benchmarks", (c: C) => respond(c, async () => {
    const agent = await agentOf(c);
    return { body: { owner: agent.handle, ...(await ownerStats(agent.id)) } };
  }));
  // A sign-in link for the web console, issued to whoever proves they hold the agent's API key (the key stays out of the URL).
  server.post("/api/console-link", (c: C) => respond(c, async () => {
    const agent = await agentOf(c);
    const t = encodeURIComponent(await createSessionToken(agent.id, 24));
    return { body: { agent: agent.handle, expires_in_hours: 24, benchmarks_url: `${BASE_URL}/console/benchmarks?t=${t}`, refunds_url: `${BASE_URL}/console/refunds?t=${t}` } };
  }));
  server.get("/console/benchmarks", (c: C) => c.html(ownerPage));
  // one link for both consoles: sends the signed-in person to their benchmarks, keeping the session token
  server.get("/console", (c: C) => c.html(`<!doctype html><meta charset="utf-8"><script>location.replace("/console/benchmarks"+location.search)</script>`));
}
