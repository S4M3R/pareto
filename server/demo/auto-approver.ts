import { db } from "../lib/db.js";
import { event } from "../tools/common.js";

/** Demo providers are platform-operated services with nobody behind them, so someone must answer their proposals.
 * This approves image-classification proposals addressed to seeded provider accounts, a couple of seconds after they arrive
 * (so a script or a person that answers first wins), and nothing else. Refund requests are never touched here:
 * a refund is decided by the provider's owner (see lib/refunds.ts). Turn it off with DEMO_AUTO_APPROVE=0. */
export function startDemoAutoApprover(everyMs = 1500) {
  if (process.env.DEMO_AUTO_APPROVE === "0") return;
  const tick = async () => {
    const { data: seeded } = await db.from("agents").select("id").eq("seeded", true).contains("roles", ["provider"]);
    const ids = (seeded ?? []).map((a) => a.id);
    if (!ids.length) return;
    const { data: open } = await db.from("agreements").select("id,provider_id").eq("status", "proposed").eq("terms->>capability", "image-classification").lt("proposed_at", new Date(Date.now() - 2500).toISOString()).in("provider_id", ids).limit(20);
    for (const ag of open ?? []) {
      const { data: done } = await db.from("agreements").update({ status: "approved" }).eq("id", ag.id).eq("status", "proposed").select("id");
      if (done?.length) await event(ag.id, ag.provider_id, "approved", { note: "demo provider: approved automatically" });
    }
  };
  let busy = false; // skip a tick while the previous one is still waiting on the database...
  setInterval(() => {
    if (busy) return;
    busy = true;
    // ...but never forever: a database call that hangs must not stop the loop for good
    const giveUp = new Promise<void>((resolve) => setTimeout(resolve, 20_000));
    void Promise.race([tick(), giveUp]).catch(() => undefined).finally(() => { busy = false; });
  }, everyMs).unref?.();
}
