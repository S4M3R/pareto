/** @pareto/sdk: a small TypeScript client for Pareto. Zero dependencies; uses the global `fetch` (Node 20+, browsers, edge).
 *
 *   const pareto = new Pareto({ apiKey: process.env.PARETO_API_KEY!, baseUrl: "https://..." });
 *   const [deal] = await pareto.deals.list({ status: "active" });
 *   const answer = await pareto.classify(deal.deal_id, { imageId: "live-001" });
 *
 * Keep the key on a server. Every method throws a `ParetoError` carrying the platform's `code` and a concrete `fix`. */

export interface ParetoOptions {
  apiKey?: string;
  /** Defaults to `process.env.PARETO_URL`, then `http://localhost:3000`. */
  baseUrl?: string;
  /** A fetch to use instead of the global one (tests, proxies). */
  fetch?: typeof fetch;
}

export class ParetoError extends Error {
  constructor(message: string, readonly code: string, readonly status: number, readonly fix?: string) {
    super(message);
    this.name = "ParetoError";
  }
}

// ───────── types (the shapes the REST API returns) ─────────
export interface DealSpend {
  calls: number; charged_cents: number; refunded_cents: number; pending_cents: number; released_cents: number; remaining_cents: number;
}
export interface Deal {
  deal_id: string;
  status: string;
  provider: string;
  title: string;
  capability: string;
  price_cents_per_call: number;
  cap_cents: number;
  benchmark_id: string | null;
  /** Seconds after each call during which a refund can be requested (24 hours by default). */
  check_window_s: number | null;
  created_at: string;
  spend?: DealSpend;
}
export type RefundStatus = "awaiting_provider" | "refunded" | "rejected" | "under_review" | "refunded_on_appeal" | "denied_on_appeal";
export interface DealCall {
  call_id: string;
  charge_id: string;
  seq: number;
  charge_state: "pending" | "released" | "refunded" | "partially_refunded" | "disputed" | "frozen";
  charged_cents: number;
  label: string | null;
  confidence: number | null;
  image_id: string | null;
  image_url: string | null;
  created_at: string;
  refund: { refund_id: string; status: RefundStatus } | null;
}
export interface Refund {
  refund_id: string;
  deal_id: string;
  charge_id: string;
  status: RefundStatus;
  amount_cents: number;
  call_seq: number;
  buyer: string;
  provider: string;
  image_id: string | null;
  image_url: string | null;
  answered: { label: string | null; confidence: number | null };
  claim: { reason: string; at: string };
  provider_decision: { decision: "approve" | "reject"; note: string | null; at: string } | null;
  appeal: { note: string | null; at: string } | null;
  final: { outcome: "refunded" | "denied"; reasoning: string; evidence: Record<string, unknown> } | null;
  created_at: string;
}
export type ClassifyInput = { imageId: string } | { imageUrl: string } | { imageBase64: string };
export interface Classification {
  label: string;
  confidence: number | null;
  callId: string;
  chargeId: string;
  seq: number;
  chargedCents: number;
  /** `pending` (disputable), or `auto_refunded` when a check failed. */
  status: string;
  checks: { type: string; passed: boolean; detail: string }[];
}
export interface BenchmarkExample {
  label: string;
  imageUrl?: string;
  imageBase64?: string;
  /** A path to an image file (Node only). */
  file?: string;
}
export interface PublishBenchmarkInput {
  slug: string;
  title: string;
  task: string;
  labels: string[];
  examples: BenchmarkExample[];
  devCount?: number;
}
export interface Published { benchmark_id: string; slug: string; labels: string[]; n_test: number; dev_examples: number; fingerprint: string }
export interface Score { benchmark: string; listing: string; accuracy: number; ci95: [number, number]; n: number; correct: number; errors: number; p50_ms: number; p95_ms: number }
export interface Listing { listing_id: string; provider: string; title: string; capability: string; kind: string; price_cents_per_call: number; max_latency_ms: number; platform_operated: boolean }

const enc = encodeURIComponent;

export class Pareto {
  readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ParetoOptions = {}) {
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
    this.apiKey = opts.apiKey ?? env.PARETO_API_KEY;
    this.baseUrl = (opts.baseUrl ?? env.PARETO_URL ?? "http://localhost:3000").replace(/\/+$/, "");
    this.fetchImpl = opts.fetch ?? ((...a) => fetch(...a));
  }

  /** One HTTP call. Errors from the platform become `ParetoError`s with the platform's code and fix. */
  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (this.apiKey) headers["x-api-key"] = this.apiKey;
    if (body !== undefined) headers["content-type"] = "application/json";
    let res: Response;
    try {
      res = await this.fetchImpl(this.baseUrl + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (e) {
      throw new ParetoError(`Could not reach Pareto at ${this.baseUrl}: ${(e as Error).message}`, "unreachable", 0, "Check PARETO_URL and your network.");
    }
    const text = await res.text();
    let json: unknown = undefined;
    try { json = text ? JSON.parse(text) : undefined; } catch { /* not JSON */ }
    if (!res.ok) {
      const j = (json ?? {}) as { code?: string; error?: string; fix?: string };
      throw new ParetoError(j.error ?? `HTTP ${res.status}`, j.code ?? "http_error", res.status, j.fix);
    }
    return json as T;
  }

  readonly deals = {
    list: async (o: { status?: string } = {}): Promise<Deal[]> => (await this.request<{ deals: Deal[] }>("GET", `/api/deals${o.status ? `?status=${enc(o.status)}` : ""}`)).deals,
    get: (id: string): Promise<Deal> => this.request("GET", `/api/deals/${enc(id)}`),
    calls: async (id: string, o: { limit?: number } = {}): Promise<DealCall[]> => (await this.request<{ calls: DealCall[] }>("GET", `/api/deals/${enc(id)}/calls${o.limit ? `?limit=${o.limit}` : ""}`)).calls,
  };

  /** Run one image through a deal's gateway. The platform meters the call, records it and checks it; the charge stays
   * disputable (see `refunds.request`) until the deal's check window closes. */
  async classify(dealId: string, input: ClassifyInput): Promise<Classification> {
    const body = "imageId" in input ? { image_id: input.imageId } : "imageUrl" in input ? { image_url: input.imageUrl } : { image_base64: input.imageBase64 };
    const r = await this.request<{
      call_id: string; charge_id: string; seq: number; status: string; charged_cents: number;
      result: { label?: string; confidence?: number } | null; checks: { type: string; passed: boolean; detail: string }[];
    }>("POST", `/gw/${enc(dealId)}/call`, body);
    if (!r.result || typeof r.result.label !== "string") throw new ParetoError("The provider returned no label.", "no_result", 502, "Retry, or ask for a refund of this call.");
    return { label: r.result.label, confidence: typeof r.result.confidence === "number" ? r.result.confidence : null, callId: r.call_id, chargeId: r.charge_id, seq: r.seq, chargedCents: r.charged_cents, status: r.status, checks: r.checks };
  }

  readonly refunds = {
    /** Ask the provider to refund one call. They decide first; if they refuse you can appeal to the platform. */
    request: (dealId: string, chargeId: string, reason: string): Promise<Refund> => this.request("POST", `/api/deals/${enc(dealId)}/refunds`, { charge_id: chargeId, reason }),
    get: (id: string): Promise<Refund> => this.request("GET", `/api/refunds/${enc(id)}`),
    /** After a rejection: the platform re-checks the recorded call against the reference answer and decides. */
    appeal: (id: string, note?: string): Promise<Refund> => this.request("POST", `/api/refunds/${enc(id)}/appeal`, { note }),
  };

  readonly listings = {
    list: async (o: { capability?: string } = {}): Promise<Listing[]> => (await this.request<{ listings: Listing[] }>("GET", `/api/listings${o.capability ? `?capability=${enc(o.capability)}` : ""}`)).listings,
  };

  readonly benchmarks = {
    /** Publish a labelled dataset as a benchmark. Some images become public dev examples; the rest are a hidden test set. */
    publish: async (i: PublishBenchmarkInput): Promise<Published> => {
      const examples = await Promise.all(i.examples.map(async (e) => {
        if (e.imageUrl) return { label: e.label, image_url: e.imageUrl };
        if (e.imageBase64) return { label: e.label, image_base64: e.imageBase64 };
        if (e.file) {
          const { readFile } = await import("node:fs/promises");
          return { label: e.label, image_base64: (await readFile(e.file)).toString("base64") };
        }
        throw new ParetoError(`Example '${e.label}' needs imageUrl, imageBase64 or file.`, "bad_input", 400);
      }));
      return this.request("POST", "/api/benchmarks", { slug: i.slug, title: i.title, task: i.task, category: "image-classification", labels: i.labels, examples, dev_count: i.devCount ?? 8 });
    },
    /** Handles of the providers that already have a verified score on a benchmark (by slug or id): the models to reuse on a new one. */
    providersOf: async (slugOrId: string): Promise<string[]> => {
      const all = (await this.request<{ benchmarks: { benchmark_id: string; slug: string }[] }>("GET", "/api/benchmarks")).benchmarks;
      const b = all.find((x) => x.slug === slugOrId || x.benchmark_id === slugOrId);
      if (!b) throw new ParetoError(`No public benchmark called '${slugOrId}'.`, "not_found", 404);
      const listings = await this.listings.list({ capability: "image-classification" });
      const scored = await Promise.all(listings.map(async (l) => {
        const r = await this.request<{ results: { benchmark_id: string }[] }>("GET", `/api/listings/${enc(l.listing_id)}/results`);
        return r.results.some((x) => x.benchmark_id === b.benchmark_id) ? l.provider : null;
      }));
      return scored.filter((p): p is string => p !== null);
    },
    /** Have the platform score a listing on a benchmark. Allowed for the benchmark's owner and the listing's provider. */
    score: (listingId: string, benchmarkId: string): Promise<Score> => this.request("POST", `/api/listings/${enc(listingId)}/runs`, { benchmark_id: benchmarkId }),
  };
}
