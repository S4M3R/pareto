import { createHash } from "node:crypto";
import { type Profile, FIELDS, html, parse, truth } from "./fixtures.js";

/** Three seeded provider services with deliberately different behavior. Deterministic per (provider, page),
 * so re-running a trace during a dispute reproduces the same output. */
export interface ProviderSpec {
  key: "careful" | "cheap" | "sloppy";
  title: string;
  fieldErrorRate: number;
  latency: [number, number];
  slowRate: number;       // chance of a slow outlier
  doubleBillRate: number; // chance units_billed is 2 for one page
  priceCents: number;
}

export const PROVIDERS: Record<string, ProviderSpec> = {
  careful: { key: "careful", title: "Careful Extractor", fieldErrorRate: 0.01, latency: [80, 220], slowRate: 0.01, doubleBillRate: 0, priceCents: 10 },
  cheap: { key: "cheap", title: "Budget Extractor", fieldErrorRate: 0.14, latency: [40, 110], slowRate: 0.02, doubleBillRate: 0, priceCents: 4 },
  sloppy: { key: "sloppy", title: "FastScrape Pro", fieldErrorRate: 0.1, latency: [450, 1300], slowRate: 0.12, doubleBillRate: 0.18, priceCents: 6 },
};

/** Stable pseudo-random in [0,1) from a string. */
function h01(s: string): number {
  return parseInt(createHash("sha1").update(s).digest("hex").slice(0, 8), 16) / 0xffffffff;
}

function corrupt(field: (typeof FIELDS)[number], v: Profile[typeof field]): Profile[typeof field] {
  if (field === "years") return (v as number) + 1;
  if (field === "skills") return (v as string[]).slice(1);
  const s = v as string;
  return s.includes(" ") ? s.split(" ")[0] : "N/A";
}

export interface ExtractResult {
  fields: Profile;
  units_billed: number;
  latency_ms: number;
}

/** Runs one extraction. `sleep` lets the seeder skip real waiting while keeping the simulated latency numbers. */
export async function extract(providerKey: string, pageId: number, sleep = true): Promise<ExtractResult> {
  const spec = PROVIDERS[providerKey];
  if (!spec) throw new Error(`unknown provider ${providerKey}`);
  const fields = parse(html(pageId));
  for (const f of FIELDS) {
    if (h01(`${providerKey}:${pageId}:${f}`) < spec.fieldErrorRate) {
      (fields as unknown as Record<string, unknown>)[f] = corrupt(f, fields[f]);
    }
  }
  const [lo, hi] = spec.latency;
  let latency = lo + h01(`${providerKey}:${pageId}:lat`) * (hi - lo);
  if (h01(`${providerKey}:${pageId}:slow`) < spec.slowRate) latency = 2200 + h01(`${providerKey}:${pageId}:lat2`) * 1800;
  if (sleep) await new Promise((r) => setTimeout(r, Math.round(latency)));
  const units = h01(`${providerKey}:${pageId}:bill`) < spec.doubleBillRate ? 2 : 1;
  return { fields, units_billed: units, latency_ms: Math.round(latency) };
}

export { truth };
