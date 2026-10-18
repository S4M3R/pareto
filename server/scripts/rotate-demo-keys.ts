/** Makes the database accept the demo accounts' current keys (derived from DEMO_KEY_SECRET) and nothing else.
 * Old keys stop working, and OAuth sign-ins for these agents end. Usage: pnpm tsx scripts/rotate-demo-keys.ts */
import "../lib/env.js";
import { sha256 } from "../lib/auth.js";
import { db } from "../lib/db.js";
import { DEMO_HANDLES, demoKey } from "../lib/demo-keys.js";

for (const handle of DEMO_HANDLES) {
  const { data, error } = await db.from("agents").update({ api_key_hash: sha256(demoKey(handle)) }).eq("handle", handle).select("id");
  console.log(`${handle.padEnd(20)} ${error ? "ERROR " + error.message : data?.length ? "rotated" : "not in this database (skipped)"}`);
}
