/** Refund requests end to end, over REST and MCP: a buyer hires a demo classifier, runs images through the gateway, and asks
 * for refunds. The provider decides first (approve, reject), a rejected buyer appeals, and the platform decides on the
 * recorded call. Also checks who may do what, that a held charge is neither released nor closable, and that the money adds up.
  * Usage: MCP=http://localhost:3102/mcp BASE=http://localhost:3102 pnpm tsx scripts/refund-path.ts
 * The accounts it creates (qa-refund-*) stay in the database, like the other scripts' QA agents; no listings are made. */
import "../lib/env.js";
import { createAgent } from "../lib/auth.js";
import { db, rpc } from "../lib/db.js";
import { demoKey } from "../lib/demo-keys.js";
import { liveImageBytes, liveLabel } from "../lib/image-data.js";
import { sweep } from "../lib/disputes.js";

const MCP = process.env.MCP ?? "http://localhost:3102/mcp";
const BASE = process.env.BASE ?? new URL(MCP).origin;
const PROVIDER = process.env.PROVIDER ?? "wienernet"; // the weakest demo classifier: wrong answers come quickly
const TOPUP = 500;
type R = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
let id = 1;
const ok = (c: unknown, m: string) => { if (!c) throw new Error("ASSERT: " + m); console.log("  ✔ " + m); };

async function mcp(key: string, tool: string, args: R = {}, expectError = false): Promise<R> {
  const res = await fetch(MCP, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-api-key": key }, body: JSON.stringify({ jsonrpc: "2.0", id: id++, method: "tools/call", params: { name: tool, arguments: args } }) });
  const t = await res.text();
  const line = t.split("\n").find((l) => l.startsWith("data:"));
  const r = (line ? JSON.parse(line.slice(5)) : JSON.parse(t)).result;
  const out = r.structuredContent ?? (r.content[0].text.startsWith("{") ? JSON.parse(r.content[0].text) : { code: "tool_error", error: r.content[0].text });
  if (!!r.isError !== expectError) throw new Error(`${tool} ${expectError ? "should have failed" : "failed"}: ${JSON.stringify(out)}`);
  return out;
}
/** `auth` is an API key (agk_...) or a console session token. */
const api = async (method: string, path: string, auth?: string, body?: R) => {
  const headers: R = body ? { "content-type": "application/json" } : {};
  if (auth) headers[auth.startsWith("agk_") ? "x-api-key" : "authorization"] = auth.startsWith("agk_") ? auth : "Bearer " + auth;
  const r = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as R };
};
const chargeOf = async (chargeId: string) => (await db.from("charges").select("state,amount_cents,refunded_cents").eq("id", chargeId).single()).data as R;
const balance = async (agentId: string, kind: "wallet" | "earnings") => {
  const { data } = await db.from("ledger_accounts").select("id").eq("agent_id", agentId).eq("kind", kind).maybeSingle();
  return data ? Number(await rpc<number>("account_balance", { p_account: data.id })) : 0;
};
const wallet = (agentId: string) => balance(agentId, "wallet");

async function main() {
  const suffix = Math.random().toString(36).slice(2, 8);
  const buyerKey = await createAgent({ handle: `qa-refund-${suffix}`, roles: ["buyer"], owner_ref: `qa-refund-owner-${suffix}` });
  const strangerKey = await createAgent({ handle: `qa-refund-x-${suffix}`, roles: ["buyer"], owner_ref: `qa-refund-other-${suffix}` });
  const providerKey = demoKey(PROVIDER);
  const buyerId = (await db.from("agents").select("id").eq("handle", `qa-refund-${suffix}`).single()).data!.id as string;
  const { data: prov } = await db.from("agents").select("id").eq("handle", PROVIDER).single();
  await rpc("topup", { p_agent: buyerId, p_cents: TOPUP, p_key: `refund-path:${suffix}`, p_ref: "refund-path" });
  ok((await wallet(buyerId)) === TOPUP, `a fresh buyer has $${(TOPUP / 100).toFixed(2)} to hire with`);

  console.log("== hire and run");
  const earnBefore = await balance(prov!.id, "earnings");
  const { data: listing } = await db.from("listings").select("id,pricing").eq("provider_id", prov!.id).eq("active", true).single();
  const price = Number((listing!.pricing as R).amount_cents);
  const task = await mcp(buyerKey, "create_task", { title: "Refund path", description: "Classify photos as hotdog or not_hotdog." });
  // sample_rate 0: wrong answers are not caught live, so they stay pending charges the buyer can ask to have refunded
  const agr = await mcp(buyerKey, "propose_agreement", { task_id: task.task_id, listing_id: listing!.id, budget_cap_cents: 400, check_window_s: 600, sample_rate: 0, min_field_accuracy: 1, holdback_pct: 0, dispute_response_s: 20 });
  const deal = agr.agreement_id as string;
  for (let i = 0; i < 20; i++) {
    const { data } = await db.from("agreements").select("status").eq("id", deal).single();
    if (data!.status !== "proposed") break;
    if (i === 8) await mcp(providerKey, "review_proposal", { agreement_id: deal, decision: "approve" }).catch(() => undefined); // the auto-approver is off
    await new Promise((r) => setTimeout(r, 500));
  }
  await mcp(buyerKey, "fund_escrow", { agreement_id: deal });

  const samples = (await mcp(buyerKey, "list_sample_images", { limit: 50 })).images as R[];
  const calls: R[] = [];
  const gw = async (input: R) => (await api("POST", `/gw/${deal}/call`, buyerKey, input)).body;
  for (const im of samples) {
    if (calls.filter((c) => !c.right).length >= 3 && calls.filter((c) => c.right).length >= 3) break;
    const r = await gw({ image_id: im.image_id });
    if (r.status === "auto_refunded" || !r.charge_id) continue; // billing slips are refunded on their own; not a case for this test
    calls.push({ ...r, image_id: im.image_id, right: r.result?.label === liveLabel(im.image_id) });
  }
  const wrongs = calls.filter((c) => !c.right), rights = calls.filter((c) => c.right);
  ok(wrongs.length >= 3 && rights.length >= 3, `${calls.length} calls: ${wrongs.length} wrong, ${rights.length} right (by the platform's reference labels)`);
  ok(calls.every((c) => c.charged_cents > 0), "every one was charged and is pending inside the check window");
  const [wrongA, wrongC, wrongE] = wrongs, [rightB, rightD] = rights;
  // a call with no reference answer: the buyer sent the picture itself, so the platform cannot verify it later
  const upload = await gw({ image_base64: liveImageBytes(samples[0].image_id)!.toString("base64") });
  ok(upload.charge_id, "an uploaded picture is a call the platform has no reference label for");

  console.log("== who may ask, and for what");
  const stranger = await api("POST", `/api/deals/${deal}/refunds`, strangerKey, { charge_id: wrongA.charge_id, reason: "That is wrong." });
  ok(stranger.status === 403, "someone who is not the buyer cannot ask (403)");
  ok((await api("POST", `/api/deals/${deal}/refunds`, undefined, { charge_id: wrongA.charge_id, reason: "That is wrong." })).status === 401, "no credentials, no refund (401)");
  ok((await api("POST", `/api/deals/${deal}/refunds`, buyerKey, { charge_id: wrongA.charge_id, reason: "x" })).status === 400, "a one-letter reason is refused");
  ok((await api("POST", `/api/deals/${crypto.randomUUID()}/refunds`, buyerKey, { charge_id: wrongA.charge_id, reason: "Wrong deal id." })).status === 400, "a charge from a different deal is refused");
  ok((await chargeOf(wrongA.charge_id)).state === "pending", "refused requests leave the charge alone");

  console.log("== A: wrong answer, the provider approves (from the phone)");
  const a1 = await api("POST", `/api/deals/${deal}/refunds`, buyerKey, { charge_id: wrongA.charge_id, reason: "It is a corn dog, not a hot dog." });
  ok(a1.status === 201 && a1.body.status === "awaiting_provider", "the buyer's request is created and waits for the provider (201)");
  const A = a1.body;
  ok(A.deal_id === deal && A.charge_id === wrongA.charge_id && A.amount_cents === price && A.call_seq === wrongA.seq, "it names the deal, the charge, the price and the call number");
  ok(A.buyer?.startsWith("qa-refund-") && A.provider === PROVIDER && A.image_id === wrongA.image_id && A.answered.label === wrongA.result.label, "it carries who, which image and what the model answered");
  ok(A.image_url?.endsWith(`/images/${wrongA.image_id}.jpg`), "and a link to the image");
  ok((await chargeOf(A.charge_id)).state === "disputed", "the charge is held (disputed)");
  ok((await api("POST", `/api/deals/${deal}/refunds`, buyerKey, { charge_id: wrongA.charge_id, reason: "Asking twice." })).status === 400, "a second request for the same call is refused");
  await db.from("charges").update({ release_at: new Date(Date.now() - 60_000).toISOString() }).eq("id", A.charge_id); // the window "ends" while it is open
  await sweep();
  ok((await chargeOf(A.charge_id)).state === "disputed", "the sweep does not release a held charge, even past its window");
  ok((await mcp(buyerKey, "close_task", { agreement_id: deal }, true)).code === "open_dispute", "close_task refuses while a refund request is open");
  ok((await api("GET", `/api/refunds/${A.refund_id}`, strangerKey)).status === 403, "a stranger cannot read the request");
  ok((await api("GET", `/api/refunds/${A.refund_id}`, buyerKey)).body.status === "awaiting_provider", "the buyer can read it");
  ok((await api("POST", `/api/refunds/${A.refund_id}/appeal`, buyerKey, {})).status === 400, "nothing to appeal before the provider answers");
  ok((await api("POST", `/api/refunds/${A.refund_id}/decision`, buyerKey, { decision: "approve" })).status === 403, "the buyer cannot decide their own request");
  ok((await api("GET", "/api/provider/refunds", buyerKey)).status === 403, "the provider's queue is not open to a buyer");
  // the console sign-in link is issued by the server to whoever holds the provider's API key; its token works as a bearer
  const link = (await (await fetch(`${BASE}/api/console-link`, { method: "POST", headers: { "x-api-key": providerKey } })).json()) as R;
  const phone = new URL(link.refunds_url).searchParams.get("t")!;
  const queue = await api("GET", "/api/provider/refunds?status=awaiting_provider", phone);
  ok(queue.status === 200 && queue.body.refunds.some((r: R) => r.refund_id === A.refund_id), "the provider sees it in their queue (on a console session token)");
  const page = await fetch(`${BASE}/console/refunds`);
  ok(page.status === 200 && (await page.text()).includes("Needs your decision"), "the phone page is served");
  ok((await api("GET", "/api/provider/refunds?status=bogus", phone)).status === 400, "an unknown status filter is refused");
  const before = await wallet(buyerId);
  const decA = await api("POST", `/api/refunds/${A.refund_id}/decision`, phone, { decision: "approve", note: "You are right, sorry." });
  ok(decA.status === 200 && decA.body.status === "refunded" && decA.body.final?.outcome === "refunded", "approve: the refund is final and refunded");
  ok(decA.body.provider_decision.note === "You are right, sorry.", "the provider's note is kept");
  ok((await chargeOf(A.charge_id)).state === "refunded" && (await wallet(buyerId)) === before + price, "the charge is refunded from escrow into the buyer's wallet");
  ok((await api("POST", `/api/refunds/${A.refund_id}/decision`, phone, { decision: "reject" })).status === 400, "it cannot be decided twice");

  console.log("== B: a right answer, the provider rejects, the platform denies the appeal");
  const B = (await mcp(buyerKey, "request_refund", { charge_id: rightB.charge_id, reason: "I think this one is wrong." })) as R;
  ok(B.status === "awaiting_provider", "request_refund over MCP creates it too");
  ok((await mcp(strangerKey, "decide_refund", { refund_id: B.refund_id, decision: "approve" }, true)).code === "wrong_role", "a buyer account cannot use decide_refund");
  const pending = await mcp(providerKey, "list_refund_requests");
  ok(pending.refunds.some((r: R) => r.refund_id === B.refund_id), "list_refund_requests shows it to the provider");
  const decB = await mcp(providerKey, "decide_refund", { refund_id: B.refund_id, decision: "reject", note: "Our model got this one right." });
  ok(decB.status === "rejected" && decB.final === null, "reject: the request is rejected and not final");
  ok((await chargeOf(B.charge_id)).state === "disputed", "the charge stays held after a rejection");
  ok((await api("POST", `/api/refunds/${B.refund_id}/appeal`, strangerKey, {})).status === 403, "only the buyer can appeal");
  const appB = await api("POST", `/api/refunds/${B.refund_id}/appeal`, buyerKey, { note: "Please check it." });
  ok(appB.status === 200 && appB.body.status === "denied_on_appeal" && appB.body.final.outcome === "denied", "appeal: the platform checks the recorded call against the reference answer and denies it");
  ok(/hotdog|label|matched|passed/i.test(appB.body.final.reasoning), "and says why: " + appB.body.final.reasoning.slice(0, 90));
  ok(appB.body.appeal.note === "Please check it." && appB.body.provider_decision.decision === "reject", "the whole history is on the record");
  ok(["pending", "released"].includes((await chargeOf(B.charge_id)).state), "the charge goes back to the provider (pending with the window over, released by the next sweep)");
  ok((await api("POST", `/api/refunds/${B.refund_id}/appeal`, buyerKey, {})).status === 400, "the verdict is final: no second appeal");

  console.log("== C: a wrong answer, rejected, the appeal succeeds");
  const C = (await api("POST", `/api/deals/${deal}/refunds`, buyerKey, { charge_id: wrongC.charge_id, reason: "Wrong label." })).body;
  const rejC = await api("POST", `/api/refunds/${C.refund_id}/decision`, providerKey, { decision: "reject" });
  ok(rejC.status === 200 && rejC.body.status === "rejected", "an API key decides just like a console token");
  const appC = await api("POST", `/api/refunds/${C.refund_id}/appeal`, buyerKey, {});
  ok(appC.body.status === "refunded_on_appeal" && appC.body.final.outcome === "refunded", "the platform finds the answer wrong and refunds on appeal");
  ok((await chargeOf(C.charge_id)).state === "refunded", "the charge is refunded");

  console.log("== D: an uploaded picture cannot be verified, so a rejection stands");
  const D = (await api("POST", `/api/deals/${deal}/refunds`, buyerKey, { charge_id: upload.charge_id, reason: "I do not agree." })).body;
  await api("POST", `/api/refunds/${D.refund_id}/decision`, providerKey, { decision: "reject" });
  const appD = await api("POST", `/api/refunds/${D.refund_id}/appeal`, buyerKey, {});
  ok(appD.body.status === "denied_on_appeal" && /reference/i.test(appD.body.final.reasoning), "the appeal is denied because the platform has no reference answer");

  console.log("== E: unanswered requests, then the tools that list them");
  const E = (await api("POST", `/api/deals/${deal}/refunds`, buyerKey, { charge_id: wrongE.charge_id, reason: "Wrong again." })).body;
  const mine = await mcp(buyerKey, "list_refunds", { agreement_id: deal });
  const statuses = Object.fromEntries(mine.refunds.map((r: R) => [r.refund_id, r.status]));
  ok(mine.count === 5 && statuses[A.refund_id] === "refunded" && statuses[B.refund_id] === "denied_on_appeal" && statuses[C.refund_id] === "refunded_on_appeal" && statuses[E.refund_id] === "awaiting_provider", "list_refunds shows all five with their statuses");
  ok(mine.open === 1, "and counts the one still open");
  ok((await mcp(strangerKey, "list_refunds", {})).count === 0, "a stranger sees none of them");
  ok(decB.refund_id === B.refund_id && decB.status === "rejected", "decisions are returned in the same shape everywhere");
  ok((await mcp(buyerKey, "close_task", { agreement_id: deal }, true)).code === "open_dispute", "close_task still refuses with one request open");
  await mcp(providerKey, "decide_refund", { refund_id: E.refund_id, decision: "approve" });

  console.log("== settle and add up");
  const closed = await mcp(buyerKey, "close_task", { agreement_id: deal });
  ok(closed.status === "settled", "close_task settles once every request is answered");
  const spend = await mcp(buyerKey, "get_spend", { agreement_id: deal });
  const { data: paid } = await db.from("charges").select("refunded_cents").in("id", [A.charge_id, C.charge_id, E.charge_id]);
  ok((paid ?? []).reduce((n, c) => n + Number(c.refunded_cents), 0) === 3 * price, `three refunds were paid in full: A, C on appeal, E (${3 * price} cents)`);
  ok((await db.from("charges").select("refunded_cents").in("id", [B.charge_id, D.charge_id])).data!.every((c) => Number(c.refunded_cents) === 0), "the two denied requests (B, D) were not refunded");
  ok((await wallet(buyerId)) === TOPUP - (spend.charged_cents - spend.refunded_cents), "the buyer's wallet is the top-up minus what the provider kept");
  ok((await balance(prov!.id, "earnings")) - earnBefore === spend.charged_cents - spend.refunded_cents, `the provider earned exactly what was charged minus refunds (${spend.charged_cents - spend.refunded_cents} cents)`);
  ok(spend.charged_cents - spend.refunded_cents > 0 && spend.refunded_cents >= 3 * price, "charged, refunded and kept add up");
  for (const r of [A, B, C, D, E]) {
    const { data } = await db.from("disputes").select("status").eq("id", r.refund_id).single();
    ok(data!.status === "resolved", `request ${r.refund_id.slice(0, 8)} is resolved`);
  }
  // leave nothing behind: the QA buyer's remaining wallet goes back out through the ledger
  const left = await wallet(buyerId);
  if (left > 0) {
    const { data: w } = await db.from("ledger_accounts").select("id").eq("agent_id", buyerId).eq("kind", "wallet").single();
    const ext = await rpc<string>("ensure_account", { p_kind: "external", p_agent: null, p_agreement: null });
    await rpc("ledger_move", { p_from: w!.id, p_to: ext, p_cents: left, p_kind: "withdrawal", p_agreement: null, p_reason: "refund-path cleanup", p_evidence: {}, p_key: `refund-path:cleanup:${suffix}` });
  }
  console.log("\nREFUND PATH PASSED");
}
main().catch((e) => { console.error(e.message); process.exit(1); });
