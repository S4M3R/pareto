/** Puts the demo buyer back to a clean take: stale agreements are settled or cancelled, open refund requests are closed,
 * and the wallet is withdrawn to zero so the next take starts with the add-funds card.
 * Nothing is deleted: every step is a normal ledger movement or status change.
 * Usage: pnpm tsx scripts/reset-demo.ts [handle=demo-buyer] [--earnings]
 *   An account flagged require_card (demo-buyer) also loses its saved cards, so the take includes adding one.
 *   --earnings also withdraws that account's earnings balance (use on a provider, e.g. bunvision, not on benchmark-author).
 *   --unpublish <slug> also deletes that benchmark (its scores and hidden test set), e.g. cats-vs-dogs-v1 after the cat or dog demo,
 *   so the author can publish it again. Referral income already paid stays in the ledger. */
import "../lib/env.js";
import { listCards, removeCard } from "../lib/cards.js";
import { db, rpc } from "../lib/db.js";

const args = process.argv.slice(2);
const unpublishAt = args.indexOf("--unpublish");
const unpublish = unpublishAt >= 0 ? args[unpublishAt + 1] : undefined;
const handle = args.find((a, i) => !a.startsWith("--") && i !== unpublishAt + 1) ?? "demo-buyer";
const { data: agent } = await db.from("agents").select("id,handle").eq("handle", handle).maybeSingle();
if (!agent) { console.error(`no agent called ${handle}`); process.exit(1); }

const { data: ags } = await db.from("agreements").select("id,status").eq("buyer_id", agent.id).in("status", ["proposed", "countered", "approved", "funded", "active", "disputed"]);
for (const ag of ags ?? []) {
  if (["proposed", "countered", "approved"].includes(ag.status)) {
    await db.from("agreements").update({ status: "cancelled" }).eq("id", ag.id);
    console.log(`cancelled ${ag.id.slice(0, 8)} (${ag.status})`);
    continue;
  }
  // open refund requests are withdrawn (they leave every list) and their charges go back to normal, so the escrow can settle
  const { data: ds } = await db.from("disputes").select("id,scope,status").eq("agreement_id", ag.id).not("status", "in", "(resolved,withdrawn)");
  for (const d of ds ?? []) {
    if (d.scope === "micro") {
      await db.from("disputes").update({ status: "withdrawn", resolved_at: new Date().toISOString() }).eq("id", d.id);
      await db.from("charges").update({ state: "pending", release_at: new Date().toISOString() }).eq("agreement_id", ag.id).eq("state", "disputed");
    } else console.log(`left full dispute ${d.id.slice(0, 8)} open`);
  }
  try {
    await rpc("close_agreement", { p_agreement: ag.id, p_actor: agent.id });
    console.log(`settled ${ag.id.slice(0, 8)}`);
  } catch (e) { console.log(`could not settle ${ag.id.slice(0, 8)}: ${(e as Error).message}`); }
}

async function withdraw(kind: "wallet" | "earnings") {
  const { data: acct } = await db.from("ledger_accounts").select("id").eq("agent_id", agent!.id).eq("kind", kind).maybeSingle();
  if (!acct) return;
  const bal = Number(await rpc<number>("account_balance", { p_account: acct.id }));
  if (bal <= 0) return;
  const ext = await rpc<string>("ensure_account", { p_kind: "external", p_agent: null, p_agreement: null });
  await rpc("ledger_move", { p_from: acct.id, p_to: ext, p_cents: bal, p_kind: "withdrawal", p_agreement: null, p_reason: "demo reset", p_evidence: {}, p_key: `reset:${agent!.id}:${kind}:${Date.now()}` });
  console.log(`withdrew $${(bal / 100).toFixed(2)} from ${kind}`);
}
await withdraw("wallet");
// an account that must add its own card (agents.require_card) starts every take without one
const { data: flag } = await db.from("agents").select("require_card").eq("id", agent.id).maybeSingle();
if (flag?.require_card) for (const card of await listCards(agent.id)) { await removeCard(agent.id, card.id); console.log(`removed card ${card.brand} ····${card.last4}`); }
if (args.includes("--earnings")) await withdraw("earnings");
if (unpublish) {
  const { data: gone } = await db.from("benchmarks").delete().eq("slug", unpublish).select("slug");
  console.log(gone?.length ? `deleted benchmark ${unpublish}` : `no benchmark called ${unpublish}`);
}
console.log(`${handle} is ready for a fresh take`);
process.exit(0);
