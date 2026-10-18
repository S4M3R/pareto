/** Seeds the benchmarks behind the hot dog founder demo, and scores the six demo providers on them.
 *   pnpm tsx scripts/seed-food-benchmarks.ts                create accounts, benchmarks, answer key and the CLI demo dataset
 *   pnpm tsx scripts/seed-food-benchmarks.ts --calibrate    print each provider's per-benchmark accuracy parameters (paste into demo/listing-server.ts)
 *   pnpm tsx scripts/seed-food-benchmarks.ts --run          score every demo provider on the three benchmarks through runBenchmark
 *                                                            (needs a server at PUBLIC_BASE_URL that serves /providers/*, with data/answer-key-food.json)
 * Idempotent: what exists is kept. Add --rescore with --run to score again.
 *
 * What it creates (live database; the accounts are demo accounts run by this project, flagged by their owner_ref):
 *   snacks-food-v1       owner pareto-benchmarks   20 food classes, 100 hidden photos + 20 public dev examples
 *   hotdog-internal-v0   owner hotdog-rando        hot dog / not_hotdog, 30 hidden photos: a stranger's small benchmark (new account, no deals)
 *   street-hotdogs-v1    owner benchmark-author    hot dog / not_hotdog, 60 hidden photos: the presenter's benchmark that the crowd buyers cite
 *
 * Data. Food photos come from the Hugging Face dataset ethz/food101 (the Food-101 validation split, via the datasets-server API,
 * downloaded into a fresh directory under /tmp). Food-101 (Bossard, Guillaumin, Van Gool, ECCV 2014) was collected from
 * foodspotting.com; the dataset card declares the license as "unknown", so rights to the photos are unverified: fine for a
 * demo, check before using them beyond one. The photos are normalised to 256px JPEGs; the hidden test images live only in the
 * database, never in the repo. The small hot dog set for hotdog-internal-v0 is drawn from the live pool of
 * scripts/seed-image-classification.ts (Hugging Face antareepdey/Hotdog-or-not-a-hotdog), never from the hidden test set of hotdog-or-not-v1.
 *
 * Images are split by class, in disjoint index ranges, so no photo is in two benchmarks or in the CLI dataset:
 *   snacks-food-v1       every class      photos 0..5   (5 hidden + 1 dev per class)
 *   street-hotdogs-v1    hot_dog          photos 6..39; the negatives are other sandwiches and fried food, photos 6..11
 *   CLI demo dataset     hot_dog          photos 40..59; negatives photos 12..13       -> /tmp/pareto-demo-dataset/{hotdog,not_hotdog}/NN.jpg
 *                                                                                         and server/data/demo-dataset/ (same layout, 40 photos)
 * The demo providers are also calibrated for the slug street-hotdogs-v2 on this dataset (BunVision 29 of 32, Dogspotter 28, SeeFood Lite 25), so
 * `--slug street-hotdogs-v2` gives a result consistent with the charts; any other slug falls back to each provider's default accuracy.
 * Run it as: pareto publish-benchmark ./demo-dataset --slug street-hotdogs-v2 --title "..." --labels hotdog,not_hotdog --providers bunvision,dogspotter,seefood-lite
 *
 * The demo providers answer from data/answer-key-food.json (sha256 of each photo -> reference label, plus the label list of the
 * multi-class set under "@sets"), the same cheat sheet mechanism as data/answer-key.json. */
import "../lib/env.js";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEMO_LISTINGS, imageRng } from "../demo/listing-server.js";
import { type Agent, sha256 } from "../lib/auth.js";
import { createBenchmark, runBenchmark } from "../lib/benchmarks.js";
import { db } from "../lib/db.js";
import { demoKey } from "../lib/demo-keys.js";
import { normalizeImage } from "../lib/image-split.js";

const DATA = resolve(process.cwd(), "data");
const RAW = "/tmp/food101-pareto";
const CLI_DIR = "/tmp/pareto-demo-dataset";
const HF = "https://datasets-server.huggingface.co/rows?dataset=ethz/food101&config=default&split=validation";
const CLASS_NAMES = ["apple_pie", "baby_back_ribs", "baklava", "beef_carpaccio", "beef_tartare", "beet_salad", "beignets", "bibimbap", "bread_pudding", "breakfast_burrito", "bruschetta", "caesar_salad", "cannoli", "caprese_salad", "carrot_cake", "ceviche", "cheesecake", "cheese_plate", "chicken_curry", "chicken_quesadilla", "chicken_wings", "chocolate_cake", "chocolate_mousse", "churros", "clam_chowder", "club_sandwich", "crab_cakes", "creme_brulee", "croque_madame", "cup_cakes", "deviled_eggs", "donuts", "dumplings", "edamame", "eggs_benedict", "escargots", "falafel", "filet_mignon", "fish_and_chips", "foie_gras", "french_fries", "french_onion_soup", "french_toast", "fried_calamari", "fried_rice", "frozen_yogurt", "garlic_bread", "gnocchi", "greek_salad", "grilled_cheese_sandwich", "grilled_salmon", "guacamole", "gyoza", "hamburger", "hot_and_sour_soup", "hot_dog", "huevos_rancheros", "hummus", "ice_cream", "lasagna", "lobster_bisque", "lobster_roll_sandwich", "macaroni_and_cheese", "macarons", "miso_soup", "mussels", "nachos", "omelette", "onion_rings", "oysters", "pad_thai", "paella", "pancakes", "panna_cotta", "peking_duck", "pho", "pizza", "pork_chop", "poutine", "prime_rib", "pulled_pork_sandwich", "ramen", "ravioli", "red_velvet_cake", "risotto", "samosa", "sashimi", "scallops", "seaweed_salad", "shrimp_and_grits", "spaghetti_bolognese", "spaghetti_carbonara", "spring_rolls", "steak", "sushi", "tacos", "takoyaki", "tiramisu", "tuna_tartare", "waffles"];
const SNACKS = ["hot_dog", "hamburger", "pizza", "french_fries", "tacos", "sushi", "ramen", "pancakes", "waffles", "donuts", "nachos", "ice_cream", "club_sandwich", "fried_rice", "dumplings", "steak", "caesar_salad", "apple_pie", "cup_cakes", "onion_rings"];
// look-alikes and neighbours for the hot dog negatives: sandwiches and fried food
const NEGATIVES = ["hamburger", "club_sandwich", "tacos", "grilled_cheese_sandwich", "french_fries", "pulled_pork_sandwich", "lobster_roll_sandwich", "onion_rings", "fried_calamari", "nachos"];
const NEED = new Set([...SNACKS, ...NEGATIVES]);

/** Designed correct answers out of n per benchmark. Food is a 20-class task, so everyone is lower and the frontier differs:
 * BunVision is on the hot dog frontiers but dominated by Dogspotter on food. */
const TARGETS: Record<string, { n: number; correct: Record<string, number> }> = {
  "snacks-food-v1": { n: 100, correct: { "frankfinder-pro": 86, bunvision: 71, dogspotter: 79, wienernet: 62, fastfrank: 67, "seefood-lite": 53 } },
  "street-hotdogs-v1": { n: 60, correct: { "frankfinder-pro": 57, bunvision: 55, dogspotter: 53, wienernet: 49, fastfrank: 51, "seefood-lite": 46 } },
  // not seeded: the benchmark the presenter publishes from data/demo-dataset with the CLI (--slug street-hotdogs-v2); calibrated on its 32 hidden photos
  "street-hotdogs-v2": { n: 32, correct: { "frankfinder-pro": 31, bunvision: 29, dogspotter: 28, wienernet: 25, fastfrank: 26, "seefood-lite": 25 } },
  "hotdog-internal-v0": { n: 30, correct: { "frankfinder-pro": 28, bunvision: 27, dogspotter: 26, wienernet: 24, fastfrank: 25, "seefood-lite": 21 } },
};

type Ex = { label: string; bytes: Buffer };

/** GET with retries: the datasets-server rate-limits bursts (429). */
async function get(url: string): Promise<Response> {
  for (let i = 0; i < 8; i++) {
    const r = await fetch(url);
    if (r.status !== 429 && r.status < 500) return r;
    await new Promise((res) => setTimeout(res, 1500 * (i + 1)));
  }
  throw new Error(`gave up on ${url}`);
}

/** The validation split is stored in contiguous class blocks of 250, but not in label order: probe each block once to find where each class starts. */
let blocks: Record<number, number> | undefined;
async function blockStart(label: number): Promise<number> {
  if (!blocks) {
    const cache = resolve(RAW, "blocks.json");
    if (existsSync(cache)) blocks = JSON.parse(readFileSync(cache, "utf8")) as Record<number, number>;
    else {
      blocks = {};
      for (let i = 0; i < 101; i++) {
        const r = await get(`${HF}&offset=${250 * i}&length=1`);
        const l = ((await r.json()) as { rows: { row: { label: number } }[] }).rows[0].row.label;
        blocks![l] = 250 * i;
      }
      mkdirSync(RAW, { recursive: true });
      writeFileSync(cache, JSON.stringify(blocks));
    }
  }
  if (blocks[label] === undefined) throw new Error(`no block found for label ${label}`);
  return blocks[label];
}

async function fetchClass(cls: string): Promise<Buffer[]> {
  const idx = CLASS_NAMES.indexOf(cls);
  const dir = resolve(RAW, cls);
  mkdirSync(dir, { recursive: true });
  const want = cls === "hot_dog" ? 60 : 16;
  const have = readdirSync(dir).filter((f) => f.endsWith(".jpg")).sort();
  if (have.length >= want) return have.slice(0, want).map((f) => readFileSync(resolve(dir, f)));
  const out: Buffer[] = [];
  for (let off = 0; off < want; off += 100) {
    const r = await get(`${HF}&offset=${(await blockStart(idx)) + off}&length=${Math.min(100, want - off)}`);
    if (!r.ok) throw new Error(`datasets-server ${r.status} for ${cls}`);
    const rows = ((await r.json()) as { rows: { row: { label: number; image: { src: string } } }[] }).rows;
    for (const { row } of rows) {
      if (row.label !== idx) throw new Error(`expected ${cls} (label ${idx}) at this offset, got label ${row.label}`);
      const img = await get(row.image.src);
      if (!img.ok) throw new Error(`image download failed ${img.status}`);
      out.push(Buffer.from(await img.arrayBuffer()));
    }
  }
  out.forEach((b, i) => writeFileSync(resolve(dir, `${String(i).padStart(3, "0")}.jpg`), b));
  return out;
}

async function upsertAgent(handle: string, roles: string[], owner_ref: string, description: string, seeded = false): Promise<Agent> {
  const { data, error } = await db.from("agents").upsert({ handle, roles, owner_ref, description, seeded, api_key_hash: sha256(demoKey(handle)) }, { onConflict: "handle" }).select("id,handle,roles,owner_ref").single();
  if (error) throw error;
  return data as Agent;
}

/** Descriptions are kept in sync on every run (search matches on them). */
const TASKS: Record<string, string> = {
  "hotdog-internal-v0": "Hot dog classification for my app: is this photo a hot dog or not? Hot dog classifier benchmark, labels hotdog and not_hotdog (binary image classification). A small internal test set I put together.",
  "snacks-food-v1": "General food classification benchmark: name the dish in a photo of food, one of 20 common dishes (hot dog, hamburger, pizza, french fries, tacos, sushi, ramen, pancakes, waffles, donuts, nachos, ice cream, club sandwich, fried rice, dumplings, steak, caesar salad, apple pie, cup cakes, onion rings). Multi-class image classification. Photos from the Food-101 dataset (ethz/food101; license unknown on the dataset card).",
};

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const flag = (f: string) => process.argv.includes(f);

/** The hidden photos of a benchmark published from data/demo-dataset: the same split createBenchmark makes (sorted by the sha1 of each
 * photo's id, the first four of each label become public dev examples, the rest are hidden). */
function demoDatasetHidden(): Buffer[] {
  const all = ["hotdog", "not_hotdog"].flatMap((label) => readdirSync(resolve(DATA, "demo-dataset", label)).map((f) => ({ label, bytes: readFileSync(resolve(DATA, "demo-dataset", label, f)) })))
    .map((e) => ({ ...e, id: createHash("sha1").update(e.bytes).digest("hex").slice(0, 12) }))
    .sort((a, b) => createHash("sha1").update(a.id).digest("hex").localeCompare(createHash("sha1").update(b.id).digest("hex")));
  const dev = new Set(["hotdog", "not_hotdog"].flatMap((l) => all.filter((x) => x.label === l).slice(0, 4).map((x) => x.id)));
  return all.filter((x) => !dev.has(x.id)).map((x) => x.bytes);
}

async function hiddenOf(slug: string): Promise<Buffer[]> {
  if (slug === "street-hotdogs-v2") return demoDatasetHidden();
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
  console.log("accuracy_by_set values (paste into DEMO_LISTINGS):");
  for (const p of DEMO_LISTINGS) console.log(`  ${p.id.padEnd(16)} accuracy_by_set: ${JSON.stringify(out[p.id])}`);
}

async function main() {
  if (flag("--calibrate")) return calibrate();
  if (flag("--run")) return run();

  // 1. photos
  rmSync(CLI_DIR, { recursive: true, force: true });
  const raw: Record<string, Buffer[]> = {};
  for (const c of NEED) { raw[c] = await Promise.all((await fetchClass(c)).map((b) => normalizeImage(b))); console.log(`photos ${c}: ${raw[c].length}`); }
  const key: Record<string, unknown> = { "@sets": { "snacks-food-v1": SNACKS } };

  // 2. accounts
  const platform = await upsertAgent("pareto-benchmarks", ["provider"], "demo-listings", "Owns the platform's benchmarks (demo)", true);
  const rando = await upsertAgent("hotdog-rando", ["buyer", "provider"], "rando-internet", "Somebody who made a hot dog benchmark");
  const author = await upsertAgent("benchmark-author", ["buyer", "provider"], "benchmark-author", "Publishes benchmarks; earns when agents choose with them");
  console.log("accounts: pareto-benchmarks, hotdog-rando, benchmark-author");

  const exists = async (slug: string) => (await db.from("benchmarks").select("id").eq("slug", slug).maybeSingle()).data;
  const report = (slug: string, r: { n_test: number; dev_examples: number; fingerprint: string }) => console.log(`benchmark ${slug}: ${r.n_test} hidden, ${r.dev_examples} dev, fingerprint ${r.fingerprint}`);

  // 3. snacks-food-v1: 6 photos for each of the 20 classes (indexes 0..5)
  const snacks: Ex[] = SNACKS.flatMap((c) => raw[c].slice(0, 6).map((bytes) => ({ label: c, bytes })));
  for (const e of snacks) key[sha(e.bytes)] = { l: e.label, s: "snacks-food-v1" };
  if (!(await exists("snacks-food-v1"))) {
    report("snacks-food-v1", await createBenchmark(platform, {
      slug: "snacks-food-v1", title: "Everyday food: 20 dishes", category: "image-classification", labels: SNACKS, dev_count: 20,
      examples: snacks.map((e) => ({ label: e.label, image_base64: e.bytes.toString("base64") })),
      task: TASKS["snacks-food-v1"],
    }, { seeded: true }));
  } else console.log("benchmark snacks-food-v1 already exists");

  // 4. street-hotdogs-v1: 34 hot dogs (6..39) and 34 look-alikes (6..11 of the negative classes)
  const hot = raw.hot_dog;
  const negPool = (from: number, count: number) => Array.from({ length: count }, (_, i) => raw[NEGATIVES[i % NEGATIVES.length]][from + Math.floor(i / NEGATIVES.length)]);
  const street: Ex[] = [...hot.slice(6, 40).map((bytes) => ({ label: "hotdog", bytes })), ...negPool(6, 34).map((bytes) => ({ label: "not_hotdog", bytes }))];
  for (const e of street) key[sha(e.bytes)] = e.label;
  if (!(await exists("street-hotdogs-v1"))) {
    report("street-hotdogs-v1", await createBenchmark(author, {
      slug: "street-hotdogs-v1", title: "Street hot dogs", category: "image-classification", labels: ["hotdog", "not_hotdog"], dev_count: 8,
      examples: street.map((e) => ({ label: e.label, image_base64: e.bytes.toString("base64") })),
      task: `Hot dog classification on street-food style photos: is this a hot dog or not (binary image classification)? Negatives are look-alikes: sandwiches, burgers, tacos, fried food. Photos from the Food-101 dataset.`,
    }));
  } else console.log("benchmark street-hotdogs-v1 already exists");

  // 5. hotdog-internal-v0: 19 + 19 photos from the live pool (a different source than the hidden test set of hotdog-or-not-v1)
  const live = JSON.parse(readFileSync(resolve(DATA, "live-images.json"), "utf8")) as { id: string; label: string }[];
  const byHash = (xs: typeof live) => [...xs].sort((a, b) => createHash("sha1").update("rando" + a.id).digest("hex").localeCompare(createHash("sha1").update("rando" + b.id).digest("hex")));
  const pool = ["hotdog", "not_hotdog"].flatMap((l) => byHash(live.filter((x) => x.label === l)).slice(0, 19));
  const internal: Ex[] = pool.map((x) => ({ label: x.label, bytes: readFileSync(resolve(DATA, "images", `${x.id}.jpg`)) }));
  for (const e of internal) if (!key[sha(e.bytes)]) key[sha(e.bytes)] = e.label;
  if (!(await exists("hotdog-internal-v0"))) {
    report("hotdog-internal-v0", await createBenchmark(rando, {
      slug: "hotdog-internal-v0", title: "hotdog internal v0", category: "image-classification", labels: ["hotdog", "not_hotdog"], dev_count: 8,
      examples: internal.map((e) => ({ label: e.label, image_base64: e.bytes.toString("base64") })),
      task: TASKS["hotdog-internal-v0"],
    }));
  } else console.log("benchmark hotdog-internal-v0 already exists");

  // 6. the CLI demo dataset: 20 hot dogs (40..59) and 20 look-alikes (12..13 of the negative classes)
  const cli: Ex[] = [...hot.slice(40, 60).map((bytes) => ({ label: "hotdog", bytes })), ...negPool(12, 20).map((bytes) => ({ label: "not_hotdog", bytes }))];
  for (const e of cli) key[sha(e.bytes)] = e.label;
  for (const label of ["hotdog", "not_hotdog"]) {
    mkdirSync(resolve(CLI_DIR, label), { recursive: true });
    cli.filter((e) => e.label === label).forEach((e, i) => writeFileSync(resolve(CLI_DIR, label, `${String(i + 1).padStart(2, "0")}.jpg`), e.bytes));
  }
  rmSync(resolve(DATA, "demo-dataset"), { recursive: true, force: true });
  cpSync(CLI_DIR, resolve(DATA, "demo-dataset"), { recursive: true });
  console.log(`demo dataset: ${cli.length} photos in ${CLI_DIR} and data/demo-dataset`);

  for (const [slug, task] of Object.entries(TASKS)) await db.from("benchmarks").update({ task }).eq("slug", slug);
  writeFileSync(resolve(DATA, "answer-key-food.json"), JSON.stringify(key) + "\n");
  console.log(`answer key: ${Object.keys(key).length - 1} photos -> data/answer-key-food.json`);
  if (!existsSync(resolve(DATA, "answer-key.json"))) console.warn("data/answer-key.json is missing: run seed-image-classification.ts first");
}

async function run() {
  const rescore = flag("--rescore");
  for (const slug of Object.keys(TARGETS).filter((x) => x !== "street-hotdogs-v2")) {
    const { data: b } = await db.from("benchmarks").select("id").eq("slug", slug).single();
    console.log(`\n${slug}`);
    for (const p of DEMO_LISTINGS) {
      const { data: agent } = await db.from("agents").select("id,handle,roles,owner_ref").eq("handle", p.id).single();
      const { data: listing } = await db.from("listings").select("id").eq("provider_id", agent!.id).eq("capability", "image-classification").single();
      const { count } = await db.from("benchmark_results").select("id", { count: "exact", head: true }).eq("benchmark_id", b!.id).eq("listing_id", listing!.id);
      if (count && !rescore) { console.log(`  ${p.id.padEnd(16)} already scored`); continue; }
      const r = await runBenchmark(agent as Agent, { listing_id: listing!.id, benchmark_id: b!.id });
      console.log(`  ${p.id.padEnd(16)} ${String(p.price_cents).padStart(2)}c  accuracy ${r.accuracy} ${JSON.stringify(r.ci95)} n=${r.n} errors=${r.errors} p50=${r.p50_ms}ms p95=${r.p95_ms}ms`);
    }
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
