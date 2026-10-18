/** DEMO LISTING SERVER: mock providers for demos. Not part of the product.
 *
 * These are real HTTP services behind real listings: the platform calls them, benchmarks them, meters them and settles
 * with them exactly as it would anyone's. What is fake is the "model": each persona answers from a reference answer
 * key with a fixed accuracy, latency and billing habit. Answers are deterministic per image and provider, so a repeated
 * call, a benchmark run and a dispute re-run all see the same thing, as a real classifier would.
 * Every response carries `x-demo-provider: mock`, and the listings are flagged platform-operated. */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { mulberry32 } from "../lib/fixtures.js";
import { liveImageBytes } from "../lib/image-data.js";
import type { AnyServer } from "../tools/define.js";

export interface Persona {
  id: string;
  title: string;
  /** What the account is described as. */
  about: string;
  /** Chance of a correct answer per image. Calibrated against the hidden test set so each persona scores at its designed
   * accuracy there (95, 91, 88, 84, 87 and 80 percent); on any other image it is a deterministic coin weighted by this. */
  accuracy: number;
  p50_ms: number;
  /** Share of calls that are slow outliers, and how much slower. */
  slow_pct: number;
  slow_ms: number;
  /** Share of calls billed as two units instead of one. */
  overbill_pct: number;
  price_cents: number;
  /** The latency the provider commits to (p95). */
  sla_p95_ms: number;
}

export const DEMO_LISTINGS: Persona[] = [
  { id: "frankfinder-pro", title: "FrankFinder Pro: Hot Dog Classifier", about: "Premium accuracy, takes its time", accuracy: 0.9131, p50_ms: 650, slow_pct: 0.02, slow_ms: 1500, overbill_pct: 0, price_cents: 8, sla_p95_ms: 2500 },
  { id: "bunvision", title: "BunVision: Hot Dog Classifier", about: "Strong accuracy at a middle price", accuracy: 0.9137, p50_ms: 300, slow_pct: 0.02, slow_ms: 800, overbill_pct: 0, price_cents: 5, sla_p95_ms: 1200 },
  { id: "dogspotter", title: "Dogspotter: Hot Dog Classifier", about: "Quick and affordable", accuracy: 0.9285, p50_ms: 110, slow_pct: 0.01, slow_ms: 400, overbill_pct: 0, price_cents: 3, sla_p95_ms: 600 },
  { id: "wienernet", title: "WienerNet: Hot Dog Classifier", about: "Slower and no cheaper than its neighbours", accuracy: 0.8416, p50_ms: 380, slow_pct: 0.02, slow_ms: 900, overbill_pct: 0, price_cents: 3, sla_p95_ms: 1500 },
  { id: "fastfrank", title: "FastFrank: Hot Dog Classifier", about: "Very fast and cheap; sloppy on billing and latency", accuracy: 0.8804, p50_ms: 60, slow_pct: 0.06, slow_ms: 2500, overbill_pct: 0.12, price_cents: 2, sla_p95_ms: 400 },
  { id: "seefood-lite", title: "SeeFood Lite: Hot Dog Classifier", about: "Cheapest and fastest, least accurate", accuracy: 0.7749, p50_ms: 35, slow_pct: 0, slow_ms: 0, overbill_pct: 0, price_cents: 1, sla_p95_ms: 300 },
];

let key: Record<string, string> | undefined;
/** sha256 of an image's bytes -> its reference label, written by scripts/seed-image-classification.ts */
function answerKey(): Record<string, string> {
  if (!key) {
    const f = resolve(process.cwd(), "data", "answer-key.json");
    if (!existsSync(f)) return {};
    key = JSON.parse(readFileSync(f, "utf8")) as Record<string, string>;
  }
  return key;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function registerDemoListingServer(server: AnyServer) {
  server.get("/demo/listings", (c: any) => // eslint-disable-line @typescript-eslint/no-explicit-any
    c.json({ mock: true, note: "Mock providers for demos: real services, simulated answers.", providers: DEMO_LISTINGS.map((p) => ({ id: p.id, title: p.title, about: p.about, price_cents: p.price_cents, endpoint: `/providers/${p.id}/classify` })) }));

  server.post("/providers/:id/classify", async (c: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const p = DEMO_LISTINGS.find((x) => x.id === c.req.param("id"));
    if (!p) return c.json({ error: "unknown provider" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { image_base64?: string; image_url?: string };
    let bytes: Buffer | undefined;
    if (typeof body.image_base64 === "string" && body.image_base64.length < 2_000_000) bytes = Buffer.from(body.image_base64, "base64");
    else if (typeof body.image_url === "string") {
      const m = /\/images\/(live-\d{3})\.jpg$/.exec(body.image_url); // demo services only fetch from the platform's own sample images
      bytes = m ? liveImageBytes(m[1]) : undefined;
    }
    if (!bytes || bytes.length < 100) return c.json({ error: "Send image_base64 (a JPEG), or an image_url of a platform sample image." }, 400);

    const sha = createHash("sha256").update(bytes).digest("hex");
    const known = answerKey()[sha];
    const truth = known ?? (parseInt(sha.slice(0, 2), 16) % 2 ? "hotdog" : "not_hotdog"); // an image the key has not seen: a stable coin flip
    const rng = mulberry32(parseInt(createHash("sha1").update(p.id + sha).digest("hex").slice(0, 8), 16));
    const correct = rng() < p.accuracy;
    const label = correct ? truth : truth === "hotdog" ? "not_hotdog" : "hotdog";
    const delay = p.p50_ms * (0.75 + 0.5 * rng()) + (rng() < p.slow_pct ? p.slow_ms : 0);
    const billed = rng() < p.overbill_pct ? 2 : 1;
    const confidence = Math.round((correct ? 0.72 + 0.27 * rng() : 0.5 + 0.25 * rng()) * 1000) / 1000;
    await sleep(delay);
    return c.json({ label, confidence, units_billed: billed }, 200, { "x-demo-provider": "mock" });
  });
}
