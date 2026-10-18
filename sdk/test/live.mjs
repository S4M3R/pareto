// Smoke test against a running dev server. Reads only: lists deals, and classifies one image if an active deal exists.
// Classifying spends 5 cents of that deal's budget, so run it only against a throwaway deal.
//   PARETO_URL=http://localhost:3101 PARETO_API_KEY=agk_... node test/live.mjs
import { Pareto } from "../dist/index.js";

const pareto = new Pareto();
const deals = await pareto.deals.list({ status: "active" });
console.log(`deals: ${deals.length}`);
const listings = await pareto.listings.list({ capability: "image-classification" });
console.log(`image-classification listings: ${listings.length}`);
if (deals[0]) {
  const d = deals[0];
  const before = await pareto.deals.get(d.deal_id);
  const r = await pareto.classify(d.deal_id, { imageId: "live-001" });
  console.log(`classified live-001 -> ${r.label} (${r.confidence}), charged ${r.chargedCents}c, status ${r.status}`);
  const calls = await pareto.deals.calls(d.deal_id, { limit: 5 });
  if (!calls.some((c) => c.call_id === r.callId && c.image_id === "live-001")) throw new Error("the call is not in the deal's call list");
  const after = await pareto.deals.get(d.deal_id);
  if ((after.spend?.calls ?? 0) !== (before.spend?.calls ?? 0) + 1) throw new Error("spend did not move by one call");
}
console.log("ok");
