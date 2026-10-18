/** Seeds the image-classification market: the image data, six mock demo providers with listings, and the hot dog benchmark.
 *   pnpm tsx scripts/seed-image-classification.ts                  data, accounts, listings, benchmark
 *   pnpm tsx scripts/seed-image-classification.ts --run <MCP_URL>  also score every listing on the benchmark, through the
 *                                                                  public run_benchmark tool, against a running server
 * Idempotent. Images: Hugging Face dataset antareepdey/Hotdog-or-not-a-hotdog (declared Apache-2.0 by its uploader; the
 * dataset card does not say where the photos came from). The platform's hidden test set is stored only in the database. */
import "../lib/env.js";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEMO_LISTINGS } from "../demo/listing-server.js";
import { type Agent, sha256 } from "../lib/auth.js";
import { createBenchmark } from "../lib/benchmarks.js";
import { db } from "../lib/db.js";
import { BASE_URL } from "../lib/env.js";
import { type Label, normalizeImage, splitDataset } from "../lib/image-split.js";
import { demoKey } from "../lib/demo-keys.js";
import { createListing } from "../lib/listings.js";

const DATASET = "antareepdey/Hotdog-or-not-a-hotdog";
const RAW = process.env.HOTDOG_DIR ?? "/tmp/hotdog-data";
const DATA = resolve(process.cwd(), "data");
const SLUG = "hotdog-or-not-v1";

async function download() {
  mkdirSync(RAW, { recursive: true });
  if (readdirSync(RAW).filter((f) => /\.(jpe?g|png)$/i.test(f)).length >= 220) return;
  console.log("downloading the dataset from Hugging Face…");
  const meta = (await (await fetch(`https://huggingface.co/api/datasets/${DATASET}`)).json()) as { siblings: { rfilename: string }[] };
  const files = meta.siblings.map((s) => s.rfilename).filter((f) => /^(test|val)\/(hotdog|others)\/.+\.(jpe?g|png)$/i.test(f));
  let next = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (next < files.length) {
      const f = files[next++];
      const out = resolve(RAW, f.replaceAll("/", "__"));
      if (existsSync(out)) continue;
      const r = await fetch(`https://huggingface.co/datasets/${DATASET}/resolve/main/${f}`);
      writeFileSync(out, Buffer.from(await r.arrayBuffer()));
    }
  }));
}

async function upsertAgent(handle: string, roles: string[], desc: string, key: string): Promise<Agent> {
  const { data, error } = await db.from("agents").upsert({ handle, roles, owner_ref: "demo-listings", description: desc, seeded: true, api_key_hash: sha256(key) }, { onConflict: "handle" }).select("id,handle,roles,owner_ref").single();
  if (error) throw error;
  return data as Agent;
}

async function main() {
  await download();

  // 1. normalise, split, and write what the server needs on disk: the live pool and the demo providers' answer key
  const files = readdirSync(RAW).filter((f) => /\.(jpe?g|png)$/i.test(f)).map((name) => {
    const [split, cls] = name.split("__");
    return { name, split: split as "test" | "val", label: (cls === "hotdog" ? "hotdog" : "not_hotdog") as Label };
  });
  const parts = splitDataset(files);
  const bytes = new Map<string, Buffer>();
  for (const f of files) bytes.set(f.name, await normalizeImage(readFileSync(resolve(RAW, f.name))));
  mkdirSync(resolve(DATA, "images"), { recursive: true });
  const live = parts.live.map((f, i) => ({ id: `live-${String(i + 1).padStart(3, "0")}`, label: f.label, name: f.name }));
  for (const l of live) writeFileSync(resolve(DATA, "images", `${l.id}.jpg`), bytes.get(l.name)!);
  writeFileSync(resolve(DATA, "live-images.json"), JSON.stringify(live.map(({ id, label }) => ({ id, label })), null, 1) + "\n");
  const key: Record<string, string> = {};
  for (const f of files) key[createHash("sha256").update(bytes.get(f.name)!).digest("hex")] = f.label;
  writeFileSync(resolve(DATA, "answer-key.json"), JSON.stringify(key) + "\n");
  console.log(`images: ${parts.hidden.length} hidden test, ${parts.dev.length} dev, ${live.length} live pool; answer key for ${Object.keys(key).length}`);

  // 2. the platform account that owns the benchmark, and the benchmark itself (the same code path the API uses)
  const owner = await upsertAgent("pareto-benchmarks", ["provider"], "Owns the platform's benchmarks (demo)", demoKey("pareto-benchmarks"));
  let { data: b } = await db.from("benchmarks").select("id").eq("slug", SLUG).maybeSingle();
  if (!b) {
    const examples = [...parts.hidden, ...parts.dev].map((f) => ({ label: f.label, image_base64: bytes.get(f.name)!.toString("base64") }));
    const made = await createBenchmark(owner, {
      slug: SLUG, title: "Hot dog or not?", category: "image-classification", labels: ["hotdog", "not_hotdog"], examples, dev_count: 8,
      task: `Classify a food photo as "hotdog" or "not_hotdog" (binary image classification: is this a hot dog?). Images come from the Hugging Face dataset ${DATASET}, declared Apache-2.0 by its uploader; the dataset card does not document where the photos came from.`,
    }, { seeded: true });
    b = { id: made.benchmark_id };
    console.log(`benchmark ${SLUG}: ${made.n_test} hidden test images, ${made.dev_examples} dev examples, fingerprint ${made.fingerprint}`);
  } else console.log(`benchmark ${SLUG} already exists`);

  // 3. six demo providers, each an account with a listing served by the demo listing server
  const keys: Record<string, string> = {};
  for (const p of DEMO_LISTINGS) {
    const k = demoKey(p.id);
    keys[p.id] = k;
    const agent = await upsertAgent(p.id, ["provider"], `${p.about} (demo provider, mock service)`, k);
    const endpoint_url = `${BASE_URL}/providers/${p.id}/classify`;
    const { data: existing } = await db.from("listings").select("id").eq("provider_id", agent.id).eq("capability", "image-classification").maybeSingle();
    if (existing) {
      await db.from("listings").update({ title: p.title, endpoint_url, pricing: { model: "per_call", amount_cents: p.price_cents }, sla: { p95_ms: p.sla_p95_ms }, active: true, seeded: true }).eq("id", existing.id);
    } else {
      await createListing({ ...agent, roles: ["provider"] }, { title: p.title, capability: "image-classification", kind: "api", endpoint_url, price_cents_per_call: p.price_cents, max_latency_ms: p.sla_p95_ms }, { seeded: true });
    }
    console.log(`listing ${p.id.padEnd(16)} ${String(p.price_cents).padStart(2)}¢`);
  }

  // 4. optionally score every listing, through the public MCP tool, exactly as a provider would
  const at = process.argv.indexOf("--run");
  if (at > 0) {
    const url = process.argv[at + 1];
    for (const p of DEMO_LISTINGS) {
      const agent = (await db.from("agents").select("id").eq("handle", p.id).single()).data!;
      const listing = (await db.from("listings").select("id").eq("provider_id", agent.id).eq("capability", "image-classification").single()).data!;
      const t0 = Date.now();
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-api-key": keys[p.id] }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "run_benchmark", arguments: { listing_id: listing.id, benchmark_id: b!.id } } }) });
      const text = await r.text();
      const line = text.split("\n").find((l) => l.startsWith("data:"));
      const res = (line ? JSON.parse(line.slice(5)) : JSON.parse(text)).result as { isError?: boolean; structuredContent?: Record<string, unknown> };
      console.log(`${p.id.padEnd(16)} ${res.isError ? "ERROR " + JSON.stringify(res.structuredContent) : `accuracy ${res.structuredContent!.accuracy} ${JSON.stringify(res.structuredContent!.ci95)} n=${res.structuredContent!.n} errors=${res.structuredContent!.errors} p50=${res.structuredContent!.p50_ms}ms p95=${res.structuredContent!.p95_ms}ms`}  (${Math.round((Date.now() - t0) / 1000)}s)`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
