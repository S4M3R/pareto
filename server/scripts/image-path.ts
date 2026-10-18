/** Image-classification end to end over MCP and REST: discover, create a listing through the API (and see unsafe ones refused),
 * hire a demo provider, use it on sample images, catch a wrong answer and a billing error, dispute, and close.
 * Usage: MCP=http://localhost:3100/mcp BASE=http://localhost:3100 pnpm tsx scripts/image-path.ts */
import "../lib/env.js";
import { db } from "../lib/db.js";
import { demoKey } from "../lib/demo-keys.js";

const MCP = process.env.MCP ?? "http://localhost:3100/mcp";
const BASE = process.env.BASE ?? new URL(MCP).origin;
const BUYER = demoKey("demo-buyer");
type R = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
let id = 1;
const created: string[] = []; // listings this run makes; removed at the end so a test never leaves anything in the catalogue
const ok = (c: boolean, m: string) => { if (!c) throw new Error("ASSERT: " + m); console.log("  ✔ " + m); };

async function call(key: string, tool: string, args: R = {}, expectError = false): Promise<R> {
  const res = await fetch(MCP, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-api-key": key }, body: JSON.stringify({ jsonrpc: "2.0", id: id++, method: "tools/call", params: { name: tool, arguments: args } }) });
  const t = await res.text();
  const line = t.split("\n").find((l) => l.startsWith("data:"));
  const r = (line ? JSON.parse(line.slice(5)) : JSON.parse(t)).result;
  const out = r.structuredContent ?? JSON.parse(r.content[0].text);
  if (!!r.isError !== expectError) throw new Error(`${tool} ${expectError ? "should have failed" : "failed"}: ${JSON.stringify(out)}`);
  return out;
}
const api = async (method: string, path: string, key?: string, body?: R) => {
  const r = await fetch(BASE + path, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(key ? { "x-api-key": key } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as R };
};

async function main() {
  console.log("== discover");
  const found = await call(BUYER, "search_benchmarks", { task: "tell me whether photos of food are hot dogs" });
  ok(found.matches?.[0]?.slug === "hotdog-or-not-v1", "search_benchmarks finds the hot dog benchmark");
  ok(found.matches[0].n_test === 100, "it has a 100-image hidden test set");
  const bench = found.matches[0].benchmark_id as string;
  const ranked = await call(BUYER, "find_providers", { benchmark_id: bench });
  ok(ranked.providers.length >= 6, `${ranked.providers.length} providers are ranked on verified scores`);
  const by = Object.fromEntries(ranked.providers.map((p: R) => [p.provider, p]));
  ok(by["frankfinder-pro"].quality > by["seefood-lite"].quality && by["seefood-lite"].price_cents_per_call < by["frankfinder-pro"].price_cents_per_call, "the premium provider is more accurate and pricier than the budget one");
  const cmp = await call(BUYER, "compare_providers", { benchmark_id: bench });
  const dominated = cmp.providers.filter((p: R) => !p.on_frontier).map((p: R) => p.provider);
  ok(dominated.includes("wienernet"), `the Pareto frontier marks WienerNet as dominated (${dominated.join(", ")})`);

  console.log("== the listing API");
  const reg = await call("none", "register_agent", { handle: "qa-" + Math.random().toString(36).slice(2, 8), roles: ["provider"], owner_ref: "qa-owner" });
  const k = reg.api_key as string;
  ok((await api("GET", "/api/listings?capability=image-classification")).body.listings.length >= 6, "GET /api/listings is public and lists the six demo listings");
  ok((await api("POST", "/api/listings", undefined, { title: "x" })).status === 401, "POST /api/listings needs an API key");
  const bad = { title: "Bad endpoint", capability: "image-classification", kind: "api", price_cents_per_call: 2 };
  ok((await api("POST", "/api/listings", k, { ...bad, endpoint_url: "https://169.254.169.254/latest/meta-data" })).status === 400, "a cloud metadata address is refused");
  ok((await api("POST", "/api/listings", k, { ...bad, endpoint_url: "http://example.com/classify" })).status === 400, "a plain http endpoint is refused");
  ok((await api("POST", "/api/listings", k, { ...bad, endpoint_url: "https://example.com/classify", capability: "weather" })).status === 400, "an unsupported capability is refused with the list of supported ones");
  const made = await api("POST", "/api/listings", k, { ...bad, title: "QA Classifier", endpoint_url: "https://example.com/classify" });
  ok(made.status === 201 && !!made.body.listing_id, "a valid listing is created (201)");
  created.push(made.body.listing_id);
  const viaTool = await call(k, "register_listing", { title: "QA Classifier via MCP", capability: "image-classification", kind: "api", endpoint_url: "https://example.org/classify", price_cents_per_call: 3, max_latency_ms: 1000 });
  ok(!!viaTool.listing_id, "register_listing over MCP creates one too, through the same service");
  created.push(viaTool.listing_id);
  ok((await call(BUYER, "list_listings", { capability: "image-classification" })).listings.some((l: R) => l.title === "QA Classifier"), "list_listings shows it, without the endpoint URL");
  const run = await api("POST", `/api/listings/${made.body.listing_id}/runs`, BUYER, { benchmark_id: bench });
  ok(run.status === 403 || run.status === 400, "only the owning provider can score a listing");
  const unreachable = await api("POST", `/api/listings/${made.body.listing_id}/runs`, k, { benchmark_id: bench });
  ok(unreachable.status === 200 && unreachable.body.accuracy === 0 && unreachable.body.errors === 100, "scoring an unreachable endpoint records accuracy 0 with 100 errors, not a crash");

  console.log("== hire a demo provider and use it");
  const dog = by["fastfrank"]; // the sloppy biller: slow outliers, over-billing, a few wrong answers
  const task = await call(BUYER, "create_task", { title: "Is it a hot dog?", description: "Classify sample photos as hotdog or not_hotdog." });
  const agr = await call(BUYER, "propose_agreement", { auto_refund_failed: true, task_id: task.task_id, listing_id: dog.listing_id, budget_cap_cents: 100, check_window_s: Number(process.env.CHECK_WINDOW_S ?? 30), sample_rate: 1, min_field_accuracy: 1, holdback_pct: 20 });
  ok(agr.terms.capability === "image-classification", "the agreement records its capability");
  await call(demoKey("fastfrank"), "review_proposal", { agreement_id: agr.agreement_id, decision: "approve" }).catch(() => undefined); // the demo auto-approver may have answered first
  await call(BUYER, "fund_escrow", { agreement_id: agr.agreement_id });
  const samples = await call(BUYER, "list_sample_images", { limit: 30 });
  ok(samples.images.length === 30 && !("label" in samples.images[0]), "sample images are offered without their labels");
  await call(BUYER, "call_provider", { agreement_id: agr.agreement_id, page_id: 1 }, true);
  let refunded = 0, wrong: R | undefined;
  for (const im of samples.images) {
    const r = await call(BUYER, "call_provider", { agreement_id: agr.agreement_id, image_id: im.image_id });
    if (r.status === "auto_refunded") refunded++;
    else if (!wrong && r.result?.label) wrong = { ...r, image_id: im.image_id };
  }
  ok(refunded > 0, `${refunded} of 30 calls were refunded automatically (a wrong label, or billed twice)`);
  const listed = await call(BUYER, "list_calls", { agreement_id: agr.agreement_id, limit: 50 });
  ok(listed.calls.some((c: R) => c.failed_checks.some((f: string) => /billed 2|label/.test(f))), "failed checks name the problem (billing or label)");
  const spend = await call(BUYER, "get_spend", { agreement_id: agr.agreement_id });
  ok(spend.refunded_cents > 0, "refunds came out of escrow");
  const closed = await call(BUYER, "close_task", { agreement_id: agr.agreement_id });
  ok(closed.status === "settled", "settled");
  console.log("\nIMAGE PATH PASSED");
}
async function cleanup() {
  if (!created.length) return;
  await db.from("benchmark_results").delete().in("listing_id", created);
  await db.from("listings").update({ active: false }).in("id", created); // hidden from every search even if a row cannot be deleted
  const { error } = await db.from("listings").delete().in("id", created);
  console.log(error ? "(test listings deactivated)" : "(test listings removed)");
}
main().then(cleanup, async (e) => { console.error(e.message); await cleanup(); process.exit(1); });
