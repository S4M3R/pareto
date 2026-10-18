import { createHash } from "node:crypto";
import { capabilityFor } from "./capabilities.js";
import type { Agent } from "./auth.js";
import { db, must } from "./db.js";
import { assertPublicUrl } from "./endpoints.js";
import { MarketError } from "./errors.js";
import { endpointFor } from "./gateway.js";
import { normalizeImage } from "./image-split.js";
import { percentile, round, wilson } from "./stats.js";

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface ExampleInput { label: string; image_url?: string; image_base64?: string }
export interface BenchmarkInput {
  slug: string; title: string; task: string; category: "image-classification"; labels: string[]; examples: ExampleInput[]; dev_count?: number;
}
interface Stored { id: string; label: string; split: "dev" | "test"; b64: string }

const MAX_IMAGE_BYTES = 3_000_000;
const sha1 = (s: string | Buffer) => createHash("sha1").update(s).digest("hex");

async function fetchImage(url: string): Promise<Buffer> {
  const u = assertPublicUrl(url, "image_url");
  const r = await fetch(u, { signal: AbortSignal.timeout(10_000), redirect: "error" }).catch(() => undefined);
  if (!r || !r.ok) throw new MarketError("bad_input", `Could not download ${url}.`, "Check the URL is public and returns the image directly (no redirects).");
  if (!(r.headers.get("content-type") ?? "").startsWith("image/")) throw new MarketError("bad_input", `${url} is not an image.`, "Send direct links to image files.");
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > MAX_IMAGE_BYTES) throw new MarketError("bad_input", `${url} is larger than ${MAX_IMAGE_BYTES / 1e6} MB.`, "Use smaller images.");
  return buf;
}

async function inParallel<T, R>(items: T[], n: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

/** Create a benchmark from labelled images. A few become public dev examples; the rest are the hidden test set, kept in a
 * table anonymous clients cannot read and fingerprinted so tampering shows. Images are normalised to 256px JPEGs. */
export async function createBenchmark(agent: Agent, spec: BenchmarkInput, opts: { seeded?: boolean; onProgress?: (done: number, total: number) => void } = {}) {
  if (!/^[a-z0-9][a-z0-9-]{2,60}$/.test(spec.slug)) throw new MarketError("bad_input", "slug: lowercase letters, numbers and dashes, 3 to 61 characters.", "e.g. hotdog-or-not-v1");
  if (spec.category !== "image-classification") throw new MarketError("unsupported_capability", `Benchmarks for '${spec.category}' cannot be created here yet.`, "Supported: image-classification.");
  const labels = [...new Set(spec.labels.map((l) => l.trim()).filter(Boolean))];
  if (labels.length < 2 || labels.length > 10) throw new MarketError("bad_input", "Give between 2 and 10 distinct labels.", "e.g. [\"hotdog\", \"not_hotdog\"]");
  if (spec.examples.length < 24 || spec.examples.length > 400) throw new MarketError("bad_input", "Provide 24 to 400 labelled examples.", "A hidden test set needs enough images for the score to mean something.");
  const bad = spec.examples.find((e) => !labels.includes(e.label) || (!!e.image_url === !!e.image_base64));
  if (bad) throw new MarketError("bad_input", `Every example needs a label from your list and exactly one of image_url or image_base64 (problem near label '${bad.label}').`, "Fix the examples and retry.");

  let done = 0;
  const images = await inParallel(spec.examples, 5, async (e) => {
    const raw = e.image_url ? await fetchImage(e.image_url) : Buffer.from(e.image_base64!, "base64");
    if (raw.length > MAX_IMAGE_BYTES || raw.length < 100) throw new MarketError("bad_input", "An image is empty or larger than 3 MB.", "Use images between 100 bytes and 3 MB.");
    let bytes: Buffer;
    try { bytes = await normalizeImage(raw); } catch { throw new MarketError("bad_input", "An example is not a readable image.", "Use JPEG, PNG or WebP."); }
    opts.onProgress?.(++done, spec.examples.length);
    return { label: e.label, bytes };
  });
  const unique = new Map<string, { label: string; bytes: Buffer }>();
  for (const im of images) unique.set(sha1(im.bytes).slice(0, 12), im);
  const all = [...unique.entries()].map(([id, im]) => ({ id, ...im })).sort((a, b) => sha1(a.id).localeCompare(sha1(b.id)));
  if (all.length < 24) throw new MarketError("bad_input", "Fewer than 24 distinct images after removing duplicates.", "Add more distinct images.");

  const devWanted = Math.min(spec.dev_count ?? 8, 20, Math.floor(all.length / 4));
  const dev: typeof all = [];
  for (const l of labels) dev.push(...all.filter((x) => x.label === l).slice(0, Math.floor(devWanted / labels.length)));
  const devIds = new Set(dev.map((d) => d.id));
  const stored: Stored[] = all.map((x) => ({ id: x.id, label: x.label, split: devIds.has(x.id) ? "dev" : "test", b64: x.bytes.toString("base64") }));
  const test = stored.filter((s) => s.split === "test");
  const fingerprint = createHash("sha256").update(test.map((t) => `${t.id}:${t.label}`).sort().join("|")).digest("hex").slice(0, 16);

  const { data: b, error } = await db.from("benchmarks").insert({
    slug: spec.slug, title: spec.title, task: spec.task, category: spec.category, metric: "accuracy", visibility: "public", owner_id: agent.id,
    dev_examples: stored.filter((s) => s.split === "dev").map((s) => ({ id: s.id, label: s.label, image_path: `/benchmarks/${spec.slug}/dev/${s.id}.jpg` })),
    n_test: test.length, fingerprint, version: 1, seeded: opts.seeded ?? false,
  }).select("id").single();
  if (error) throw new MarketError("slug_taken", error.message.includes("duplicate") ? `A benchmark called '${spec.slug}' already exists.` : error.message, "Pick another slug.");
  await db.from("benchmark_tests").upsert({ benchmark_id: b.id, examples: stored });
  return { benchmark_id: b.id as string, slug: spec.slug, labels, n_test: test.length, dev_examples: dev.length, fingerprint, note: "Providers are scored on the hidden test set with run_benchmark." };
}

/** Score a listing on a benchmark: the platform sends every hidden test image to the listing's endpoint and compares the
 * answers with the reference labels. Only the listing's owner can start a run. A run records a verified result that find_providers ranks on. */
export async function runBenchmark(agent: Agent, a: { listing_id: string; benchmark_id: string }, onProgress?: (done: number, total: number) => Promise<unknown> | void) {
  const listing = await must<Row>(db.from("listings").select("*").eq("id", a.listing_id).maybeSingle(), "listing");
  if (listing.provider_id !== agent.id) throw new MarketError("unauthorized", "Only the listing's provider can run a benchmark for it.", "Use the provider account that owns the listing.");
  const bench = await must<Row>(db.from("benchmarks").select("id,slug,title,category,n_test").eq("id", a.benchmark_id).maybeSingle(), "benchmark");
  if (bench.category !== listing.capability) throw new MarketError("capability_mismatch", `The listing is '${listing.capability}' but the benchmark is '${bench.category}'.`, "Pick a benchmark for the same capability (search_benchmarks).");
  assertPublicUrl(listing.endpoint_url);
  const tests = await must<Row>(db.from("benchmark_tests").select("examples").eq("benchmark_id", bench.id).maybeSingle(), "benchmark tests");
  const items = (tests.examples as Stored[]).filter((e) => e.split === "test");
  const cap = capabilityFor(listing.capability);
  const url = endpointFor(listing as { endpoint_url: string; seeded?: boolean });

  let done = 0;
  const results = await inParallel(items, 4, async (it) => {
    const t0 = Date.now();
    let correct = false, ok = false;
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-benchmark": bench.slug }, body: JSON.stringify({ image_base64: it.b64, mime: "image/jpeg" }), signal: AbortSignal.timeout(20_000) });
      if (r.ok) {
        const fields = cap.fieldsOf((await r.json().catch(() => null)) as Record<string, unknown> | null);
        ok = cap.missing(fields).length === 0;
        correct = ok && fields?.label === it.label;
      }
    } catch { /* unreachable or too slow: scored wrong */ }
    const latency = Date.now() - t0;
    if (++done % 10 === 0 || done === items.length) await onProgress?.(done, items.length);
    return { correct, ok, latency };
  });

  const k = results.filter((r) => r.correct).length;
  const errors = results.filter((r) => !r.ok).length;
  const w = wilson(k, items.length);
  const lat = results.filter((r) => r.ok).map((r) => r.latency);
  const row = {
    benchmark_id: bench.id, listing_id: listing.id, quality: w.p, ci_low: w.low, ci_high: w.high, n: items.length,
    cost_per_call_cents: Number(listing.pricing.amount_cents), p50_ms: Math.round(percentile(lat, 0.5)), p95_ms: Math.round(percentile(lat, 0.95)),
    verified: true, seeded: Boolean(listing.seeded),
  };
  await db.from("benchmark_results").insert(row);
  return { benchmark: bench.slug, listing: listing.title as string, accuracy: round(w.p), ci95: [round(w.low), round(w.high)], n: items.length, correct: k, errors, p50_ms: row.p50_ms, p95_ms: row.p95_ms };
}

export async function listBenchmarks(category?: string) {
  let q = db.from("benchmarks").select("id,slug,title,task,category,metric,n_test,fingerprint,version,seeded,created_at").eq("visibility", "public").order("created_at", { ascending: false }).limit(100);
  if (category) q = q.eq("category", category);
  const { data } = await q;
  return (data ?? []).map((b) => ({ benchmark_id: b.id as string, slug: b.slug as string, title: b.title as string, task: b.task as string, category: b.category as string, metric: b.metric as string, n_test: b.n_test as number, fingerprint: b.fingerprint as string | null, platform_operated: Boolean(b.seeded) }));
}

/** Bytes of a public dev example, for the route that serves them. Hidden test images are never returned. */
export async function devImage(slug: string, id: string): Promise<Buffer | undefined> {
  if (!/^[a-z0-9-]+$/.test(slug) || !/^[a-f0-9]{12}$/.test(id)) return undefined;
  const { data: b } = await db.from("benchmarks").select("id").eq("slug", slug).eq("visibility", "public").maybeSingle();
  if (!b) return undefined;
  const { data: t } = await db.from("benchmark_tests").select("examples").eq("benchmark_id", b.id).maybeSingle();
  const hit = (t?.examples as Stored[] | undefined)?.find((e) => e.id === id && e.split === "dev");
  return hit ? Buffer.from(hit.b64, "base64") : undefined;
}
