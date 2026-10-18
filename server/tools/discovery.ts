import { z } from "zod";
import { MarketError } from "../lib/errors.js";
import { matchBenchmarks } from "../lib/search.js";
import { round } from "../lib/stats.js";
import { analyze, recommend } from "../lib/pareto.js";
import { CompareProvidersOut, FindProvidersOut, GetProviderOut, SearchBenchmarksOut } from "../lib/schemas.js";
import { type Row, db, handlesOf, must } from "./common.js";
import { type AnyServer, defineTool } from "./define.js";

async function latestResults(benchmarkId: string): Promise<Row[]> {
  const { data } = await db.from("benchmark_results").select("*").eq("benchmark_id", benchmarkId).order("created_at", { ascending: false });
  const seen = new Set<string>();
  return (data ?? []).filter((r) => (seen.has(r.listing_id) ? false : seen.add(r.listing_id)));
}

async function reputationOf(agentIds: string[]): Promise<Record<string, Row>> {
  const { data } = await db.from("agent_reputation").select("*").in("agent_id", agentIds);
  return Object.fromEntries((data ?? []).map((r) => [r.agent_id, r]));
}

/** Top results for a benchmark, for the benchmark card. Same verified numbers find_providers ranks on. */
async function leaderboardFor(benchmarkId: string, limit = 3) {
  const results = (await latestResults(benchmarkId)).sort((a, b) => b.quality - a.quality).slice(0, limit);
  if (results.length === 0) return [];
  const { data: listings } = await db.from("listings").select("id,provider_id,title,pricing").in("id", results.map((r) => r.listing_id));
  const handle = await handlesOf((listings ?? []).map((l) => l.provider_id));
  return results.flatMap((r) => {
    const l = (listings ?? []).find((x) => x.id === r.listing_id);
    if (!l) return [];
    return [{ provider: handle[l.provider_id] ?? "unknown", title: l.title, quality: round(r.quality), ci95: [round(r.ci_low), round(r.ci_high)], n: r.n, price_cents_per_call: Number((l.pricing as Row).amount_cents) }];
  });
}

interface Constraints { benchmark_id: string; min_quality?: number; max_price_cents?: number; max_p95_ms?: number }

/** Providers scored on a benchmark, with constraints applied, best quality first (ties broken by price). Shared by
 * find_providers and compare_providers so both rank on exactly the same verified numbers. */
async function rankProviders(a: Constraints) {
  const results = await latestResults(a.benchmark_id);
  if (results.length === 0) throw new MarketError("no_results", "No scored providers for this benchmark yet.", "Try another benchmark_id from search_benchmarks.");
  const { data: listings } = await db.from("listings").select("id,provider_id,title,capability,kind,pricing,sla,seeded,active").in("id", results.map((r) => r.listing_id));
  const rep = await reputationOf((listings ?? []).map((l) => l.provider_id));
  const { data: agents } = await db.from("agents").select("id,handle").in("id", (listings ?? []).map((l) => l.provider_id));
  const handle = Object.fromEntries((agents ?? []).map((x) => [x.id, x.handle]));
  const rows = results.flatMap((r) => {
    const l = (listings ?? []).find((x) => x.id === r.listing_id);
    if (!l || !l.active) return [];
    const price = Number((l.pricing as Row).amount_cents);
    if (a.min_quality !== undefined && r.quality < a.min_quality) return [];
    if (a.max_price_cents !== undefined && price > a.max_price_cents) return [];
    if (a.max_p95_ms !== undefined && r.p95_ms > a.max_p95_ms) return [];
    const p = rep[l.provider_id] ?? {};
    return [{
      listing_id: l.id, provider: handle[l.provider_id], title: l.title,
      quality: round(r.quality), ci95: [round(r.ci_low), round(r.ci_high)], n: r.n, verified: r.verified,
      price_cents_per_call: price, p50_ms: r.p50_ms, p95_ms: r.p95_ms,
      reputation: { settled_agreements: p.settled_agreements ?? 0, disputes_against: p.disputes_against ?? 0, disputes_upheld_against: p.disputes_upheld_against ?? 0, reviews: p.review_count ?? 0, avg_accuracy: p.avg_accuracy ?? null },
      seeded: l.seeded, tied_with_previous: false,
    }];
  }).sort((x, y) => y.quality - x.quality || x.price_cents_per_call - y.price_cents_per_call);
  rows.forEach((row, i) => { if (i > 0) row.tied_with_previous = row.ci95[1] >= rows[i - 1].ci95[0] && row.ci95[0] <= rows[i - 1].ci95[1]; });
  return rows;
}

export function registerDiscovery(server: AnyServer) {
  defineTool(server, {
    name: "search_benchmarks",
    description: "Find public benchmarks closest to the task you need done by another agent (e.g. 'extract structured fields from profile pages'). Returns matches with a confidence and why. Start here, then call find_providers.",
    input: z.object({
      task: z.string().min(5).describe("Plain-language description of the capability you need"),
      sample_inputs: z.array(z.string()).max(10).optional().describe("A few example inputs; improves matching"),
    }),
    readOnly: true,
    show: {
      name: "show_benchmarks",
      description: "Display only: shows the human the matching benchmarks and their verified leaderboard as a card. Use it when they ask to see the benchmarks; to search for yourself use search_benchmarks.",
      view: { name: "benchmark-card", description: "Matching benchmarks with their verified leaderboard" },
      output: SearchBenchmarksOut,
    },
  }, async ({ task, sample_inputs }) => {
    const { data } = await db.from("benchmarks").select("id,slug,title,task,category,metric,fingerprint,version,seeded,dev_examples,n_test").eq("visibility", "public");
    const rows = (data ?? []) as Row[];
    const matches = matchBenchmarks(task, sample_inputs ?? [], rows as never).slice(0, 3);
    const good = await Promise.all(
      matches.filter((m) => m.match_confidence >= 0.2).map(async (m) => {
        const b = rows.find((r) => r.id === m.benchmark_id)!;
        return { ...m, category: b.category, metric: b.metric, n_test: b.n_test, fingerprint: b.fingerprint ?? null, version: b.version, seeded: b.seeded, leaderboard: await leaderboardFor(m.benchmark_id) };
      }),
    );
    if (good.length === 0) {
      return { data: { matches: [], note: "No public benchmark matches this task well." }, next: "Describe the task differently, or propose a benchmark with create_task + your own acceptance evals." };
    }
    return { data: { matches: good }, next: `find_providers with benchmark_id=${good[0].benchmark_id}` };
  });

  defineTool(server, {
    name: "find_providers",
    description: "Rank providers on a benchmark by verified quality, with price, latency, reputation and dispute record. Apply your constraints here; every number carries n and a 95% interval, and statistical ties are marked.",
    input: z.object({
      benchmark_id: z.string().uuid(),
      min_quality: z.number().min(0).max(1).optional(),
      max_price_cents: z.number().int().positive().optional().describe("Max price per call in cents"),
      max_p95_ms: z.number().int().positive().optional(),
    }),
    readOnly: true,
  }, async (a) => {
    const rows = await rankProviders(a);
    if (rows.length === 0) {
      return { data: { providers: [], note: "No provider meets all constraints." }, next: "Relax one constraint: max_price_cents, max_p95_ms, or min_quality." };
    }
    return { data: { providers: rows, note: "quality = mean field accuracy on the hidden test set; n = test items" }, next: "get_provider for reviews and detail, or create_task then propose_agreement." };
  });

  defineTool(server, {
    name: "compare_providers",
    description: "Display only: shows the human a Pareto chart comparing providers on a benchmark, so they can choose. Call it when the human wants to see or compare options, not for your own lookups (use find_providers for that). The chart plots quality (with 95% interval) against price per call, with the efficient frontier marked and the other providers shown as dominated (someone is at least as good and no more expensive). Also compares latency and quality per dollar. Use after find_providers when the choice is a price/quality trade-off. Pass your constraints to get a pick.",
    input: z.object({
      benchmark_id: z.string().uuid(),
      min_quality: z.number().min(0).max(1).optional(),
      max_price_cents: z.number().int().positive().optional().describe("Max price per call in cents"),
      max_p95_ms: z.number().int().positive().optional(),
    }),
    readOnly: true,
    output: CompareProvidersOut,
    view: { name: "pareto-chart", description: "Quality versus price with the Pareto frontier, plus latency and value comparisons" },
  }, async (a) => {
    const rows = await rankProviders(a);
    const b = await must<Row>(db.from("benchmarks").select("id,slug,title,metric,n_test").eq("id", a.benchmark_id).maybeSingle(), "benchmark");
    if (rows.length === 0) {
      return { data: { benchmark: b, providers: [], recommendation: null, note: "No provider meets all constraints." }, next: "Relax one constraint: max_price_cents, max_p95_ms, or min_quality." };
    }
    const scored = rows.map((r) => ({ id: r.listing_id, price: r.price_cents_per_call, quality: r.quality, ci_low: r.ci95[0], ci_high: r.ci95[1] }));
    const verdicts = analyze(scored);
    const pick = recommend(scored.filter((s) => verdicts.get(s.id)!.on_frontier), a);
    const providers = rows.map((r) => {
      const v = verdicts.get(r.listing_id)!;
      const rep = r.reputation;
      return {
        listing_id: r.listing_id, provider: r.provider, title: r.title, quality: r.quality, ci95: r.ci95, n: r.n, verified: r.verified,
        price_cents_per_call: r.price_cents_per_call, p50_ms: r.p50_ms, p95_ms: r.p95_ms,
        upheld_per_settled: rep.settled_agreements > 0 ? round(rep.disputes_upheld_against / rep.settled_agreements, 2) : null,
        settled_agreements: rep.settled_agreements, seeded: r.seeded,
        on_frontier: v.on_frontier, dominated_by: v.dominated_by ? rows.find((x) => x.listing_id === v.dominated_by)!.provider : null,
        confidently_dominated: v.confidently_dominated,
      };
    });
    const hit = pick ? rows.find((r) => r.listing_id === pick.id)! : null;
    return {
      data: {
        benchmark: b, providers,
        recommendation: hit && pick ? { listing_id: hit.listing_id, provider: hit.provider, reason: pick.reason } : null,
        note: "Frontier = no other provider is at least as good on quality and no more expensive. Dominance by point estimate can be noise: confidently_dominated also needs a clearly higher 95% interval.",
      },
      next: hit ? `create_task, then propose_agreement with listing_id=${hit.listing_id}.` : "Pick a provider on the frontier, or pass min_quality / max_price_cents for a recommendation.",
      say: `The comparison chart is on the user's screen. ${hit && pick ? `Our pick: ${hit.provider}. ${pick.reason}` : "No constraints were given, so there is no pick; the frontier is the shortlist."} Reply in one or two short sentences and do not list the numbers the chart shows.`,
    };
  });

  defineTool(server, {
    name: "get_provider",
    description: "Detail for one provider listing: price, SLA, benchmark results, dispute record, and recent reviews with ratings.",
    input: z.object({ listing_id: z.string().uuid() }),
    readOnly: true,
    show: {
      name: "show_provider",
      description: "Display only: shows the human one provider's profile (price, benchmark results, dispute record, reviews) as a card. To read it yourself use get_provider.",
      view: { name: "provider-profile", description: "One provider: price, benchmark results, dispute record and reviews" },
      output: GetProviderOut,
    },
  }, async ({ listing_id }) => {
    const l = await must<Row>(db.from("listings").select("id,provider_id,title,capability,kind,pricing,sla,seeded,created_at").eq("id", listing_id).maybeSingle(), "listing");
    const { data: res } = await db.from("benchmark_results").select("benchmark_id,quality,ci_low,ci_high,n,p50_ms,p95_ms,verified,created_at").eq("listing_id", listing_id).order("created_at", { ascending: false }).limit(3);
    const rep = (await reputationOf([l.provider_id]))[l.provider_id] ?? {};
    const { data: rev } = await db.from("reviews").select("ratings,comment,weight,seeded,created_at").eq("reviewee_id", l.provider_id).order("created_at", { ascending: false }).limit(5);
    const provider = (await handlesOf([l.provider_id]))[l.provider_id];
    return { data: { provider, listing: l, results: res ?? [], reputation: rep, recent_reviews: rev ?? [] }, next: "create_task, then propose_agreement with this listing_id." };
  });
}
