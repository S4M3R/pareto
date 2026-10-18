import { createHash } from "node:crypto";
export type Label = "hotdog" | "not_hotdog";

/** A labelled image. `bytes` are already normalised (see normalizeImage). */
export interface LabelledImage { id: string; label: Label; bytes: Buffer }

/** Every stored image is a 256px JPEG: small, uniform, and stripped of metadata. */
export async function normalizeImage(bytes: Buffer): Promise<Buffer> {
  const { default: sharp } = await import("sharp"); // loaded on use: a host without the native binary can still serve everything else
  const meta = await sharp(bytes).metadata();
  if (meta.format === "jpeg" && (meta.width ?? 9999) <= 256 && (meta.height ?? 9999) <= 256 && !meta.orientation) return bytes; // already normalised: leave the bytes alone
  return sharp(bytes).rotate().resize({ width: 256, height: 256, fit: "inside", withoutEnlargement: true }).flatten({ background: "#ffffff" }).jpeg({ quality: 78 }).toBuffer();
}

const h = (s: string) => createHash("sha1").update(s).digest("hex");

/** Deterministic split of the downloaded dataset, the same on every machine:
 *   hidden  50 + 50 from its test folder  -> the benchmark's hidden test set (never published)
 *   dev     4 + 4 from its val folder     -> public examples providers may look at
 *   live    everything else               -> the pool agents use for real jobs; disjoint from the hidden set */
export function splitDataset(files: { name: string; label: Label; split: "test" | "val" }[]) {
  const pick = (split: "test" | "val", label: Label) => files.filter((f) => f.split === split && f.label === label).sort((a, b) => h(a.name).localeCompare(h(b.name)));
  const out = { hidden: [] as typeof files, dev: [] as typeof files, live: [] as typeof files };
  for (const label of ["hotdog", "not_hotdog"] as Label[]) {
    const t = pick("test", label), v = pick("val", label);
    out.hidden.push(...t.slice(0, 50)); out.live.push(...t.slice(50));
    out.dev.push(...v.slice(0, 4)); out.live.push(...v.slice(4));
  }
  return out;
}
