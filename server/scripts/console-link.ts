/** Prints a sign-in link for the web console (refund decisions on a phone, benchmark earnings on a laptop).
 * It asks the server for the link with the agent's API key, so it works against any server without sharing its secrets.
 * Usage: pnpm tsx scripts/console-link.ts <agent-handle> [benchmarks|refunds=benchmarks] [server-url=http://localhost:3100] */
import "../lib/env.js";
import { demoKey } from "../lib/demo-keys.js";

const [handle, which = "benchmarks", base = process.env.PARETO_URL ?? "http://localhost:3100"] = process.argv.slice(2);
if (!handle) { console.error("usage: console-link.ts <agent-handle> [benchmarks|refunds] [server-url]"); process.exit(1); }
const r = await fetch(`${base.replace(/\/$/, "")}/api/console-link`, { method: "POST", headers: { "x-api-key": demoKey(handle) } });
const body = (await r.json()) as { benchmarks_url?: string; refunds_url?: string; error?: string };
if (!r.ok) { console.error(body.error ?? `HTTP ${r.status}`); process.exit(1); }
console.log(which === "refunds" ? body.refunds_url : body.benchmarks_url);
