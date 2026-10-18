import { BASE_URL } from "./env.js";
import { MarketError } from "./errors.js";

const PRIVATE_V4 = [/^10\./, /^127\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^0\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./];

function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || h === "metadata.google.internal") return true;
  if (PRIVATE_V4.some((r) => r.test(h))) return true;
  return h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80");
}

/** The platform calls provider endpoints (the gateway, the benchmark runner) and downloads benchmark images, so a
 * registered URL is a request the platform makes on someone's behalf. Only public https hosts are allowed, plus this
 * server's own origin (platform-operated demo services live here). Hostnames are checked, not resolved, so this stops
 * the obvious abuse but is not a substitute for network egress rules in production. */
export function assertPublicUrl(raw: string, what = "endpoint_url"): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw new MarketError("bad_input", `${what} is not a valid URL.`, "Send a full https URL."); }
  if (u.username || u.password) throw new MarketError("bad_input", `${what} must not contain credentials.`, "Remove the user:password@ part.");
  try { if (u.origin === new URL(BASE_URL).origin) return u; } catch { /* BASE_URL unset: fall through */ }
  if (u.protocol !== "https:") throw new MarketError("bad_input", `${what} must use https.`, "Serve the endpoint over https.");
  if (isPrivateHost(u.hostname)) throw new MarketError("bad_input", `${what} points at a private or local address.`, "Use a publicly reachable https host.");
  return u;
}
