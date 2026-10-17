import type { MCPServer } from "mcp-use";
import { z } from "zod";
import { MarketError } from "../lib/errors.js";
import { matchBenchmarks } from "../lib/search.js";
import { round } from "../lib/stats.js";
import { type Row, db, must } from "./common.js";
import { defineTool } from "./define.js";

async function latestResults(benchmarkId: string): Promise<Row[]> {
  const { data } = await db.from("benchmark_results").select("*").eq("benchmark_id", benchmarkId).order("created_at", { ascending: false });
  const seen = new Set<string>();
  return (data ?? []).filter((r) => (seen.has(r.listing_id) ? false : seen.add(r.listing_id)));
}

async function reputationOf(agentIds: string[]): Promise<Record<string, Row>> {
  const { data } = await db.from("agent_reputation").select("*").in("agent_id", agentIds);
  return Object.fromEntries((data ?? []).map((r) => [r.agent_id, r]));
}

export function registerDiscovery(server: MCPServer) {
  defineTool(server, {
    name: "search_benchmarks",
    description: "Find public benchmarks closest to the task you need done by another agent (e.g. 'extract structured fields from profile pages'). Returns matches with a confidence and why. Start here, then call find_providers.",
    input: z.object({
      task: z.string().min(5).describe("Plain-language description of the capability you need"),
      sample_inputs: z.array(z.string()).max(10).optional().describe("A few example inputs; improves matching"),
    }),
    readOnly: true,
  }, async ({ task, sample_inputs }) => {
    const { data } = await db.from("benchmarks").select("id,slug,title,task,category,dev_examples,n_test").eq("visibility", "public");
    const matches = matchBenchmarks(task, sample_inputs ?? [], (data ?? []) as never).slice(0, 3);
    const good = matches.filter((m) => m.match_confidence >= 0.2);
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
    if (rows.length === 0) {
      return { data: { providers: [], note: "No provider meets all constraints." }, next: "Relax one constraint: max_price_cents, max_p95_ms, or min_quality." };
    }
    return { data: { providers: rows, note: "quality = mean field accuracy on the hidden test set; n = test items" }, next: "get_provider for reviews and detail, or create_task then propose_agreement." };
  });

  defineTool(server, {
    name: "get_provider",
    description: "Detail for one provider listing: price, SLA, benchmark results, dispute record, and recent reviews with ratings.",
    input: z.object({ listing_id: z.string().uuid() }),
    readOnly: true,
  }, async ({ listing_id }) => {
    const l = await must<Row>(db.from("listings").select("id,provider_id,title,capability,kind,pricing,sla,seeded,created_at").eq("id", listing_id).maybeSingle(), "listing");
    const { data: res } = await db.from("benchmark_results").select("benchmark_id,quality,ci_low,ci_high,n,p50_ms,p95_ms,verified,created_at").eq("listing_id", listing_id).order("created_at", { ascending: false }).limit(3);
    const rep = (await reputationOf([l.provider_id]))[l.provider_id] ?? {};
    const { data: rev } = await db.from("reviews").select("ratings,comment,weight,seeded,created_at").eq("reviewee_id", l.provider_id).order("created_at", { ascending: false }).limit(5);
    return { data: { listing: l, results: res ?? [], reputation: rep, recent_reviews: rev ?? [] }, next: "create_task, then propose_agreement with this listing_id." };
  });
}
