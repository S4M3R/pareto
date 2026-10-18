/** Seeds the "cat or dog" example: a general animal benchmark owned by the platform, the photos for the cat or dog app, and the
 * dataset the presenter publishes as a NEW benchmark with the CLI.
 *   pnpm tsx scripts/seed-pet-benchmarks.ts                 download photos, create animals-general-v1, write data (idempotent)
 *   pnpm tsx scripts/seed-pet-benchmarks.ts --calibrate     print each demo model's accuracy parameters (paste into demo/listing-server.ts)
 *   pnpm tsx scripts/seed-pet-benchmarks.ts --run           score the six demo models on animals-general-v1 (needs PUBLIC_BASE_URL to serve /providers/*)
 *
 * The story it supports: the platform has a benchmark for animals in general (ten species, cats and dogs among them) and the six
 * demo models are scored on it, but nothing for cat versus dog. The presenter publishes one (slug cats-vs-dogs-v1) from
 * data/catdog-dataset with the same models, and earns 5% when an agent hires through it. cats-vs-dogs-v1 is therefore NOT created here.
 *
 * Data. Animals come from the Hugging Face dataset Rapidata/Animals-10 (the Animals-10 set; the dataset card declares GPL-2.0, the
 * original photos were collected from the web: fine for a demo, check before using them beyond one). Cats and dogs come from
 * Bingsu/Cat_and_Dog (CC0-1.0). Both are read through the datasets-server API and normalised to 256px JPEGs. The hidden test photos
 * of animals-general-v1 live only in the database, never in the repo.
 *
 * Photos are split so none is used twice:
 *   animals-general-v1   12 per species (10 hidden + 2 dev)           -> the platform benchmark, 100 hidden, 20 public dev examples
 *   catdog-dataset       20 cats + 20 dogs (Cat_and_Dog rows 0..19)    -> data/catdog-dataset/{cat,dog}/NN.jpg, what the CLI publishes
 *   pet pool             50 cats + 50 dogs (Cat_and_Dog rows 20..69)   -> data/images/pet-001..100.jpg + data/pet-images.json, what the app classifies
 *
 * The demo models answer from data/answer-key-pets.json (sha256 of a photo -> reference label and set), as with the other keys. The
 * benchmark photos carry their benchmark's set (so each model scores its designed number); the app's pool has the set "pet-pool", which
 * no model has a special accuracy for, so live calls use each model's normal accuracy. */
import "../lib/env.js";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEMO_LISTINGS, imageRng } from "../demo/listing-server.js";
import { type Agent, sha256 } from "../lib/auth.js";
import { createBenchmark, runBenchmark } from "../lib/benchmarks.js";
import { db } from "../lib/db.js";
import { demoKey } from "../lib/demo-keys.js";
import { normalizeImage } from "../lib/image-split.js";

const DATA = resolve(process.cwd(), "data");
const RAW = "/tmp/pet-benchmarks-pareto";
const ANIMALS = "https://datasets-server.huggingface.co/rows?dataset=Rapidata/Animals-10&config=default&split=train";
const CATDOG = "https://datasets-server.huggingface.co/rows?dataset=Bingsu/Cat_and_Dog&config=default&split=test";
const SPECIES = ["Butterfly", "Cat", "Chicken", "Cow", "Dog", "Elephant", "Horse", "Sheep", "Spider", "Squirrel"]; // the dataset's label order
const LABELS = SPECIES.map((s) => s.toLowerCase());
const ANIMALS_SLUG = "animals-general-v1";
const CATDOG_SLUG = "cats-vs-dogs-v1";

/** Designed correct answers out of n. On the ten-species task everyone is lower, and Dogspotter beats BunVision; on cat versus dog
 * BunVision is on the frontier. So the general benchmark would have picked a different model than the specific one. */
const TARGETS: Record<string, { n: number; correct: Record<string, number> }> = {
  [ANIMALS_SLUG]: { n: 100, correct: { "frankfinder-pro": 88, bunvision: 74, dogspotter: 80, wienernet: 64, fastfrank: 70, "seefood-lite": 55 } },
  [CATDOG_SLUG]: { n: 32, correct: { "frankfinder-pro": 31, bunvision: 30, dogspotter: 28, wienernet: 24, fastfrank: 27, "seefood-lite": 22 } },
};

const TASK = "General animal recognition benchmark: name the animal in a photo, one of 10 species (butterfly, cat, chicken, cow, dog, elephant, horse, sheep, spider, squirrel). Multi-class animal image classification, cats and dogs among them. Photos from the Animals-10 dataset (Rapidata/Animals-10).";

type Ex = { label: string; bytes: Buffer };
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const flag = (f: string) => process.argv.includes(f);

/** GET with retries: the datasets-server rate-limits bursts (429). */
async function get(url: string): Promise<Response> {
  for (let i = 0; i < 12; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      if (r.status !== 429 && r.status < 500) return r;
    } catch { /* a timeout or a dropped connection: try again */ }
    await new Promise((res) => setTimeout(res, 1500 * (i + 1)));
  }
  throw new Error(`gave up on ${url}`);
}

type Row = { row: { label?: number; labels?: number; image: { src: string } } };
const rowsAt = async (base: string, offset: number, length: number) => {
  const r = await get(`${base}&offset=${offset}&length=${length}`);
  if (!r.ok) throw new Error(`datasets-server ${r.status} at offset ${offset}`);
  return ((await r.json()) as { rows: Row[] }).rows;
};
const download = async (src: string) => {
  const r = await get(src);
  if (!r.ok) throw new Error(`image download failed ${r.status}`);
  return normalizeImage(Buffer.from(await r.arrayBuffer()));
};

/** Animals-10 is stored in contiguous species blocks: probe every 250 rows once to find where each species is, then read inside it. */
async function speciesStarts(): Promise<Record<number, number>> {
  const cache = resolve(RAW, "animal-blocks.json");
  if (existsSync(cache)) return JSON.parse(readFileSync(cache, "utf8")) as Record<number, number>;
  const first: Record<number, number> = {};
  for (let off = 0; off < 23554; off += 250) {
    const l = (await rowsAt(ANIMALS, off, 1))[0].row.label!;
    if (first[l] === undefined) first[l] = off;
  }
  mkdirSync(RAW, { recursive: true });
  writeFileSync(cache, JSON.stringify(first));
  return first;
}

async function animalPhotos(): Promise<Record<string, Buffer[]>> {
  const starts = await speciesStarts();
  const out: Record<string, Buffer[]> = {};
  for (let c = 0; c < SPECIES.length; c++) {
    const dir = resolve(RAW, "animals", LABELS[c]);
    mkdirSync(dir, { recursive: true });
    const have = readdirSync(dir).filter((f) => f.endsWith(".jpg")).sort();
    if (have.length >= 12) { out[LABELS[c]] = have.slice(0, 12).map((f) => readFileSync(resolve(dir, f))); continue; }
    // 40 rows in from the first probe that saw the species: safely inside its block, and past any boundary row
    const rows = await rowsAt(ANIMALS, starts[c] + 40, 12);
    const photos: Buffer[] = [];
    for (const { row } of rows) {
      if (row.label !== c) throw new Error(`expected ${SPECIES[c]} (label ${c}), got label ${row.label}`);
      photos.push(await download(row.image.src));
    }
    photos.forEach((b, i) => writeFileSync(resolve(dir, `${String(i).padStart(2, "0")}.jpg`), b));
    out[LABELS[c]] = photos;
    console.log(`animals ${LABELS[c]}: ${photos.length}`);
  }
  return out;
}

/** 70 cats and 70 dogs: the first of each that the test split yields, in row order. */
async function catDogPhotos(): Promise<Record<string, Buffer[]>> {
  const out: Record<string, Buffer[]> = { cat: [], dog: [] };
  for (const label of ["cat", "dog"]) {
    const dir = resolve(RAW, "catdog", label);
    mkdirSync(dir, { recursive: true });
    const have = readdirSync(dir).filter((f) => f.endsWith(".jpg")).sort();
    if (have.length >= 70) out[label] = have.slice(0, 70).map((f) => readFileSync(resolve(dir, f)));
  }
  if (out.cat.length >= 70 && out.dog.length >= 70) return out;
  const want: Record<string, number> = { cat: 70, dog: 70 };
  for (let off = 0; off < 2000 && (out.cat.length < 70 || out.dog.length < 70); off += 100) {
    for (const { row } of await rowsAt(CATDOG, off, 100)) {
      const label = row.labels === 0 ? "cat" : "dog";
      if (out[label].length >= want[label]) continue;
      out[label].push(await download(row.image.src));
    }
  }
  for (const label of ["cat", "dog"]) out[label].forEach((b, i) => writeFileSync(resolve(RAW, "catdog", label, `${String(i).padStart(2, "0")}.jpg`), b));
  console.log(`cats ${out.cat.length}, dogs ${out.dog.length}`);
  return out;
}

async function upsertAgent(handle: string, roles: string[], owner_ref: string, description: string, seeded = false): Promise<Agent> {
  const { data, error } = await db.from("agents").upsert({ handle, roles, owner_ref, description, seeded, api_key_hash: sha256(demoKey(handle)) }, { onConflict: "handle" }).select("id,handle,roles,owner_ref").single();
  if (error) throw error;
  return data as Agent;
}

/** The hidden photos of a benchmark published from data/catdog-dataset: the same split createBenchmark makes (sorted by the sha1 of each
 * photo's id, the first four of each label become public dev examples, the rest are hidden). */
function catdogHidden(): Buffer[] {
  const all = ["cat", "dog"].flatMap((label) => readdirSync(resolve(DATA, "catdog-dataset", label)).map((f) => ({ label, bytes: readFileSync(resolve(DATA, "catdog-dataset", label, f)) })))
    .map((e) => ({ ...e, id: createHash("sha1").update(e.bytes).digest("hex").slice(0, 12) }))
    .sort((a, b) => createHash("sha1").update(a.id).digest("hex").localeCompare(createHash("sha1").update(b.id).digest("hex")));
  const dev = new Set(["cat", "dog"].flatMap((l) => all.filter((x) => x.label === l).slice(0, 4).map((x) => x.id)));
  return all.filter((x) => !dev.has(x.id)).map((x) => x.bytes);
}

async function hiddenOf(slug: string): Promise<Buffer[]> {
  if (slug === CATDOG_SLUG) return catdogHidden();
  const { data: b } = await db.from("benchmarks").select("id").eq("slug", slug).single();
  const { data: t } = await db.from("benchmark_tests").select("examples").eq("benchmark_id", b!.id).single();
  return (t!.examples as { split: string; b64: string }[]).filter((e) => e.split === "test").map((e) => Buffer.from(e.b64, "base64"));
}

async function calibrate() {
  const out: Record<string, Record<string, number>> = {};
  for (const [slug, spec] of Object.entries(TARGETS)) {
    const items = await hiddenOf(slug);
    if (items.length !== spec.n) console.warn(`${slug}: ${items.length} hidden items, expected ${spec.n}`);
    for (const p of DEMO_LISTINGS) {
      const u = items.map((b) => imageRng(p.id, sha(b), slug)()).sort((a, b) => a - b);
      const k = spec.correct[p.id];
      const param = k <= 0 ? u[0] / 2 : k >= u.length ? 1 : (u[k - 1] + u[k]) / 2;
      (out[p.id] ??= {})[slug] = Math.round(param * 1e6) / 1e6;
    }
  }
  console.log(JSON.stringify(out));
}

async function main() {
  if (flag("--calibrate")) return calibrate();
  if (flag("--run")) return run();

  const animals = await animalPhotos();
  const pets = await catDogPhotos();
  const key: Record<string, unknown> = { "@sets": { [ANIMALS_SLUG]: LABELS, [CATDOG_SLUG]: ["cat", "dog"], "pet-pool": ["cat", "dog"] } };

  // the platform's general animal benchmark
  const platform = await upsertAgent("pareto-benchmarks", ["provider"], "demo-listings", "Owns the platform's benchmarks (demo)", true);
  const examples: Ex[] = LABELS.flatMap((l) => animals[l].map((bytes) => ({ label: l, bytes })));
  for (const e of examples) key[sha(e.bytes)] = { l: e.label, s: ANIMALS_SLUG };
  const { data: exists } = await db.from("benchmarks").select("id").eq("slug", ANIMALS_SLUG).maybeSingle();
  if (!exists) {
    const r = await createBenchmark(platform, {
      slug: ANIMALS_SLUG, title: "Animals: 10 species", category: "image-classification", labels: LABELS, dev_count: 20, task: TASK,
      examples: examples.map((e) => ({ label: e.label, image_base64: e.bytes.toString("base64") })),
    }, { seeded: true });
    console.log(`benchmark ${ANIMALS_SLUG}: ${r.n_test} hidden, ${r.dev_examples} dev, fingerprint ${r.fingerprint}`);
  } else console.log(`benchmark ${ANIMALS_SLUG} already exists`);
  await db.from("benchmarks").update({ task: TASK }).eq("slug", ANIMALS_SLUG);

  // the dataset the presenter publishes with the CLI: 20 cats and 20 dogs (rows 0..19)
  rmSync(resolve(DATA, "catdog-dataset"), { recursive: true, force: true });
  for (const label of ["cat", "dog"]) {
    mkdirSync(resolve(DATA, "catdog-dataset", label), { recursive: true });
    pets[label].slice(0, 20).forEach((b, i) => { writeFileSync(resolve(DATA, "catdog-dataset", label, `${String(i + 1).padStart(2, "0")}.jpg`), b); key[sha(b)] = { l: label, s: CATDOG_SLUG }; });
  }

  // the pool the app classifies: 50 cats and 50 dogs (rows 20..69), in a fixed shuffled order
  const pool = ["cat", "dog"].flatMap((label) => pets[label].slice(20, 70).map((bytes) => ({ label, bytes })))
    .sort((a, b) => createHash("sha1").update(sha(a.bytes)).digest("hex").localeCompare(createHash("sha1").update(sha(b.bytes)).digest("hex")));
  mkdirSync(resolve(DATA, "images"), { recursive: true });
  const index = pool.map((p, i) => {
    const id = `pet-${String(i + 1).padStart(3, "0")}`;
    writeFileSync(resolve(DATA, "images", `${id}.jpg`), p.bytes);
    key[sha(p.bytes)] = { l: p.label, s: "pet-pool" }; // its own set: live calls use each model's normal accuracy, not the one calibrated on the 32 benchmark photos
    return { id, label: p.label };
  });
  writeFileSync(resolve(DATA, "pet-images.json"), JSON.stringify(index, null, 1) + "\n");
  writeFileSync(resolve(DATA, "answer-key-pets.json"), JSON.stringify(key) + "\n");
  console.log(`catdog-dataset: 40 photos; pet pool: ${index.length} photos (${index.filter((x) => x.label === "cat").length} cats); answer key: ${Object.keys(key).length - 1} photos`);
}

async function run() {
  const rescore = flag("--rescore");
  const { data: b } = await db.from("benchmarks").select("id").eq("slug", ANIMALS_SLUG).single();
  for (const p of DEMO_LISTINGS) {
    const { data: agent } = await db.from("agents").select("id,handle,roles,owner_ref").eq("handle", p.id).single();
    const { data: listing } = await db.from("listings").select("id").eq("provider_id", agent!.id).eq("capability", "image-classification").single();
    const { count } = await db.from("benchmark_results").select("id", { count: "exact", head: true }).eq("benchmark_id", b!.id).eq("listing_id", listing!.id);
    if (count && !rescore) { console.log(`  ${p.id.padEnd(16)} already scored`); continue; }
    const r = await runBenchmark(agent as Agent, { listing_id: listing!.id, benchmark_id: b!.id });
    console.log(`  ${p.id.padEnd(16)} ${String(p.price_cents).padStart(2)}c  accuracy ${r.accuracy} ${JSON.stringify(r.ci95)} n=${r.n} errors=${r.errors} p50=${r.p50_ms}ms`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
