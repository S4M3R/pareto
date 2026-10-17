import { MCPServer } from "mcp-use";
import "./lib/env.js";
import { AGENT_DOCS } from "./lib/docs.js";
import { sweep } from "./lib/disputes.js";
import { MarketError } from "./lib/errors.js";
import { html as pageHtml } from "./lib/fixtures.js";
import { callThroughGateway } from "./lib/gateway.js";
import { PROVIDERS, extract } from "./lib/providers.js";
import { registerAccount } from "./tools/account.js";
import { registerDeal } from "./tools/deal.js";
import { registerDiscovery } from "./tools/discovery.js";
import { registerDisputes } from "./tools/disputes.js";
import { registerMoney } from "./tools/money.js";
import { registerUse } from "./tools/use.js";

const server = new MCPServer({
  name: "agora",
  title: "Agora: agent-to-agent marketplace",
  version: "0.1.0",
  description: "Hire another agent for a capability you lack: benchmarks to choose, escrow to pay, traces to prove, disputes and reviews to build trust.",
  instructions:
    "Marketplace where agents hire agents. Start with whoami (or register_agent if you have no key), then search_benchmarks -> find_providers -> create_task -> propose_agreement -> fund_escrow -> call_provider -> close_task -> review_provider. Every response has a 'next' hint; every error has a 'fix'. Full guide at /llms.txt.",
});

registerAccount(server);
registerDiscovery(server);
registerDeal(server);
registerUse(server);
registerDisputes(server);
registerMoney(server);

// ───────── agent-readable docs (discoverable without a human) ─────────
server.get("/llms.txt", (c) => c.text(AGENT_DOCS));
server.get("/AGENTS.md", (c) => c.text(AGENT_DOCS));
server.get("/health", (c) => c.json({ ok: true, service: "agora", at: new Date().toISOString() }));

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
    const input = (await c.req.json().catch(() => ({}))) as { page_id: number };
    const r = await callThroughGateway(c.req.param("agreementId"), input, { grantKey: c.req.header("x-grant-key") });
    return c.json(r);
  } catch (e) {
    if (e instanceof MarketError) {
      const status = e.code === "unauthorized" ? 401 : e.code === "rate_limited" ? 429 : e.code === "budget_exceeded" ? 402 : 400;
      return c.json({ code: e.code, error: e.message, fix: e.fix }, status);
    }
    return c.json({ code: "internal_error", error: String(e) }, 500);
  }
});

// Release charges whose check window closed; resolve full disputes past their response deadline.
setInterval(() => void sweep().catch(() => undefined), 3000).unref?.();

export default server;
