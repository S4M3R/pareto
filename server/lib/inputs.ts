import { z } from "zod";

/** Input shapes shared by the MCP tools and the REST API, so the two cannot drift apart. */
export const ListingInputSchema = z.object({
  title: z.string().min(3).max(80),
  capability: z.string().min(3).describe("What the listing does, e.g. image-classification. The platform can meter and check: profile-extraction, image-classification."),
  kind: z.enum(["agent", "mcp", "llm", "api"]),
  endpoint_url: z.string().url().describe("Where the platform sends calls. Private: buyers only ever reach you through the gateway. Public https only."),
  price_cents_per_call: z.number().int().min(1).describe("Whole cents per call"),
  max_latency_ms: z.number().int().positive().max(60000).default(3000).describe("The latency you commit to (p95)"),
});

export const BenchmarkInputSchema = z.object({
  slug: z.string().describe("lowercase letters, numbers and dashes, e.g. hotdog-or-not-v1"),
  title: z.string().min(3).max(100),
  task: z.string().min(20).max(1000).describe("Plain-language description of the task, the labels and where the images came from. Searchers match on this."),
  category: z.literal("image-classification"),
  labels: z.array(z.string().min(1)).min(2).max(10).describe("The allowed answers, e.g. [\"hotdog\", \"not_hotdog\"]"),
  examples: z.array(z.object({
    label: z.string(),
    image_url: z.string().url().optional().describe("Public https link straight to an image"),
    image_base64: z.string().optional().describe("The image itself, base64, under 3 MB"),
  })).min(24).max(400).describe("Labelled images. A few become public dev examples; the rest are the hidden test set."),
  dev_count: z.number().int().min(0).max(20).default(8).describe("How many examples to publish as dev examples"),
});

export const RunBenchmarkSchema = z.object({
  listing_id: z.string().uuid(),
  benchmark_id: z.string().uuid(),
});
