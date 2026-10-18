import { z } from "zod";
import { runBenchmark, createBenchmark, listBenchmarks } from "../lib/benchmarks.js";
import { BASE_URL } from "../lib/env.js";
import { liveImages } from "../lib/image-data.js";
import { BenchmarkInputSchema, RunBenchmarkSchema } from "../lib/inputs.js";
import { listListings } from "../lib/listings.js";
import { type AnyServer, defineTool } from "./define.js";

/** Browsing the catalogue, and the provider-side lifecycle: create a benchmark, get scored on it. */
export function registerCatalog(server: AnyServer) {
  defineTool(server, {
    name: "list_listings",
    description: "Browse active provider listings (title, capability, price, committed latency). Endpoint URLs are never shown. To compare quality, use search_benchmarks then find_providers.",
    input: z.object({ capability: z.string().optional().describe("e.g. image-classification") }),
    readOnly: true,
  }, async (a) => ({ data: { listings: await listListings({ capability: a.capability }) }, next: "search_benchmarks to find how they score, then find_providers." }));

  defineTool(server, {
    name: "list_benchmarks",
    description: "Browse public benchmarks. A benchmark is a hidden, labelled test set plus a metric; providers are ranked on their scores.",
    input: z.object({ category: z.string().optional().describe("e.g. image-classification") }),
    readOnly: true,
  }, async (a) => ({ data: { benchmarks: await listBenchmarks(a.category) }, next: "find_providers with a benchmark_id, or run_benchmark to score your own listing." }));

  defineTool(server, {
    name: "create_benchmark",
    description: "Create an image-classification benchmark from labelled images (24 to 400). Some become public dev examples; the rest become a hidden test set the platform uses to score providers. Images are given as public https URLs or base64. For large sets use the REST API (POST /api/benchmarks).",
    input: BenchmarkInputSchema,
    idempotent: false,
  }, async (a, agent) => ({
    data: await createBenchmark(agent!, a),
    next: "Providers can now be scored with run_benchmark. Anyone can find it with search_benchmarks.",
  }));

  defineTool(server, {
    name: "run_benchmark",
    description: "Provider: have the platform score one of your listings on a benchmark. It sends every hidden test image to your endpoint, compares your answers with the reference labels, and records a verified result (accuracy with a 95% interval, n, latency p50 and p95). That result is what buyers see when they rank providers. Can take up to a minute.",
    input: RunBenchmarkSchema,
    role: "provider",
  }, async (a, agent, ctx) => ({
    data: await runBenchmark(agent!, a, (done, total) => ctx?.reportProgress?.(done, total, `${done} of ${total} test images scored`)),
    next: "find_providers with this benchmark_id now includes your listing, ranked on the verified score.",
  }));

  defineTool(server, {
    name: "list_sample_images",
    description: "Ids and URLs of sample images you can use to try an image-classification provider (call_provider with image_id). The platform keeps the reference labels to check results; they are not shown.",
    input: z.object({ limit: z.number().int().min(1).max(50).default(12) }),
    readOnly: true,
  }, async (a) => {
    const images = liveImages().slice(0, a.limit).map((i) => ({ image_id: i.id, url: `${BASE_URL}/images/${i.id}.jpg` }));
    return { data: { total_available: liveImages().length, images }, next: "call_provider with {agreement_id, image_id}." };
  });
}
