import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/** The live pool: labelled images agents can use for real jobs, with reference labels the platform keeps to check
 * results (the same role the hidden test set plays for benchmarks, but these are not secret). Files ship with the
 * server; the working directory is the project root under `mcp-use dev`, `start`, and on Manufact Cloud. */
const DIR = resolve(process.cwd(), "data");
export interface LiveImage { id: string; label: string }

let cache: LiveImage[] | undefined;
export function liveImages(): LiveImage[] {
  if (!cache) {
    const f = resolve(DIR, "live-images.json");
    cache = existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as LiveImage[]) : [];
  }
  return cache;
}

/** A second, separate pool for the cat or dog example (data/pet-images.json, ids pet-001...), with its own reference labels. */
let petCache: LiveImage[] | undefined;
export function petImages(): LiveImage[] {
  if (!petCache) {
    const f = resolve(DIR, "pet-images.json");
    petCache = existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as LiveImage[]) : [];
  }
  return petCache;
}

const safeId = (id: string) => /^(live|pet)-\d{3}$/.test(id);
export const liveImagePath = (id: string) => (safeId(id) ? resolve(DIR, "images", `${id}.jpg`) : undefined);
export function liveImageBytes(id: string): Buffer | undefined {
  const p = liveImagePath(id);
  return p && existsSync(p) ? readFileSync(p) : undefined;
}
export const liveLabel = (id: string) => (id.startsWith("pet-") ? petImages() : liveImages()).find((i) => i.id === id)?.label;
