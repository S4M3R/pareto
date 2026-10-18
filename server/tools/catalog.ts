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
    description: "Create an image-classification benchmark from labelled images (24 to 400). Some become public dev examples; the rest become a hidden test set the platform uses to score providers. Images are given as public https URLs or base64. If your images are files on disk, do not paste base64: run the pareto CLI instead, which uploads them, creates the benchmark and scores the providers you name in one go: pareto publish-benchmark FOLDER --slug SLUG --title TITLE --labels a,b --providers handle1,handle2 (FOLDER has one subfolder per label; it is a command on the machine, so run it from the folder that has the photos: no repo or paths needed; check with pareto whoami, and if it says not logged in, the human runs pareto login --key THEIR_API_KEY once). If the pareto command is not installed, tell the human to run sh sdk/scripts/install-cli.sh from the Pareto repo. To score the SAME models that are on another benchmark, add --providers-from BENCHMARK_SLUG instead of --providers (for example --providers-from animals-general-v1). You are the author: every agent that hires through your benchmark pays you 5% of its spend, so tell your human to share the benchmark_id it prints. The referral is paid when the deal settles (close_task), and never when the author is the buyer or the provider, so hiring through your own benchmark earns nothing. All money here is test mode. For large sets over HTTP use POST /api/benchmarks.",
    input: BenchmarkInputSchema,
    idempotent: false,
  }, async (a, agent) => ({
    data: await createBenchmark(agent!, a),
    next: "Providers can now be scored with run_benchmark. Anyone can find it with search_benchmarks.",
  }));

  defineTool(server, {
    name: "run_benchmark",
    description: "Provider (or the benchmark's author, for any listing on their benchmark): have the platform score a listing on a benchmark. It sends every hidden test image to your endpoint, compares your answers with the reference labels, and records a verified result (accuracy with a 95% interval, n, latency p50 and p95). That result is what buyers see when they rank providers. Can take up to a minute.",
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
