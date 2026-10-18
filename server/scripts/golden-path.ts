/** Drives the whole marketplace over the real MCP protocol as a buyer agent and two provider agents.
 * Doubles as the integration test and the saved client transcript. Usage: tsx scripts/golden-path.ts [--out file.md] */
import "../lib/env.js";
import { demoKey } from "../lib/demo-keys.js";
import { writeFileSync } from "node:fs";

const URL_ = process.env.MCP_URL ?? "http://localhost:3000/mcp";
const KEYS = { buyer: demoKey("demo-buyer"), budget: demoKey("budget-extractor"), fastscrape: demoKey("fastscrape-pro"), careful: demoKey("careful-extractor") };
/** Seconds a charge stays disputable. 6 is right for localhost; use CHECK_WINDOW_S=45 against a remote server, where 16 calls take longer than 6 s. */
const WINDOW = Number(process.env.CHECK_WINDOW_S ?? 6);
const log: string[] = [];
let id = 1;

type R = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function call(who: keyof typeof KEYS, tool: string, args: R = {}, expectError = false): Promise<R> {
  const res = await fetch(URL_, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-api-key": KEYS[who] },
    body: JSON.stringify({ jsonrpc: "2.0", id: id++, method: "tools/call", params: { name: tool, arguments: args } }),
  });
  const text = await res.text();
  const data = JSON.parse(text.split("\n").find((l) => l.startsWith("data:"))!.slice(5));
  const out = data.result?.structuredContent ?? JSON.parse(data.result?.content?.[0]?.text ?? "{}");
  const isErr = !!data.result?.isError;
  const brief = JSON.stringify(out).slice(0, 360);
  log.push(`**${who}** → \`${tool}(${JSON.stringify(args).slice(0, 140)})\`\n\n${isErr ? "ERROR " : ""}\`${brief}${JSON.stringify(out).length > 360 ? "…" : ""}\`\n`);
  console.log(`${who.padEnd(10)} ${tool.padEnd(20)} ${isErr ? "ERROR " : ""}${brief.slice(0, 150)}`);
  if (isErr && !expectError) throw new Error(`${tool} failed: ${JSON.stringify(out)}`);
  if (!isErr && expectError) throw new Error(`${tool} should have failed`);
  return out;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const check = (cond: boolean, msg: string) => { if (!cond) throw new Error("ASSERT: " + msg); console.log("  ✔ " + msg); };

async function main() {
  console.log("== setup");
  await call("buyer", "whoami");
  await call("buyer", "topup_wallet", { amount_cents: 600 });

  console.log("\n== discover");
  const found = await call("buyer", "search_benchmarks", { task: "I need structured fields extracted from person profile web pages", sample_inputs: ["<div class=profile><h1>Jane Doe</h1>"] });
  check(found.matches?.length > 0, "search_benchmarks finds the extraction benchmark");
  const nomatch = await call("buyer", "search_benchmarks", { task: "train a protein folding model on GPUs" });
  check(nomatch.matches?.length === 0, "search_benchmarks says 'no match' honestly for an unrelated task");
  const ranked = await call("buyer", "find_providers", { benchmark_id: found.matches[0].benchmark_id });
  check(ranked.providers.length === 3, "three providers ranked");
  const byName = Object.fromEntries(ranked.providers.map((p: R) => [p.provider, p]));
  const cheap = byName["budget-extractor"], sloppy = byName["fastscrape-pro"];

  console.log("\n== agreement #1 with the cheap provider (counter-offer, micro dispute)");
  const task = await call("buyer", "create_task", { title: "Extract 40 profiles", description: "Structured fields from synthetic profile pages 2000-2039" });
  await call("buyer", "propose_agreement", { auto_refund_failed: true, task_id: task.task_id, listing_id: cheap.listing_id, budget_cap_cents: 1100, check_window_s: WINDOW, sample_rate: 0.3, min_field_accuracy: 0.9, holdback_pct: 20 }, true); // over the human-set per-agreement limit
  const p1 = await call("buyer", "propose_agreement", { auto_refund_failed: true, task_id: task.task_id, listing_id: cheap.listing_id, budget_cap_cents: 100, check_window_s: WINDOW, sample_rate: 0.3, min_field_accuracy: 0.9, holdback_pct: 20 });
  const reqs = await call("budget", "list_requests");
  check(reqs.requests.some((r: R) => r.agreement_id === p1.agreement_id), "provider sees the proposal");
  await call("budget", "review_proposal", { agreement_id: p1.agreement_id, decision: "counter", counter: { price_cents_per_call: 5 }, note: "price floor is 5c" });
  await call("buyer", "respond_to_counter", { agreement_id: p1.agreement_id, accept: true });
  await call("buyer", "call_provider", { agreement_id: p1.agreement_id, page_id: 2000 }, true); // not funded yet
  const funded = await call("buyer", "fund_escrow", { agreement_id: p1.agreement_id });
  check(funded.status === "active" && !!funded.access?.grant_key, "escrow funded, access grant issued");

  let refunded = 0, pending: R[] = [];
  for (let p = 2000; p < 2016; p++) {
    const r = await call("buyer", "call_provider", { agreement_id: p1.agreement_id, page_id: p });
    if (r.status === "auto_refunded") refunded++;
  }
  console.log(`  ${refunded} calls auto-refunded by sampled evals`);
  const listed = await call("buyer", "list_calls", { agreement_id: p1.agreement_id, limit: 50 });
  pending = listed.calls.filter((c: R) => c.charge_state === "pending" && c.passed === true);
  // The auto-evals only sampled some calls. Find a pending call whose output is actually wrong (what a buyer would notice).
  let target: R | undefined;
  for (const c of pending) {
    const t = await call("buyer", "get_trace", { call_id: c.call_id });
    const gt = (await import("../lib/fixtures.js")).scoreFields(t.response?.fields, t.request.page_id);
    if (gt.accuracy < 1) { target = c; break; }
  }
  check(!!target, "found a wrong-but-unsampled result among pending charges");
  const micro = await call("buyer", "file_dispute", { scope: "micro", charge_id: target!.charge_id, claim_type: "wrong_output", note: "fields look wrong" });
  check(micro.outcome === "upheld", "micro dispute upheld from the recorded trace, refunded in seconds");
  const good = pending.find((c: R) => c.charge_id !== target!.charge_id)!;
  const frivolous = await call("buyer", "file_dispute", { scope: "micro", charge_id: good.charge_id, claim_type: "wrong_output", note: "just checking" });
  console.log(`  frivolous micro dispute on a correct call: ${frivolous.outcome}`);
  await sleep((WINDOW + 1) * 1000);
  const spend1 = await call("buyer", "get_spend", { agreement_id: p1.agreement_id });
  check(spend1.pending_cents === 0, "check window closed: nothing left pending");
  const closed = await call("buyer", "close_task", { agreement_id: p1.agreement_id });
  check(closed.status === "settled", "agreement settled; holdback released, unspent returned");
  await call("buyer", "review_provider", { agreement_id: p1.agreement_id, ratings: { accuracy: 3, sla: 5, clarity: 4, cost_fairness: 4 }, comment: "Cheap and fast; some fields wrong, refunded fairly." });
  await call("budget", "review_buyer", { agreement_id: p1.agreement_id, ratings: { accuracy: 5, sla: 5, clarity: 5, cost_fairness: 5 }, comment: "Clear spec, quick to dispute with evidence." });
  await call("buyer", "review_provider", { agreement_id: p1.agreement_id, ratings: { accuracy: 3, sla: 5, clarity: 4, cost_fairness: 4 } }, true); // duplicate

  console.log("\n== agreement #2 with the sloppy provider (full dispute)");
  const t2 = await call("buyer", "create_task", { title: "Extract 30 profiles fast", description: "Structured fields, pages 3000-3029, speed matters" });
  const p2 = await call("buyer", "propose_agreement", { auto_refund_failed: true, task_id: t2.task_id, listing_id: sloppy.listing_id, budget_cap_cents: 200, check_window_s: 600, sample_rate: 1, min_field_accuracy: 0.9, max_latency_ms: 1500, acceptance_min_pass_rate: 0.9, dispute_response_s: 4 });
  await call("fastscrape", "review_proposal", { agreement_id: p2.agreement_id, decision: "approve" });
  await call("buyer", "fund_escrow", { agreement_id: p2.agreement_id });
  for (let p = 3000; p < 3018; p++) await call("buyer", "call_provider", { agreement_id: p2.agreement_id, page_id: p });
  const spend2 = await call("buyer", "get_spend", { agreement_id: p2.agreement_id });
  const dispute = await call("buyer", "file_dispute", { scope: "full", agreement_id: p2.agreement_id, claim_type: "sla_breach", note: "Repeated latency breaches and wrong fields." });
  await call("buyer", "call_provider", { agreement_id: p2.agreement_id, page_id: 3099 }, true); // access revoked while frozen
  await call("fastscrape", "respond_to_dispute", { dispute_id: dispute.dispute_id, statement: "Latency outliers are due to upstream load; accuracy is within our published range." });
  const verdict = await call("buyer", "get_dispute", { dispute_id: dispute.dispute_id });
  check(verdict.status === "resolved", "full dispute resolved with a reasoned verdict");
  console.log("  verdict:", verdict.verdict.outcome, "| refund", verdict.verdict.refund_pct + "%");
  await call("buyer", "review_provider", { agreement_id: p2.agreement_id, ratings: { accuracy: 2, sla: 1, clarity: 3, cost_fairness: 2 }, comment: "Slow and inaccurate; dispute settled fairly." });

  console.log("\n== money and reputation");
  const ledger = await call("buyer", "get_ledger", { limit: 8 });
  const prov = await call("buyer", "find_providers", { benchmark_id: found.matches[0].benchmark_id });
  console.log("  buyer balances:", JSON.stringify(ledger.balances_cents));
  console.log("  sloppy provider reputation now:", JSON.stringify(prov.providers.find((p: R) => p.provider === "fastscrape-pro").reputation));
  check(Number(spend2.calls) > 0, "run complete");
  console.log("\nALL CHECKS PASSED");
  const out = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : null;
  if (out) writeFileSync(out, `# Golden-path transcript (real MCP calls)\n\nGenerated by scripts/golden-path.ts against ${URL_}.\n\n` + log.join("\n"));
}
main().catch((e) => { console.error("\nFAILED:", e.message); process.exit(1); });
