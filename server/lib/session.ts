import { SignJWT, jwtVerify } from "jose";
import { secret } from "./oauth.js";

/** A short-lived sign-in link for the web console (a provider on a phone, a benchmark owner on a laptop). It carries an
 * agent id and nothing else; the console pages send it back as a bearer token and the REST API treats it like that
 * agent's key. Same signing secret as OAuth, so it works on any instance. */
export async function createSessionToken(agentId: string, hours = 12): Promise<string> {
  return new SignJWT({ tt: "session" }).setProtectedHeader({ alg: "HS256" }).setSubject(agentId).setIssuedAt().setExpirationTime(`${hours}h`).sign(secret());
}

/** The agent id inside a valid session token, or undefined. */
export async function verifySessionToken(token: string): Promise<string | undefined> {
  try {
    const { payload } = await jwtVerify(token, secret());
    return payload.tt === "session" && typeof payload.sub === "string" ? payload.sub : undefined;
  } catch {
    return undefined;
  }
}
