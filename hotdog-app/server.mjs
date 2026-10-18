// SeeFood: a small app that classifies photos with a model hired on Pareto.
// The browser never sees the Pareto key. This server holds it, talks to Pareto through @pareto/sdk, and serves the UI.
//   PARETO_API_KEY=agk_... PARETO_URL=https://... node server.mjs        (PORT defaults to 4177)
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pareto, ParetoError } from "@pareto/sdk";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 4177);
const PARETO_URL = (process.env.PARETO_URL ?? "http://localhost:3000").replace(/\/+$/, "");
const KEY = process.env.PARETO_API_KEY;
const STATE_FILE = join(here, ".state.json");
const TOTAL = 100;
const CONCURRENCY = 6;
const IMAGES = Array.from({ length: TOTAL }, (_, i) => `live-${String(i + 1).padStart(3, "0")}`);

if (!KEY) {
  console.error("PARETO_API_KEY is not set. Run: PARETO_API_KEY=agk_... PARETO_URL=https://... node server.mjs");
  process.exit(1);
}
const pareto = new Pareto({ apiKey: KEY, baseUrl: PARETO_URL });

// The installed deal survives a restart; that is the only thing the app needs to be told.
let dealId = null;
try { dealId = JSON.parse(await readFile(STATE_FILE, "utf8")).dealId ?? null; } catch { /* first run */ }
const saveState = () => writeFile(STATE_FILE, JSON.stringify({ dealId })).catch(() => {});

// The current run: results by image id, filled as photos come back, so the grid can fill live.
const run = { running: false, done: 0, failed: 0, results: {}, errors: {}, message: "" };

const cache = { at: 0, calls: [], deal: null };
const stale = () => { cache.at = 0; };

async function refresh(force = false) {
  if (!force && Date.now() - cache.at < 800) return;
  cache.at = Date.now();
  try {
    cache.deal = dealId ? await pareto.deals.get(dealId) : null;
    // While the run is going, the in-memory results are fresher than the list and cheaper than asking for it.
    if (dealId && !run.running) cache.calls = await pareto.deals.calls(dealId, { limit: 500 });
    cache.error = null;
  } catch (e) {
    cache.error = e instanceof ParetoError ? `${e.message}${e.fix ? ` ${e.fix}` : ""}` : String(e);
  }
}

/** One tile per photo: what Pareto recorded if it has the call, else what this run just got back. */
function tiles() {
  const byImage = new Map();
  for (const c of cache.calls) if (c.image_id && !byImage.has(c.image_id)) byImage.set(c.image_id, c);
  return IMAGES.map((id) => {
    const c = byImage.get(id);
    if (c) return { id, label: c.label, confidence: c.confidence, call_id: c.call_id, charge_id: c.charge_id, charge_state: c.charge_state, refund: c.refund, created_at: c.created_at };
    const r = run.results[id];
    if (r) return { id, label: r.label, confidence: r.confidence, call_id: r.callId, charge_id: r.chargeId, charge_state: "pending", refund: null, created_at: r.at };
    return { id, label: null, error: run.errors[id] ?? null };
  });
}

function summary() {
  const installed = cache.deal && cache.deal.status === "active" ? cache.deal : null;
  return {
    paretoUrl: PARETO_URL,
    error: cache.error ?? null,
    deal: installed,
    run: { running: run.running, done: run.done, failed: run.failed, total: TOTAL, message: run.message },
    // the photos are always there; until a classifier is installed none of them has a label
    tiles: installed ? tiles() : IMAGES.map((id) => ({ id, label: null, error: null })),
  };
}

async function startRun() {
  if (run.running) return;
  if (!dealId) throw new ParetoError("Install a deal first.", "no_deal", 409);
  // What Pareto already recorded for this deal is not bought twice.
  run.running = false; await refresh(true);
  const have = new Set(cache.calls.filter((c) => c.image_id).map((c) => c.image_id));
  const todo = IMAGES.filter((id) => !have.has(id));
  Object.assign(run, { running: true, done: IMAGES.length - todo.length, failed: 0, results: {}, errors: {}, message: "" });
  const queue = [...todo];
  const deal = dealId;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const worker = async () => {
    for (let id = queue.shift(); id && run.running; id = queue.shift()) {
      try {
        run.results[id] = { ...(await pareto.classify(deal, { imageId: id })), at: new Date().toISOString() };
        run.done++;
        run.message = "";
      } catch (e) {
        // The gateway allows a fixed number of calls a minute per deal. That is a pause, not a failure: wait and retry.
        if (e instanceof ParetoError && e.code === "rate_limited") {
          queue.unshift(id);
          run.message = "Pareto's rate limit for this deal was reached. Continuing in a moment.";
          await sleep(3000);
          continue;
        }
        run.failed++;
        run.errors[id] = e instanceof ParetoError ? e.message : String(e);
        // A spent budget will not recover by retrying: stop and say so.
        if (e instanceof ParetoError && (e.code === "budget_exceeded" || e.code === "not_active")) { run.message = `${e.message} ${e.fix ?? ""}`.trim(); run.running = false; }
      }
    }
  };
  Promise.all(Array.from({ length: CONCURRENCY }, worker)).finally(() => { run.running = false; stale(); });
}

const json = (res, status, body) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)); };
const readBody = async (req) => { let s = ""; for await (const ch of req) s += ch; try { return s ? JSON.parse(s) : {}; } catch { return {}; } };
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png" };

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const path = url.pathname;
  try {
    if (req.method === "GET" && path === "/api/state") { await refresh(); return json(res, 200, summary()); }

    if (req.method === "POST" && path === "/api/install") {
      const { deal_id } = await readBody(req);
      const deal = await pareto.deals.get(String(deal_id ?? ""));
      if (deal.status !== "active") {
        const why = {
          approved: ["That deal is agreed but not funded yet.", "Add money to the wallet and fund the escrow from your agent, then install it."],
          proposed: ["The provider has not accepted that deal yet.", "Wait for the approval, then fund the escrow."],
          countered: ["The provider countered that deal.", "Answer the counter-offer in your agent first."],
          settled: ["That deal is already closed.", "Hire a provider again to get a new deal."],
          cancelled: ["That deal was cancelled.", "Hire a provider again to get a new deal."],
          rejected: ["The provider rejected that deal.", "Hire a different provider."],
          disputed: ["That deal is in a dispute.", "It can not take new calls until the dispute is settled."],
        }[deal.status] ?? [`That deal is ${deal.status}, not active.`, "Only a funded (active) deal can be installed."];
        throw new ParetoError(why[0], "not_active", 409, why[1]);
      }
      dealId = deal.deal_id; saveState(); stale();
      Object.assign(run, { running: false, done: 0, failed: 0, results: {}, errors: {}, message: "" });
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && path === "/api/uninstall") {
      dealId = null; saveState(); stale();
      Object.assign(run, { running: false, done: 0, failed: 0, results: {}, errors: {}, message: "" });
      cache.calls = []; cache.deal = null;
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && path === "/api/run") { await startRun(); return json(res, 202, { ok: true }); }

    // Refunds: the app only forwards; Pareto decides.
    if (req.method === "POST" && path === "/api/refunds") {
      const { charge_id, reason } = await readBody(req);
      if (!dealId) throw new ParetoError("Install a deal first.", "no_deal", 409);
      const refund = await pareto.refunds.request(dealId, String(charge_id ?? ""), String(reason ?? "").trim() || "The label is wrong.");
      stale();
      return json(res, 201, refund);
    }
    const m = path.match(/^\/api\/refunds\/([^/]+)(\/appeal)?$/);
    if (m && req.method === "GET" && !m[2]) return json(res, 200, await pareto.refunds.get(m[1]));
    if (m && req.method === "POST" && m[2]) {
      const { note } = await readBody(req);
      const refund = await pareto.refunds.appeal(m[1], String(note ?? "").trim() || undefined);
      stale();
      return json(res, 200, refund);
    }

    if (req.method === "GET") {
      const file = path === "/" ? "index.html" : path === "/favicon.ico" ? "favicon.png" : path.slice(1);
      if (file.includes("..")) return json(res, 404, { error: "not found" });
      const body = await readFile(join(here, "public", file)).catch(() => null);
      if (!body) return json(res, 404, { error: "not found" });
      res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
      return res.end(body);
    }
    json(res, 404, { error: "not found" });
  } catch (e) {
    if (e instanceof ParetoError) return json(res, e.status >= 400 && e.status < 600 ? e.status : 502, { code: e.code, error: e.message, fix: e.fix });
    json(res, 500, { code: "internal_error", error: String(e) });
  }
});

server.listen(PORT, () => console.log(`SeeFood on http://localhost:${PORT}  (Pareto: ${PARETO_URL}${dealId ? `, deal ${dealId}` : ", no deal installed yet"})`));
