/** Prints the demo accounts' API keys. Usage: pnpm tsx scripts/demo-keys.ts [handle]
 * With a handle it prints only that key (for shell substitution): KEY=$(pnpm -s tsx scripts/demo-keys.ts demo-buyer) */
import { DEMO_HANDLES, demoKey } from "../lib/demo-keys.js";
const only = process.argv[2];
if (only) {
  console.log(demoKey(only));
} else {
  console.log(process.env.DEMO_KEY_SECRET ? "Keys derived from DEMO_KEY_SECRET:\n" : "DEMO_KEY_SECRET is not set: these are the fixed local-only keys.\n");
  for (const h of DEMO_HANDLES) console.log(`  ${h.padEnd(20)} ${demoKey(h)}`);
}
