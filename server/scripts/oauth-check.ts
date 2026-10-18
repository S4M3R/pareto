/** Plays the part of a connector (claude.ai, Claude Desktop): discovers, registers, signs in, exchanges the code with
 * PKCE, calls tools with the token, refreshes, and checks what must be refused.
 * Usage: BASE=http://localhost:3100 KEY=<agent key> pnpm tsx scripts/oauth-check.ts */
import { createHash, randomBytes } from "node:crypto";
import { demoKey } from "../lib/demo-keys.js";

const BASE = process.env.BASE ?? "http://localhost:3100";
const KEY = process.env.KEY ?? demoKey("demo-buyer");
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const ok = (c: boolean, m: string) => { if (!c) throw new Error("FAILED: " + m); console.log("  ✔ " + m); };

async function mcp(tool: string, args: object = {}, headers: Record<string, string> = {}) {
  const r = await fetch(`${BASE}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }) });
  const t = await r.text();
  const line = t.split("\n").find((l) => l.startsWith("data:"));
  const body = line ? JSON.parse(line.slice(5)) : (t ? JSON.parse(t) : {});
  return { status: r.status, www: r.headers.get("www-authenticate"), result: body.result as { isError?: boolean; structuredContent?: Record<string, unknown> } | undefined };
}

async function main() {
  console.log("== discovery");
  const prm = await (await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`)).json() as { authorization_servers: string[] };
  const as = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json() as Record<string, string | string[]>;
  ok(prm.authorization_servers[0] === as.issuer, "protected resource points at the authorization server");
  ok((as.code_challenge_methods_supported as string[]).includes("S256"), "PKCE S256 advertised");

  console.log("== sign-in challenge");
  const noauth = await mcp("sign_in");
  ok(noauth.status === 401 && /resource_metadata=/.test(noauth.www ?? ""), "sign_in while signed out answers 401 with a WWW-Authenticate challenge");
  const anon = await mcp("whoami");
  ok(anon.status === 200 && anon.result?.isError === true && /Connect|key/i.test(JSON.stringify(anon.result.structuredContent)), "other tools stay usable but tell a signed-out caller how to sign in");

  console.log("== register, sign in, exchange");
  const reg = await (await fetch(as.registration_endpoint as string, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Claude (check)", redirect_uris: [REDIRECT] }) })).json() as { client_id: string };
  ok(reg.client_id.startsWith("pareto_c_"), "dynamic client registration");
  const bad = await fetch(as.registration_endpoint as string, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: ["javascript:alert(1)"] }) });
  ok(bad.status === 400, "a javascript: redirect URI is refused at registration");

  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const q = new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: REDIRECT, state: "xyz", code_challenge: challenge, code_challenge_method: "S256", scope: "pareto", resource: `${BASE}/mcp` });
  const page = await fetch(`${as.authorization_endpoint}?${q}`);
  const html = await page.text();
  ok(page.status === 200 && html.includes("Connect Claude (check) to Pareto") && page.headers.get("x-frame-options") === "DENY", "authorize page renders, and refuses to be framed");
  const evil = await fetch(`${as.authorization_endpoint}?${new URLSearchParams({ ...Object.fromEntries(q), redirect_uri: "https://evil.example/cb" })}`);
  ok(evil.status === 400, "an unregistered redirect URI is refused");

  const form = (extra: Record<string, string>) => new URLSearchParams({ client_id: reg.client_id, redirect_uri: REDIRECT, state: "xyz", code_challenge: challenge, code_challenge_method: "S256", scope: "pareto", resource: `${BASE}/mcp`, mode: "key", ...extra });
  const wrong = await fetch(as.authorization_endpoint as string, { method: "POST", body: form({ api_key: "agk_not_a_real_key" }), redirect: "manual" });
  ok(wrong.status === 400, "a wrong agent key does not get a code");
  const good = await fetch(as.authorization_endpoint as string, { method: "POST", body: form({ api_key: KEY }), redirect: "manual" });
  const loc = new URL(good.headers.get("location") ?? "");
  ok(good.status === 302 && loc.origin + loc.pathname === REDIRECT && loc.searchParams.get("state") === "xyz", "the right key redirects back with a code and the state");
  const code = loc.searchParams.get("code")!;

  const tok = (body: Record<string, string>) => fetch(as.token_endpoint as string, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) });
  ok((await tok({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: reg.client_id, code_verifier: randomBytes(32).toString("base64url") })).status === 400, "a wrong PKCE verifier is refused");
  ok((await tok({ grant_type: "authorization_code", code, redirect_uri: "https://claude.ai/other", client_id: reg.client_id, code_verifier: verifier })).status === 400, "a different redirect URI is refused");
  const t = await (await tok({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: reg.client_id, code_verifier: verifier })).json() as { access_token: string; refresh_token: string; expires_in: number; token_type: string };
  ok(t.token_type === "Bearer" && t.expires_in === 3600 && !!t.refresh_token, "the code exchanges for an access token and a refresh token");

  console.log("== calls");
  const me = await mcp("whoami", {}, { authorization: `Bearer ${t.access_token}` });
  ok(me.result?.structuredContent?.handle !== undefined && me.result?.isError !== true, `whoami with the OAuth token acts as ${me.result?.structuredContent?.handle}`);
  ok((await mcp("sign_in", {}, { authorization: `Bearer ${t.access_token}` })).result?.structuredContent?.signed_in === true, "sign_in confirms the signed-in agent");
  const viaKey = await mcp("whoami", {}, { "x-api-key": KEY });
  ok(viaKey.result?.structuredContent?.handle === me.result?.structuredContent?.handle, "the x-api-key header still works and is the same agent");
  const viaBearerKey = await mcp("whoami", {}, { authorization: `Bearer ${KEY}` });
  ok(viaBearerKey.result?.structuredContent?.handle === me.result?.structuredContent?.handle, "an agent key as a bearer token works too");
  const tampered = await mcp("whoami", {}, { authorization: `Bearer ${t.access_token.slice(0, -3)}abc` });
  ok(tampered.status === 401, "a tampered token is refused with 401");

  console.log("== refresh");
  const r = await (await tok({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: reg.client_id })).json() as { access_token?: string };
  ok(!!r.access_token && (await mcp("whoami", {}, { authorization: `Bearer ${r.access_token}` })).result?.isError !== true, "the refresh token mints a working access token");
  ok((await tok({ grant_type: "refresh_token", refresh_token: t.access_token, client_id: reg.client_id })).status === 400, "an access token cannot be used as a refresh token");

  console.log("\nALL OAUTH CHECKS PASSED");
}
main().catch((e) => { console.error(e.message); process.exit(1); });
