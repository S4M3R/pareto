/** OAuth for MCP clients that can only sign in with OAuth (the claude.ai and Claude Desktop connector dialogs).
 *
 * The server is its own authorization server. "Sign in" means choosing the agent account to act as, by presenting that
 * agent's API key (or creating a new agent). Everything is stateless so it works on any number of instances:
 *   - client ids carry their own redirect URIs (dynamic client registration needs no storage),
 *   - authorization codes, access tokens and refresh tokens are HS256 JWTs signed with OAUTH_SECRET.
 * Access tokens carry the agent's key fingerprint, so rotating the key signs every connection out.
 * Production path: swap the sign-in step for GitHub or Google with mcp-use's oauthProxy; the rest stays.
 */
import { createHash, randomBytes } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { OAuthError, OAuthErrorCode, oauthCustomProvider, type OAuthAuthInfo, type OAuthMetadata, type OAuthProviderRouteHandler, type OAuthTokenVerifier } from "mcp-use/oauth";

type Context = Parameters<OAuthProviderRouteHandler>[0];
import { type Agent, OAUTH_SCOPE, agentById, agentFromKey, createAgent } from "./auth.js";
import { MarketError } from "./errors.js";
import { type AuthorizeParams, authorizePage, errorPage, newKeyPage } from "./oauth-pages.js";

export interface AgentUser { id: string; handle: string }

const SCOPE = OAUTH_SCOPE;
const ACCESS_TTL_S = 3600;
const REFRESH_TTL_S = 30 * 24 * 3600;
const CODE_TTL_S = 300;

let warned = false;
function secret(): Uint8Array {
  let s = process.env.OAUTH_SECRET;
  if (!s || s.length < 32) {
    if (!warned) {
      console.warn("[oauth] OAUTH_SECRET is not set (32+ chars). Using a random key: sign-ins end when the process stops. Set it in production.");
      warned = true;
    }
    s = (globalThis as { __pareto_oauth?: string }).__pareto_oauth ??= randomBytes(32).toString("base64url");
  }
  return new TextEncoder().encode(s);
}

const b64 = (s: string) => Buffer.from(s).toString("base64url");
const unb64 = (s: string) => Buffer.from(s, "base64url").toString();
const invalid = (m: string) => new OAuthError(OAuthErrorCode.InvalidToken, m);

// ───────── clients (stateless dynamic client registration) ─────────
const CLIENT_PREFIX = "pareto_c_";
interface ClientInfo { redirectUris: string[]; name: string }

function redirectUriOk(u: string): boolean {
  try {
    const url = new URL(u);
    if (["javascript:", "data:", "vbscript:", "file:", "blob:"].includes(url.protocol)) return false;
    if (url.hash) return false;
    if (url.protocol === "https:") return true;
    if (url.protocol === "http:") return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    return true; // an app's own scheme, e.g. claude://
  } catch {
    return false;
  }
}

function decodeClient(clientId: string): ClientInfo | undefined {
  if (!clientId.startsWith(CLIENT_PREFIX)) return undefined;
  try {
    const j = JSON.parse(unb64(clientId.slice(CLIENT_PREFIX.length))) as { r?: string[]; n?: string };
    if (!Array.isArray(j.r) || j.r.length === 0 || !j.r.every((x) => typeof x === "string" && redirectUriOk(x))) return undefined;
    return { redirectUris: j.r, name: String(j.n ?? "an app").slice(0, 60) };
  } catch {
    return undefined;
  }
}

// ───────── responses ─────────
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type, authorization", "access-control-allow-methods": "POST, OPTIONS" };
const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", pragma: "no-cache", ...CORS, ...extra } });
const oauthError = (error: string, description: string, status = 400) => json({ error, error_description: description }, status);
const page = (html: string, status = 200) =>
  new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "content-security-policy": "frame-ancestors 'none'" } });

// light brute-force guard for the sign-in form (per process; keys are high entropy, this just slows guessing)
const attempts = new Map<string, { n: number; reset: number }>();
function tooMany(ip: string): boolean {
  const now = Date.now();
  const a = attempts.get(ip);
  if (!a || now > a.reset) { attempts.set(ip, { n: 1, reset: now + 60_000 }); return false; }
  return ++a.n > 10;
}

// ───────── tokens ─────────
async function sign(claims: Record<string, unknown>, o: { iss: string; aud: string; sub: string; ttl: number }) {
  return new SignJWT(claims).setProtectedHeader({ alg: "HS256" }).setIssuer(o.iss).setAudience(o.aud).setSubject(o.sub).setIssuedAt().setExpirationTime(`${o.ttl}s`).sign(secret());
}

async function issueTokens(agent: Agent & { fp: string }, clientId: string, resource: URL) {
  const base = { iss: resource.origin, aud: resource.href, sub: agent.id };
  const common = { cid: clientId, scope: SCOPE, kh: agent.fp };
  return {
    access_token: await sign({ ...common, tt: "at" }, { ...base, ttl: ACCESS_TTL_S }),
    token_type: "Bearer",
    expires_in: ACCESS_TTL_S,
    refresh_token: await sign({ ...common, tt: "rt" }, { ...base, ttl: REFRESH_TTL_S }),
    scope: SCOPE,
  };
}

async function readJwt(token: string, resource: URL, tt: string) {
  const { payload } = await jwtVerify(token, secret(), { issuer: resource.origin, audience: resource.href });
  if (payload.tt !== tt) throw new Error("wrong token type");
  const agent = await agentById(String(payload.sub));
  if (!agent || agent.fp !== payload.kh) throw new Error("agent key rotated or agent removed");
  return { payload, agent };
}

function verifier(resource: URL): OAuthTokenVerifier {
  return {
    async verifyAccessToken(token: string): Promise<OAuthAuthInfo> {
      if (token.startsWith("agk_")) {
        // an agent API key presented as a bearer token (Claude Code, scripts): same identity, short-lived authInfo
        let agent: Agent;
        try { agent = await agentFromKey(token); } catch { throw invalid("Unknown agent API key."); }
        return { token, clientId: "api-key", scopes: [SCOPE], expiresAt: Math.floor(Date.now() / 1000) + 300, resource, extra: { user: { id: agent.id, handle: agent.handle }, payload: { via: "api_key" }, permissions: [] } };
      }
      try {
        const { payload, agent } = await readJwt(token, resource, "at");
        return { token, clientId: String(payload.cid ?? ""), scopes: String(payload.scope ?? SCOPE).split(" "), expiresAt: payload.exp as number, resource, extra: { user: { id: agent.id, handle: agent.handle }, payload, permissions: [] } };
      } catch {
        throw invalid("Invalid or expired access token. Reconnect the connector.");
      }
    },
  };
}

// ───────── PKCE ─────────
const s256 = (verifierStr: string) => createHash("sha256").update(verifierStr).digest("base64url");

// ───────── the provider ─────────
export const paretoOAuth = oauthCustomProvider<AgentUser, (resource: URL) => OAuthMetadata>({
  scopesSupported: [SCOPE],
  resourceName: "Pareto: agent-to-agent marketplace",
  oauthMetadata: (resource) => ({
    issuer: resource.origin,
    authorization_endpoint: `${resource.origin}${resource.pathname}/oauth/authorize`,
    token_endpoint: `${resource.origin}${resource.pathname}/oauth/token`,
    registration_endpoint: `${resource.origin}${resource.pathname}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [SCOPE],
  } as OAuthMetadata),
  createTokenVerifier: (resource) => verifier(resource),
  mapAuthInfo: (authInfo) => ({
    user: authInfo.extra?.user as AgentUser,
    payload: (authInfo.extra?.payload as Record<string, unknown>) ?? {},
    permissions: [],
  }),
  setup(host) {
    const resource = host.resourceUrl;
    const base = `${host.basePath}/oauth`;
    const preflight = () => new Response(null, { status: 204, headers: CORS });
    host.route("OPTIONS", `${base}/register`, preflight);
    host.route("OPTIONS", `${base}/token`, preflight);

    // RFC 7591 dynamic client registration. Stateless: the client id is the registration.
    host.route("POST", `${base}/register`, async (c: Context) => {
      const body = (await c.req.json().catch(() => ({}))) as { redirect_uris?: unknown; client_name?: unknown };
      const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u): u is string => typeof u === "string") : [];
      if (uris.length === 0 || uris.length > 10 || !uris.every(redirectUriOk)) return oauthError("invalid_redirect_uri", "Provide 1 to 10 valid redirect_uris (https, loopback http, or an app scheme).");
      const name = typeof body.client_name === "string" && body.client_name.trim() ? body.client_name.trim().slice(0, 60) : "an app";
      const client_id = CLIENT_PREFIX + b64(JSON.stringify({ r: uris, n: name }));
      return json({ client_id, client_name: name, redirect_uris: uris, grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none", scope: SCOPE }, 201);
    });

    const params = (src: Record<string, string | undefined>): AuthorizeParams => ({
      client_id: src.client_id ?? "", redirect_uri: src.redirect_uri ?? "", state: src.state ?? "", code_challenge: src.code_challenge ?? "",
      code_challenge_method: src.code_challenge_method ?? "", scope: src.scope ?? SCOPE, resource: src.resource ?? "",
    });
    /** Returns an error message, or the validated client. Errors here are shown on a page, never redirected, because the redirect_uri is not yet trusted. */
    const check = (p: AuthorizeParams): string | ClientInfo => {
      const client = decodeClient(p.client_id);
      if (!client) return "Unknown client. Register the client first.";
      if (!client.redirectUris.includes(p.redirect_uri)) return "The redirect URI does not match the client's registration.";
      if (p.code_challenge_method !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/.test(p.code_challenge)) return "This sign-in needs PKCE (code_challenge_method S256).";
      if (p.resource && p.resource !== resource.href && p.resource !== resource.origin) return "The requested resource is not this server.";
      return client;
    };

    host.route("GET", `${base}/authorize`, (c: Context) => {
      const p = params(c.req.query());
      const r = check(p);
      if (typeof r === "string") return page(errorPage(r), 400);
      return page(authorizePage({ params: p, clientName: r.name, action: `${base}/authorize` }));
    });

    host.route("POST", `${base}/authorize`, async (c: Context) => {
      const form = (await c.req.parseBody()) as Record<string, string | undefined>;
      const p = params(form);
      const r = check(p);
      if (typeof r === "string") return page(errorPage(r), 400);
      const redo = (error: string, handle?: string) => page(authorizePage({ params: p, clientName: r.name, action: `${base}/authorize`, error, handle }), 400);
      const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? c.req.header("x-real-ip") ?? "local";
      if (tooMany(ip)) return redo("Too many attempts. Wait a minute and try again.");

      let agent: (Agent & { fp: string }) | undefined;
      let newKey: string | undefined;
      try {
        if (form.mode === "create") {
          const handle = (form.handle ?? "").trim();
          const roles = [form.role_buyer ? "buyer" : null, form.role_provider ? "provider" : null].filter(Boolean) as string[];
          if (!/^[a-z0-9][a-z0-9_-]{1,38}$/.test(handle)) return redo("Handle: lowercase letters, numbers, - and _, 2 to 39 characters.", handle);
          if (roles.length === 0) return redo("Pick at least one role.", handle);
          if ((form.owner_ref ?? "").trim().length < 2) return redo("Say who owns this agent.", handle);
          newKey = await createAgent({ handle, roles, owner_ref: form.owner_ref!.trim(), description: `Created from the ${r.name} connection` });
          const a = await agentFromKey(newKey);
          agent = await agentById(a.id);
        } else {
          const a = await agentFromKey((form.api_key ?? "").trim());
          agent = await agentById(a.id);
        }
      } catch (e) {
        return redo(e instanceof MarketError && e.code === "handle_taken" ? "That handle is taken. Pick another." : "That key was not recognised. Check it and try again.", form.handle);
      }
      if (!agent) return redo("That agent no longer exists.");

      const code = await sign(
        { tt: "code", cid: p.client_id, ru: p.redirect_uri, cc: p.code_challenge, kh: agent.fp },
        { iss: resource.origin, aud: resource.href, sub: agent.id, ttl: CODE_TTL_S },
      );
      const back = new URL(p.redirect_uri);
      back.searchParams.set("code", code);
      if (p.state) back.searchParams.set("state", p.state);
      if (newKey) return page(newKeyPage({ handle: agent.handle, key: newKey, continueUrl: back.href, clientName: r.name }));
      return c.redirect(back.href, 302);
    });

    host.route("POST", `${base}/token`, async (c: Context) => {
      const f = (await c.req.parseBody()) as Record<string, string | undefined>;
      try {
        if (f.grant_type === "authorization_code") {
          if (!f.code || !f.code_verifier || !f.client_id || !f.redirect_uri) return oauthError("invalid_request", "code, code_verifier, client_id and redirect_uri are required.");
          let read;
          try { read = await readJwt(f.code, resource, "code"); } catch { return oauthError("invalid_grant", "The code is invalid or expired."); }
          const { payload, agent } = read;
          if (payload.cid !== f.client_id || payload.ru !== f.redirect_uri) return oauthError("invalid_grant", "The code was issued to a different client or redirect URI.");
          if (s256(f.code_verifier) !== payload.cc) return oauthError("invalid_grant", "PKCE verification failed.");
          return json(await issueTokens(agent, f.client_id, resource));
        }
        if (f.grant_type === "refresh_token") {
          if (!f.refresh_token) return oauthError("invalid_request", "refresh_token is required.");
          let read;
          try { read = await readJwt(f.refresh_token, resource, "rt"); } catch { return oauthError("invalid_grant", "The refresh token is invalid or expired. Sign in again."); }
          if (f.client_id && read.payload.cid !== f.client_id) return oauthError("invalid_grant", "The refresh token belongs to a different client.");
          return json(await issueTokens(read.agent, String(read.payload.cid), resource));
        }
        return oauthError("unsupported_grant_type", "Use authorization_code or refresh_token.");
      } catch {
        return oauthError("server_error", "Could not complete the request.", 500);
      }
    });
  },
});
