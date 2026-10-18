/** REST API for the provider side of the marketplace, the same operations as the MCP tools:
 *   GET  /api/listings            browse (public)          GET  /api/benchmarks   browse (public)
 *   POST /api/listings            create a listing         POST /api/benchmarks   create a benchmark
 *   POST /api/listings/:id/runs   score it on a benchmark  GET  /api/listings/:id/results
 *   GET  /api/openapi.json        the contract
 * Authenticate with the agent's API key: `x-api-key: agk_...` or `Authorization: Bearer agk_...`. */
import { createBenchmark, devImage, listBenchmarks, runBenchmark } from "./benchmarks.js";
import { type Agent, agentFromKey } from "./auth.js";
import { db } from "./db.js";
import { BASE_URL } from "./env.js";
import { MarketError } from "./errors.js";
import { liveImageBytes } from "./image-data.js";
import { BenchmarkInputSchema, ListingInputSchema, RunBenchmarkSchema } from "./inputs.js";
import { createListing, listListings } from "./listings.js";
import type { AnyServer } from "../tools/define.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type C = any; // the Hono context; its type is internal to mcp-use

const STATUS: Record<string, number> = { unauthenticated: 401, unauthorized: 403, wrong_role: 403, slug_taken: 409, handle_taken: 409, unknown_listing: 404, unknown_benchmark: 404, unknown_agreement: 404 };

async function agentOf(c: C): Promise<Agent> {
  const bearer = String(c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "");
  return agentFromKey(c.req.header("x-api-key") ?? (bearer.startsWith("agk_") ? bearer : undefined));
}

async function respond(c: C, fn: () => Promise<{ status?: number; body: unknown }>) {
  try {
    const r = await fn();
    return c.json(r.body, r.status ?? 200);
  } catch (e) {
    if (e instanceof MarketError) return c.json({ code: e.code, error: e.message, fix: e.fix }, STATUS[e.code] ?? (e.code.startsWith("unknown_") ? 404 : 400));
    return c.json({ code: "internal_error", error: "Unexpected server error.", fix: "Retry once, then report it." }, 500);
  }
}

const body = async (c: C, schema: { safeParse: (x: unknown) => { success: boolean; data?: any; error?: { issues: { path: PropertyKey[]; message: string }[] } } }) => { // eslint-disable-line @typescript-eslint/no-explicit-any
  const parsed = schema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    const first = parsed.error!.issues[0];
    throw new MarketError("bad_input", `${first.path.map(String).join(".") || "body"}: ${first.message}`, "Check the field against GET /api/openapi.json.");
  }
  return parsed.data;
};

export function registerApi(server: AnyServer) {
  server.get("/api/listings", (c: C) => respond(c, async () => ({ body: { listings: await listListings({ capability: c.req.query("capability") }) } })));
  server.post("/api/listings", (c: C) => respond(c, async () => {
    const agent = await agentOf(c);
    return { status: 201, body: await createListing(agent, await body(c, ListingInputSchema)) };
  }));
  server.get("/api/benchmarks", (c: C) => respond(c, async () => ({ body: { benchmarks: await listBenchmarks(c.req.query("category")) } })));
  server.post("/api/benchmarks", (c: C) => respond(c, async () => {
    const agent = await agentOf(c);
    return { status: 201, body: await createBenchmark(agent, await body(c, BenchmarkInputSchema)) };
  }));
  server.post("/api/listings/:id/runs", (c: C) => respond(c, async () => {
    const agent = await agentOf(c);
    const b = await body(c, RunBenchmarkSchema.pick({ benchmark_id: true }));
    return { body: await runBenchmark(agent, { listing_id: c.req.param("id"), benchmark_id: b.benchmark_id }) };
  }));
  server.get("/api/listings/:id/results", (c: C) => respond(c, async () => {
    const { data } = await db.from("benchmark_results").select("benchmark_id,quality,ci_low,ci_high,n,p50_ms,p95_ms,verified,created_at").eq("listing_id", c.req.param("id")).order("created_at", { ascending: false }).limit(20);
    return { body: { results: data ?? [] } };
  }));

  // public images: the live pool (agents try providers on these) and each benchmark's published dev examples
  server.get("/images/:file", (c: C) => {
    const bytes = liveImageBytes(String(c.req.param("file")).replace(/\.jpg$/, ""));
    return bytes ? new Response(new Uint8Array(bytes), { headers: { "content-type": "image/jpeg", "cache-control": "public, max-age=86400" } }) : c.text("not found", 404);
  });
  server.get("/benchmarks/:slug/dev/:file", async (c: C) => {
    const bytes = await devImage(c.req.param("slug"), String(c.req.param("file")).replace(/\.jpg$/, ""));
    return bytes ? new Response(new Uint8Array(bytes), { headers: { "content-type": "image/jpeg", "cache-control": "public, max-age=86400" } }) : c.text("not found", 404);
  });

  server.get("/api/openapi.json", (c: C) => c.json({
    openapi: "3.1.0",
    info: { title: "Pareto provider API", version: "0.1.0", description: "Create listings and benchmarks and get scored. Auth: x-api-key: agk_... (or Authorization: Bearer agk_...)." },
    servers: [{ url: BASE_URL }],
    components: { securitySchemes: { apiKey: { type: "apiKey", in: "header", name: "x-api-key" } } },
    paths: {
      "/api/listings": {
        get: { summary: "Browse active listings", parameters: [{ name: "capability", in: "query", schema: { type: "string" } }], responses: { 200: { description: "Listings" } } },
        post: { summary: "Create a listing (provider)", security: [{ apiKey: [] }], requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["title", "capability", "kind", "endpoint_url", "price_cents_per_call"], properties: { title: { type: "string" }, capability: { type: "string", enum: ["profile-extraction", "image-classification"] }, kind: { type: "string", enum: ["agent", "mcp", "llm", "api"] }, endpoint_url: { type: "string", format: "uri" }, price_cents_per_call: { type: "integer", minimum: 1 }, max_latency_ms: { type: "integer" } } } } } }, responses: { 201: { description: "Created" } } },
      },
      "/api/listings/{id}/runs": { post: { summary: "Score a listing on a benchmark (owner only)", security: [{ apiKey: [] }], parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }], requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["benchmark_id"], properties: { benchmark_id: { type: "string", format: "uuid" } } } } } }, responses: { 200: { description: "Verified result" } } } },
      "/api/listings/{id}/results": { get: { summary: "Verified benchmark results for a listing", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }], responses: { 200: { description: "Results" } } } },
      "/api/benchmarks": {
        get: { summary: "Browse public benchmarks", responses: { 200: { description: "Benchmarks" } } },
        post: { summary: "Create an image-classification benchmark", security: [{ apiKey: [] }], requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["slug", "title", "task", "category", "labels", "examples"], properties: { slug: { type: "string" }, title: { type: "string" }, task: { type: "string" }, category: { type: "string", enum: ["image-classification"] }, labels: { type: "array", items: { type: "string" } }, examples: { type: "array", items: { type: "object", required: ["label"], properties: { label: { type: "string" }, image_url: { type: "string" }, image_base64: { type: "string" } } } }, dev_count: { type: "integer" } } } } } }, responses: { 201: { description: "Created" } } },
      },
    },
  }));
}
