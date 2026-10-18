/** Sanity checks for the Pareto analysis. Run: pnpm tsx scripts/pareto-check.ts */
import { analyze, recommend } from "../lib/pareto.js";

const pts = [
  { id: "careful", price: 10, quality: 0.985, ci_low: 0.976, ci_high: 0.994 },
  { id: "fast", price: 6, quality: 0.878, ci_low: 0.851, ci_high: 0.905 },
  { id: "budget", price: 4, quality: 0.84, ci_low: 0.809, ci_high: 0.871 },
  { id: "pricey-bad", price: 12, quality: 0.8, ci_low: 0.72, ci_high: 0.88 },
];
const v = analyze(pts);
const eq = (a: unknown, b: unknown, m: string) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); console.log("  ok " + m); };
eq(["careful", "fast", "budget"].map((i) => v.get(i)!.on_frontier), [true, true, true], "careful, fast and budget are all on the frontier (each trades price for quality)");
eq(v.get("pricey-bad")!.on_frontier, false, "a pricier and worse provider is dominated");
eq(v.get("pricey-bad")!.dominated_by, "budget", "named by its cheapest dominator");
eq(v.get("pricey-bad")!.confidently_dominated, true, "budget's interval sits above its interval");
const tie = analyze([{ id: "a", price: 5, quality: 0.9, ci_low: 0.8, ci_high: 0.95 }, { id: "b", price: 6, quality: 0.89, ci_low: 0.82, ci_high: 0.93 }]);
eq([tie.get("b")!.on_frontier, tie.get("b")!.confidently_dominated], [false, false], "dominated by point estimate but not confidently, when intervals overlap");
eq(analyze([{ id: "x", price: 5, quality: 0.9, ci_low: 0.8, ci_high: 0.95 }, { id: "y", price: 5, quality: 0.9, ci_low: 0.8, ci_high: 0.95 }]).get("y")!.on_frontier, true, "identical points do not dominate each other");
eq(recommend(pts.slice(0, 3), { min_quality: 0.8 })?.id, "budget", "with a quality floor, the cheapest frontier provider");
eq(recommend(pts.slice(0, 3), { max_price_cents: 10 })?.id, "careful", "with a budget, the best frontier provider within it");
eq(recommend(pts, {}), null, "no constraints, no pick");
console.log("pareto checks passed");
