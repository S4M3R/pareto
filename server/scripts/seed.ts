/** Seeds the demo world. Everything created here is flagged seeded=true and shown as such.
 * Benchmark results are real runs of the provider code against the hidden test pages. */
import "../lib/env.js";
import { createHash } from "node:crypto";
import { BASE_URL } from "../lib/env.js";
import { sha256 } from "../lib/auth.js";
import { demoKey } from "../lib/demo-keys.js";
import { db } from "../lib/db.js";
import { FIELDS, html, scoreFields, truth } from "../lib/fixtures.js";
import { PROVIDERS, extract } from "../lib/providers.js";
import { meanCI, percentile } from "../lib/stats.js";

export const DEMO_KEYS = {
  "demo-buyer": demoKey("demo-buyer"),
  "careful-extractor": demoKey("careful-extractor"),
  "budget-extractor": demoKey("budget-extractor"),
  "fastscrape-pro": demoKey("fastscrape-pro"),
};

async function upsertAgent(handle: string, roles: string[], owner: string, desc: string, key?: string, seeded = true) {
  const row = { handle, roles, owner_ref: owner, description: desc, seeded, ...(key ? { api_key_hash: sha256(key) } : {}) };
  const { data, error } = await db.from("agents").upsert(row, { onConflict: "handle" }).select("id").single();
  if (error) throw error;
  return data.id as string;
}

async function main() {
  const buyer = await upsertAgent("demo-buyer", ["buyer"], "acme-co", "Demo buyer agent (seeded)", DEMO_KEYS["demo-buyer"]);
  await db.from("spending_policies").upsert({ agent_id: buyer, max_per_agreement_cents: 500, max_total_cents: 2000 });

  const providerIds: Record<string, string> = {};
  const listingIds: Record<string, string> = {};
  const meta: Record<string, { handle: string; owner: string; desc: string; key: string }> = {
    careful: { handle: "careful-extractor", owner: "careful-labs", desc: "Accurate structured extraction (seeded)", key: DEMO_KEYS["careful-extractor"] },
    cheap: { handle: "budget-extractor", owner: "budgetworks", desc: "Low-cost extraction (seeded)", key: DEMO_KEYS["budget-extractor"] },
    sloppy: { handle: "fastscrape-pro", owner: "fastscrape-inc", desc: "Fast extraction (seeded)", key: DEMO_KEYS["fastscrape-pro"] },
  };
  for (const [k, spec] of Object.entries(PROVIDERS)) {
    const m = meta[k];
    providerIds[k] = await upsertAgent(m.handle, ["provider"], m.owner, m.desc, m.key);
    const { data: existing } = await db.from("listings").select("id").eq("provider_id", providerIds[k]).eq("capability", "profile-extraction").maybeSingle();
    const row = {
      provider_id: providerIds[k], title: spec.title, capability: "profile-extraction", kind: "api", endpoint_type: "http",
      endpoint_url: `${BASE_URL}/providers/${k}/extract`, pricing: { model: "per_call", amount_cents: spec.priceCents },
      sla: { p95_ms: 1500 }, active: true, seeded: true,
    };
    if (existing) { await db.from("listings").update(row).eq("id", existing.id); listingIds[k] = existing.id; }
    else listingIds[k] = (await db.from("listings").insert(row).select("id").single()).data!.id;
  }

  // Benchmark: 8 public dev pages, 100 hidden test pages (ids 1000..1099).
  const devIds = [1, 2, 3, 4, 5, 6, 7, 8];
  const testIds = Array.from({ length: 100 }, (_, i) => 1000 + i);
  const { data: bench, error: be } = await db.from("benchmarks").upsert({
    slug: "profile-extraction-v1", title: "Profile page extraction",
    task: "Extract structured fields (name, title, company, location, years of experience, skills) from a profile web page into JSON. Web data extraction of person profile pages.",
    category: "web-data-extraction", metric: "field accuracy", visibility: "public",
    dev_examples: devIds.map((id) => ({ page_id: id, html: html(id), expected: truth(id) })),
    n_test: testIds.length, fingerprint: createHash("sha256").update(testIds.join(",")).digest("hex").slice(0, 16), seeded: true,
  }, { onConflict: "slug" }).select("id").single();
  if (be) throw be;
  await db.from("benchmark_tests").upsert({ benchmark_id: bench.id, examples: testIds.map((id) => ({ page_id: id, expected: truth(id) })) });

  // Real runs of each provider's code on the hidden pages (latency is the provider's simulated service time).
  for (const [k, spec] of Object.entries(PROVIDERS)) {
    const accs: number[] = [];
    const lats: number[] = [];
    for (const id of testIds) {
      const r = await extract(k, id, false);
      accs.push(scoreFields(r.fields, id).accuracy);
      lats.push(r.latency_ms);
    }
    const ci = meanCI(accs);
    await db.from("benchmark_results").insert({
      benchmark_id: bench.id, listing_id: listingIds[k], quality: ci.mean, ci_low: ci.low, ci_high: ci.high, n: testIds.length,
      cost_per_call_cents: spec.priceCents, p50_ms: Math.round(percentile(lats, 0.5)), p95_ms: Math.round(percentile(lats, 0.95)),
      verified: true, seeded: true,
    });
    console.log(`${k.padEnd(8)} quality=${ci.mean.toFixed(3)} [${ci.low.toFixed(3)}, ${ci.high.toFixed(3)}] p50=${Math.round(percentile(lats, 0.5))}ms p95=${Math.round(percentile(lats, 0.95))}ms price=${spec.priceCents}c`);
  }

  // Labelled history so reputation is not empty: past settled agreements with independent seeded buyers.
  const { count } = await db.from("reviews").select("id", { count: "exact", head: true }).eq("seeded", true);
  if (!count) {
    const hist = [
      { k: "careful", reviews: [[5, 5, 5, 4], [5, 4, 5, 5], [5, 5, 4, 4], [4, 5, 5, 4], [5, 5, 5, 5], [5, 4, 5, 4]], upheld: 0, comments: ["Accurate every time.", "Clear terms, no surprises.", "Worth the price."] },
      { k: "cheap", reviews: [[3, 4, 4, 5], [4, 4, 3, 5], [3, 4, 4, 5], [3, 3, 4, 5]], upheld: 0, comments: ["Cheap and fast but misses fields.", "Fine for low-stakes work."] },
      { k: "sloppy", reviews: [[3, 2, 3, 2], [2, 2, 3, 3], [3, 2, 2, 2], [2, 3, 3, 2], [3, 2, 3, 3]], upheld: 2, comments: ["Slow outliers broke our SLA.", "Billed twice on a few calls."] },
    ];
    let n = 0;
    for (const h of hist) {
      for (let i = 0; i < h.reviews.length; i++) {
        const hb = await upsertAgent(`history-buyer-${h.k}-${i}`, ["buyer"], `history-owner-${h.k}-${i}`, "Seeded history buyer");
        const task = (await db.from("tasks").insert({ buyer_id: hb, title: "Seeded past task", description: "Seeded history (not a live agreement)" }).select("id").single()).data!.id;
        const ag = (await db.from("agreements").insert({
          task_id: task, listing_id: listingIds[h.k], buyer_id: hb, provider_id: providerIds[h.k], status: "settled",
          terms: { seeded: true, budget_cap_cents: 200, price: { amount_cents: PROVIDERS[h.k].priceCents } }, closed_at: new Date(Date.now() - (i + 2) * 86400000).toISOString(),
        }).select("id").single()).data!.id;
        const [accuracy, sla, clarity, cost_fairness] = h.reviews[i];
        await db.from("reviews").insert({ agreement_id: ag, reviewer_id: hb, reviewee_id: providerIds[h.k], ratings: { accuracy, sla, clarity, cost_fairness }, comment: h.comments[i % h.comments.length], weight: 2, seeded: true });
        if (i < h.upheld) {
          await db.from("disputes").insert({ agreement_id: ag, scope: "full", opened_by: hb, claim_type: "sla_breach", claim: { seeded: true }, status: "resolved", verdict: { outcome: "upheld", seeded: true, reasoning: "Seeded history." }, resolved_at: new Date().toISOString() });
        }
        n++;
      }
    }
    console.log(`seeded ${n} past agreements with reviews`);
  }
  console.log("\nDemo API keys (test-mode demo accounts):");
  for (const [h, k] of Object.entries(DEMO_KEYS)) console.log(`  ${h.padEnd(18)} ${k}`);
  console.log("\nbenchmark_id:", bench.id, " fields:", FIELDS.join(","));
}
main().catch((e) => { console.error(e); process.exit(1); });
