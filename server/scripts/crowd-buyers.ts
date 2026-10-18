/** Real scripted buyers that use the author's benchmark to choose a provider, run real calls through the gateway, and settle.
 * Each hire cites the benchmark (benchmark_id), so at close the platform pays its owner 5% of what was spent.
 * The buyers are labelled demo agents (seeded, owner_ref "demo-crowd"); their wallets are topped up with test money.
 * Usage: MCP=http://localhost:3100/mcp pnpm tsx scripts/crowd-buyers.ts [--benchmark <slug or id>] [--images live|pet] [--target-cents 1000] [--buyers 8] [--cap 1000]
 *   --benchmark  slug or id; the target counts what THAT benchmark earned, not the owner's total.
 *   --images     which photos the buyers classify: live (hot dogs, default) or pet (cats and dogs, for a cat or dog benchmark). */
import "../lib/env.js";
import { sha256 } from "../lib/auth.js";
import { db, rpc } from "../lib/db.js";
import { demoKey } from "../lib/demo-keys.js";
import { ownerStats } from "../lib/api-owner.js";

const flag = (n: string, d: string) => { const i = process.argv.indexOf("--" + n); return i > 0 ? process.argv[i + 1] : d; };
const MCP = process.env.MCP ?? "http://localhost:3100/mcp";
const BASE = process.env.BASE ?? new URL(MCP).origin;
const SLUG = flag("benchmark", "street-hotdogs-v1");
const IMAGES = flag("images", "live");
const TARGET = Number(flag("target-cents", "1000"));
const BUYERS = Number(flag("buyers", "8"));
const CAP = Number(flag("cap", "1000"));
const CONCURRENCY = 3; // modest: these are real calls to a small server, and latency is one of the checks
type R = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
let rid = 1;

async function tool(key: string, name: string, args: R = {}): Promise<R> {
  const res = await fetch(MCP, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-api-key": key }, body: JSON.stringify({ jsonrpc: "2.0", id: rid++, method: "tools/call", params: { name, arguments: args } }) });
  const t = await res.text();
  const line = t.split("\n").find((l) => l.startsWith("data:"));
  const r = (line ? JSON.parse(line.slice(5)) : JSON.parse(t)).result;
  const out = r.structuredContent ?? JSON.parse(r.content[0].text);
  if (r.isError) throw new Error(`${name}: ${JSON.stringify(out)}`);
  return out;
}

async function ensureBuyer(handle: string) {
  const key = demoKey(handle);
  const { data } = await db.from("agents").upsert({ handle, roles: ["buyer"], owner_ref: "demo-crowd", description: "Scripted demo buyer: hires through published benchmarks (labelled demo traffic).", seeded: true, api_key_hash: sha256(key) }, { onConflict: "handle" }).select("id").single();
  await db.from("spending_policies").upsert({ agent_id: data!.id, max_per_agreement_cents: CAP, max_total_cents: CAP * 2, allowed_capabilities: null, updated_at: new Date().toISOString() });
  return { id: data!.id as string, key, handle };
}

async function oneHire(b: { id: string; key: string; handle: string }, benchmarkId: string, n: number) {
  await rpc("topup", { p_agent: b.id, p_cents: CAP, p_key: `crowd:${b.handle}:${Date.now()}:${n}`, p_ref: "demo-crowd" });
  const ranked = await tool(b.key, "find_providers", { benchmark_id: benchmarkId });
  const pool = (ranked.providers as R[]).filter((p) => p.quality >= 0.6);
  const pick = pool[n % pool.length];
  const task = await tool(b.key, "create_task", { title: "Hot dog or not", description: "Classify street photos as hotdog or not_hotdog." });
  const ag = await tool(b.key, "propose_agreement", { task_id: task.task_id, listing_id: pick.listing_id, budget_cap_cents: CAP, check_window_s: 30, sample_rate: 0.3, max_latency_ms: 4000, benchmark_id: benchmarkId });
  for (let i = 0; i < 60; i++) { // a demo provider's proposal is approved by the server within a couple of seconds
    const s = await tool(b.key, "get_agreement", { agreement_id: ag.agreement_id });
    if (s.status === "approved") break;
    if (i === 59) throw new Error("proposal was not approved");
    await new Promise((r) => setTimeout(r, 1000));
  }
  await tool(b.key, "fund_escrow", { agreement_id: ag.agreement_id });
  const imgs: R[] = IMAGES === "pet" ? Array.from({ length: 100 }, (_, i) => ({ image_id: `pet-${String(i + 1).padStart(3, "0")}` })) : ((await tool(b.key, "list_sample_images", { limit: 50 })).images as R[]);
  let done = false, i = 0, calls = 0;
  const worker = async () => {
    while (!done) {
      const im = imgs[i++ % imgs.length];
      const r = await fetch(`${BASE}/gw/${ag.agreement_id}/call`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": b.key }, body: JSON.stringify({ image_id: im.image_id }) });
      if (r.status === 402) { done = true; break; }
      if (!r.ok) { done = true; break; }
      calls++;
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  await tool(b.key, "close_task", { agreement_id: ag.agreement_id });
  console.log(`  ${b.handle} hired ${pick.provider}: ${calls} calls, closed`);
}

const isId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(SLUG);
const { data: bm } = await db.from("benchmarks").select("id,owner_id,slug").eq(isId ? "id" : "slug", SLUG).maybeSingle();
if (!bm) { console.error(`benchmark ${SLUG} not found; run the seed first`); process.exit(1); }
const earned = async () => ((await ownerStats(bm.owner_id)).benchmarks.find((b: { benchmark_id: string }) => b.benchmark_id === bm.id)?.earned_cents ?? 0) as number;
const buyers = await Promise.all(Array.from({ length: BUYERS }, (_, i) => ensureBuyer(`demo-crowd-${String(i + 1).padStart(2, "0")}`)));
console.log(`target $${(TARGET / 100).toFixed(2)} in referrals through ${bm.slug}; so far $${((await earned()) / 100).toFixed(2)}`);
let round = 0;
while ((await earned()) < TARGET && round < 80) {
  // buyers hire in parallel, one hire each per round
  await Promise.all(buyers.map((b, i) => oneHire(b, bm.id, round * BUYERS + i).catch((e) => console.log(`  ${b.handle}: ${(e as Error).message}`))));
  round++;
  console.log(`round ${round}: referral earnings $${((await earned()) / 100).toFixed(2)}`);
}
process.exit(0);
