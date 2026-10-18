/** What the platform needs to know about each kind of work, so the gateway, the evals and disputes are not tied to one
 * capability. A capability turns an agent's input into the request the provider receives, finds the answer in the
 * provider's response, and, where the platform holds a reference answer, checks it. */
import { createHash } from "node:crypto";
import { FIELDS, scoreFields } from "./fixtures.js";
import { MarketError } from "./errors.js";
import { liveImageBytes, liveLabel } from "./image-data.js";

type Obj = Record<string, unknown>;

export interface Capability {
  id: string;
  /** Validate the agent's input. `request` is what the trace records (small); `body` is what the provider receives. */
  prepare(input: Obj): { request: Obj; body: Obj };
  /** The answer inside a provider response. */
  fieldsOf(response: Obj | null | undefined): Obj | undefined;
  /** What is missing from an answer (schema check). */
  missing(fields: Obj | undefined): string[];
  /** Compare with the reference answer, or null when this request has none. */
  check(request: Obj, fields: Obj | undefined): { accuracy: number; wrong: string[] } | null;
}

const profileExtraction: Capability = {
  id: "profile-extraction",
  prepare(input) {
    if (!Number.isInteger(input.page_id)) throw new MarketError("bad_input", "page_id (integer) is required for profile-extraction.", 'Send {"page_id": 123}.');
    return { request: { page_id: input.page_id }, body: { page_id: input.page_id } };
  },
  fieldsOf: (r) => (r?.fields as Obj | undefined),
  missing: (f) => (f ? FIELDS.filter((k) => f[k] === undefined) : [...FIELDS]),
  check: (req, f) => (Number.isInteger(req.page_id) ? scoreFields(f as never, req.page_id as number) : null),
};

const MAX_BASE64 = 1_400_000; // about 1 MB of image

const imageClassification: Capability = {
  id: "image-classification",
  prepare(input) {
    const id = input.image_id, url = input.image_url, b64 = input.image_base64;
    const given = [id, url, b64].filter((x) => x !== undefined && x !== null && x !== "");
    if (given.length !== 1) throw new MarketError("bad_input", "Send exactly one of image_id, image_url or image_base64.", "Use image_id for a live-pool image (list_sample_images), image_url for a public https image, or image_base64 for your own (under 1 MB).");
    if (typeof id === "string") {
      const bytes = liveImageBytes(id);
      if (!bytes) throw new MarketError("bad_input", `Unknown image_id '${id}'.`, "list_sample_images shows the ids you can use.");
      return { request: { image_id: id }, body: { image_base64: bytes.toString("base64"), mime: "image/jpeg" } };
    }
    if (typeof url === "string") {
      if (!/^https?:\/\//.test(url)) throw new MarketError("bad_input", "image_url must be an http(s) URL.", "Send a public https URL, or image_base64.");
      return { request: { image_url: url }, body: { image_url: url } };
    }
    if (typeof b64 !== "string" || b64.length > MAX_BASE64) throw new MarketError("bad_input", "image_base64 must be a string under about 1 MB.", "Downscale the image first (a 256px JPEG is plenty).");
    return { request: { image_sha256: createHash("sha256").update(b64).digest("hex").slice(0, 16) }, body: { image_base64: b64, mime: "image/jpeg" } };
  },
  fieldsOf(r) {
    if (!r) return undefined;
    if (r.fields && typeof r.fields === "object") return r.fields as Obj; // tolerate the envelope form
    const { units_billed: _u, ...rest } = r; // eslint-disable-line @typescript-eslint/no-unused-vars
    return rest;
  },
  missing(f) {
    const out: string[] = [];
    if (!f || typeof f.label !== "string" || !f.label) out.push("label (a string)");
    return out;
  },
  check(req, f) {
    if (typeof req.image_id !== "string") return null; // only live-pool images have a reference label
    const want = liveLabel(req.image_id);
    if (!want) return null;
    const right = f?.label === want;
    return { accuracy: right ? 1 : 0, wrong: right ? [] : [`label: got ${JSON.stringify(f?.label ?? null)}, expected ${want}`] };
  },
};

const REGISTRY: Record<string, Capability> = { [profileExtraction.id]: profileExtraction, [imageClassification.id]: imageClassification };

/** Agreements made before capabilities existed carry no capability and were all profile extraction. */
export const capabilityFor = (id: string | undefined): Capability => REGISTRY[id ?? ""] ?? profileExtraction;
export const knownCapabilities = () => Object.keys(REGISTRY);
