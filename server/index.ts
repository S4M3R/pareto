import { MCPServer } from "mcp-use";
import "./lib/env.js";
import { AGENT_DOCS } from "./lib/docs.js";
import { sweep } from "./lib/disputes.js";
import { MarketError } from "./lib/errors.js";
import { agentFromKey } from "./lib/auth.js";
import { paretoOAuth } from "./lib/oauth.js";
import { html as pageHtml } from "./lib/fixtures.js";
import { expiredPage, topupPage } from "./lib/approve-page.js";
import { getTopupApproval } from "./lib/approvals.js";
import { callThroughGateway } from "./lib/gateway.js";
import { topupViaRail } from "./lib/payments.js";
import { cardPage } from "./lib/card-page.js";
import { finishAddCard, listCards, removeCard, setDefaultCard, startAddCard } from "./lib/cards.js";
import { getCardApproval } from "./lib/approvals.js";
import { MAX_TOPUP_CENTS, TOPUP_PRESETS_CENTS, walletCents } from "./tools/common.js";
import { PROVIDERS, extract } from "./lib/providers.js";
import { registerDemoListingServer } from "./demo/listing-server.js";
import { startDemoAutoApprover } from "./demo/auto-approver.js";
import { registerApi } from "./lib/api.js";
import { registerDealsApi } from "./lib/api-deals.js";
import { registerOwnerApi } from "./lib/api-owner.js";
import { registerRefundsApi } from "./lib/api-refunds.js";
import { registerAccount } from "./tools/account.js";
import { registerCatalog } from "./tools/catalog.js";
import { registerRefunds } from "./tools/refunds.js";
import { registerEarnings } from "./tools/earnings.js";
import { registerDeal } from "./tools/deal.js";
import { registerDiscovery } from "./tools/discovery.js";
import { registerDisputes } from "./tools/disputes.js";
import { registerCards } from "./tools/cards.js";
import { registerMoney } from "./tools/money.js";
import { registerUse } from "./tools/use.js";

const server = new MCPServer({
  name: "pareto",
  title: "Pareto: agent-to-agent marketplace",
  version: "0.1.0",
  // What clients show next to the connector, and the browser tab on our own pages (public/brand).
  icons: [
    { src: "brand/icon.svg", mimeType: "image/svg+xml", sizes: ["any"] },
    { src: "brand/icon-512.png", mimeType: "image/png", sizes: ["512x512"] },
    { src: "brand/icon-192.png", mimeType: "image/png", sizes: ["192x192"] },
    { src: "brand/icon-64.png", mimeType: "image/png", sizes: ["64x64"] },
  ],
  favicon: "brand/icon-64.png",
  websiteUrl: "https://github.com/S4M3R/pareto",
  // Claude connectors sign in with OAuth; agents and scripts keep using API keys. Both reach the same tools.
  oauth: paretoOAuth,
  mixedAuth: true,
  description: "Hire another agent for a capability you lack: benchmarks to choose, escrow to pay, traces to prove, disputes and reviews to build trust.",
  instructions:
    "Marketplace where agents hire agents. Start with whoami (or register_agent if you have no key), then search_benchmarks -> find_providers -> create_task -> propose_agreement -> fund_escrow -> call_provider -> close_task -> review_provider. Every response has a 'next' hint; every error has a 'fix'. Full guide at /llms.txt. Do the work with the plain tools (whoami, search_benchmarks, find_providers, get_agreement, ...): they return data and show nothing. Call a show_* tool, or compare_providers, only when the human asks to see something or has to decide; never to narrate progress. Keep your replies short: one or two plain sentences, and do not repeat numbers a card or chart already shows.",
});

registerAccount(server);
registerDiscovery(server);
registerDeal(server);
registerUse(server);
registerDisputes(server);
registerMoney(server);
registerCatalog(server);
// REST API for listings and benchmarks, and the public sample images
registerApi(server);
registerDealsApi(server);
registerRefundsApi(server);
registerOwnerApi(server);
registerRefunds(server);
registerEarnings(server);
// mock providers for demos: real services, simulated answers (demo/listing-server.ts)
registerDemoListingServer(server);
registerCards(server);

// ───────── agent-readable docs (discoverable without a human) ─────────
server.get("/llms.txt", (c) => c.text(AGENT_DOCS));
server.get("/AGENTS.md", (c) => c.text(AGENT_DOCS));
server.get("/health", (c) => c.json({ ok: true, service: "pareto", at: new Date().toISOString() }));

// ───────── the controlled demo world: fixture pages and the three seeded provider services ─────────
server.get("/fixtures/profile/:id", (c) => c.html(pageHtml(Number(c.req.param("id")))));

server.post("/providers/:name/extract", async (c) => {
  const name = c.req.param("name");
  if (!PROVIDERS[name]) return c.json({ error: "unknown provider" }, 404);
  const body = (await c.req.json().catch(() => ({}))) as { page_id?: number };
  if (!Number.isInteger(body.page_id)) return c.json({ error: "page_id (integer) required" }, 400);
  const r = await extract(name, body.page_id as number);
  return c.json({ fields: r.fields, units_billed: r.units_billed });
});

// ───────── the gateway over plain HTTP (the grant key path) ─────────
server.post("/gw/:agreementId/call", async (c) => {
  try {
    const input = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const apiKey = c.req.header("x-api-key");
    const buyer = apiKey ? await agentFromKey(apiKey) : undefined; // the buyer's own key is enough; a grant key still works
    const r = await callThroughGateway(c.req.param("agreementId"), input, { grantKey: c.req.header("x-grant-key"), agentId: buyer?.id });
    return c.json(r);
  } catch (e) {
    if (e instanceof MarketError) {
      const status = e.code === "unauthorized" ? 401 : e.code === "rate_limited" ? 429 : e.code === "budget_exceeded" ? 402 : 400;
      return c.json({ code: e.code, error: e.message, fix: e.fix }, status);
    }
    return c.json({ code: "internal_error", error: String(e) }, 500);
  }
});

// ───────── human approval for adding funds: a page any client can send the human to ─────────
server.get("/approve/topup/:token", async (c) => {
  const a = getTopupApproval(c.req.param("token"));
  if (!a) return c.html(expiredPage, 410);
  const wallet = await walletCents(a.agentId);
  const short = a.neededCents && a.neededCents > wallet ? a.neededCents - wallet : 0;
  const suggested = short > 0 ? (TOPUP_PRESETS_CENTS.find((p) => p >= short) ?? MAX_TOPUP_CENTS) : 1000;
  // After a top-up, coming back shows the success and a button for more; "Add more" opens the amount picker again.
  const showDone = a.doneCents !== undefined && c.req.query("more") !== "1";
  return c.html(topupPage({
    token: c.req.param("token"), handle: a.handle, walletCents: wallet, neededCents: a.neededCents, reason: a.reason,
    presets: TOPUP_PRESETS_CENTS, suggested, max: MAX_TOPUP_CENTS, rail: process.env.STRIPE_SECRET_KEY ? "stripe-test" : "mock", doneCents: showDone ? a.doneCents : undefined,
  }));
});

server.post("/approve/topup/:token", async (c) => {
  const token = c.req.param("token");
  const a = getTopupApproval(token);
  if (!a) return c.json({ error: "This approval link has expired. Ask your agent for a new one." }, 410);
  const body = (await c.req.json().catch(() => ({}))) as { amount_cents?: number };
  const cents = body.amount_cents;
  if (!Number.isInteger(cents) || (cents as number) < 100 || (cents as number) > MAX_TOPUP_CENTS) return c.json({ error: `Choose an amount between $1.00 and $${MAX_TOPUP_CENTS / 100}.` }, 400);
  try {
    // One idempotency key per attempt: a double click re-sends the same key (no double charge); "Add more" is a new attempt.
    const r = await topupViaRail(a.agentId, cents as number, `approve:${token}:${a.adds ?? 0}`);
    a.doneCents = cents as number;
    a.adds = (a.adds ?? 0) + 1;
    return c.json({ wallet_cents: r.wallet_cents, rail: r.rail });
  } catch (e) {
    const cardUrl = e instanceof MarketError && e.code === "card_required" ? ((e.details?.approval_url as string | undefined) ?? null) : null;
    return c.json({ error: e instanceof MarketError ? e.message : "Could not add funds.", ...(cardUrl ? { card_url: cardUrl } : {}) }, 400);
  }
});


// ───────── human approval for adding a card: Stripe collects it, we keep brand and last four ─────────
const cardApproval = (token: string) => getCardApproval(token);
const testMode = () => !process.env.STRIPE_SECRET_KEY || /_test_/.test(process.env.STRIPE_SECRET_KEY);

server.get("/approve/card/:token", async (c) => {
  const a = cardApproval(c.req.param("token"));
  if (!a) return c.html(expiredPage, 410);
  return c.html(cardPage({ token: c.req.param("token"), handle: a.handle, cards: await listCards(a.agentId), testMode: testMode() }));
});

server.post("/approve/card/:token", async (c) => {
  const token = c.req.param("token");
  const a = cardApproval(token);
  if (!a) return c.json({ error: "This link has expired. Ask your agent for a new one." }, 410);
  try {
    return c.json(await startAddCard({ id: a.agentId, handle: a.handle }, token));
  } catch (e) {
    return c.json({ error: e instanceof MarketError ? e.message : "Could not start adding a card." }, 400);
  }
});

server.get("/approve/card/:token/return", async (c) => {
  const token = c.req.param("token");
  const a = cardApproval(token);
  if (!a) return c.html(expiredPage, 410);
  try {
    const added = await finishAddCard(a.agentId, c.req.query("session_id") ?? "");
    return c.html(cardPage({ token, handle: a.handle, cards: await listCards(a.agentId), added, testMode: testMode() }));
  } catch (e) {
    return c.html(cardPage({ token, handle: a.handle, cards: await listCards(a.agentId), error: e instanceof MarketError ? e.message : "Could not save the card.", testMode: testMode() }), 400);
  }
});

for (const act of ["default", "remove"] as const) {
  server.post(`/approve/card/:token/${act}`, async (c) => {
    const a = cardApproval(c.req.param("token"));
    if (!a) return c.json({ error: "This link has expired. Ask your agent for a new one." }, 410);
    const { id } = (await c.req.json().catch(() => ({}))) as { id?: string };
    try {
      if (!id) return c.json({ error: "Missing card id." }, 400);
      if (act === "default") await setDefaultCard(a.agentId, id);
      else await removeCard(a.agentId, id);
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: e instanceof MarketError ? e.message : "Could not update the card." }, 400);
    }
  });
}

// Release charges whose check window closed; resolve full disputes past their response deadline.
// Never start a tick while the previous one is still waiting on the database: a slow database must not pile up requests.
let sweeping = false;
setInterval(() => {
  if (sweeping) return;
  sweeping = true;
  const giveUp = new Promise<void>((resolve) => setTimeout(resolve, 30_000)); // a hung database call must not stop releases for good
  void Promise.race([sweep(), giveUp]).catch(() => undefined).finally(() => { sweeping = false; });
}, 3000).unref?.();
startDemoAutoApprover();

export default server;
