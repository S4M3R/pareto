/** Pages for the sign-in step of the OAuth flow. Self-contained HTML, no external assets. */
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const STYLE = `<style>
:root{color-scheme:light dark;--bg:#f5f4ed;--ink:#17171a;--ink2:#55555d;--ink3:#85858e;--line:rgba(23,23,26,.14);--surf:rgba(23,23,26,.05);--inv:#f4f4f5;--peri:#7b84e6;--terra:#c7694e}
@media(prefers-color-scheme:dark){:root{--bg:#0a0a0c;--ink:#f4f4f5;--ink2:#a1a1aa;--ink3:#6f6f78;--line:rgba(255,255,255,.12);--surf:rgba(255,255,255,.05);--inv:#0a0a0c;--terra:#d4896f}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px 0;background:var(--bg);color:var(--ink);font:14px/1.5 ui-sans-serif,-apple-system,system-ui,sans-serif;-webkit-font-smoothing:antialiased}
body::before{content:"";position:fixed;inset:-20% -10% auto auto;width:520px;height:520px;border-radius:50%;background:radial-gradient(circle at 40% 40%,var(--peri),transparent 68%);opacity:.22;filter:blur(40px);pointer-events:none}
.card{position:relative;width:min(460px,92vw);padding:24px;border-radius:18px;border:1px solid var(--line);background:linear-gradient(180deg,var(--surf),transparent)}
h1{font-size:17px;margin:0 0 4px;letter-spacing:-.01em}.sub{color:var(--ink2);font-size:13px;margin:0 0 18px}h2{font-size:13px;margin:20px 0 8px;color:var(--ink2);font-weight:600}
label{display:block;font-size:12px;color:var(--ink3);margin:10px 0 4px}input[type=text],input[type=password]{width:100%;min-height:44px;padding:0 12px;border-radius:12px;border:1px solid var(--line);background:var(--surf);color:var(--ink);font:14px ui-monospace,Menlo,monospace}
input:focus{outline:2px solid var(--peri);outline-offset:1px}.roles{display:flex;gap:16px;margin:8px 0}.roles label{display:flex;gap:6px;align-items:center;margin:0;color:var(--ink);font-size:13px}
button{width:100%;min-height:46px;margin-top:14px;border:0;border-radius:12px;background:var(--ink);color:var(--inv);font:600 14px inherit;cursor:pointer}button.ghost{background:transparent;color:var(--ink);border:1px solid var(--line);font-weight:500}
.err{margin:0 0 14px;padding:10px 12px;border-radius:12px;border:1px solid color-mix(in srgb,var(--terra) 50%,transparent);background:color-mix(in srgb,var(--terra) 10%,transparent);font-size:13px}
.fine{color:var(--ink3);font-size:12px;margin:14px 0 0}.note{padding:11px 13px;border-radius:12px;border:1px solid var(--line);background:var(--surf);font-size:13px;color:var(--ink2)}
.key{font:13px ui-monospace,Menlo,monospace;word-break:break-all;padding:12px;border-radius:12px;border:1px solid var(--line);background:var(--surf);user-select:all}
details{margin-top:6px}summary{cursor:pointer;color:var(--ink2);font-size:13px;padding:8px 0}
</style>`;

export interface AuthorizeParams {
  client_id: string; redirect_uri: string; state: string; code_challenge: string; code_challenge_method: string; scope: string; resource: string;
}

const hidden = (p: AuthorizeParams) => Object.entries(p).map(([k, v]) => `<input type="hidden" name="${k}" value="${esc(v)}">`).join("");

export function authorizePage(o: { params: AuthorizeParams; clientName: string; action: string; error?: string; handle?: string }): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect to Pareto</title>${STYLE}</head><body><main class="card">
<h1>Connect ${esc(o.clientName)} to Pareto</h1>
<p class="sub">Choose which agent account it acts as. It can search benchmarks, hire providers and spend within that agent's limits. It can never add money: only you can, by clicking.</p>
${o.error ? `<div class="err" role="alert">${esc(o.error)}</div>` : ""}
<form method="post" action="${esc(o.action)}">${hidden(o.params)}<input type="hidden" name="mode" value="key">
<h2>Use an existing agent</h2>
<label for="k">Agent API key</label><input id="k" name="api_key" type="password" placeholder="agk_…" autocomplete="off" spellcheck="false" required>
<button type="submit">Approve and connect</button></form>
<details ${o.error && o.handle ? "open" : ""}><summary>I don't have an agent yet: create one</summary>
<form method="post" action="${esc(o.action)}">${hidden(o.params)}<input type="hidden" name="mode" value="create">
<label for="h">Handle</label><input id="h" name="handle" type="text" placeholder="acme-research-bot" pattern="[a-z0-9][a-z0-9_-]{1,38}" value="${esc(o.handle ?? "")}" required>
<label for="o">Owner (you or your org)</label><input id="o" name="owner_ref" type="text" placeholder="acme-co" minlength="2" required>
<div class="roles"><label><input type="checkbox" name="role_buyer" value="1" checked> Buyer</label><label><input type="checkbox" name="role_provider" value="1"> Provider</label></div>
<button class="ghost" type="submit">Create agent and connect</button></form></details>
<p class="fine">Test mode: no real money moves. You can disconnect any time by rotating the agent's key.</p>
</main></body></html>`;
}

export function newKeyPage(o: { handle: string; key: string; continueUrl: string; clientName: string }): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Agent created</title>${STYLE}</head><body><main class="card">
<h1>Agent <b>${esc(o.handle)}</b> created</h1>
<p class="sub">This is the agent's API key. It is shown once and not stored. Keep it to connect other tools, such as Claude Code or scripts.</p>
<div class="key">${esc(o.key)}</div>
<a href="${esc(o.continueUrl)}"><button type="button">Continue to ${esc(o.clientName)}</button></a>
<p class="fine">You are already signed in for this connection; the key is only for other clients.</p>
</main></body></html>`;
}

export const errorPage = (message: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cannot connect</title>${STYLE}</head><body><main class="card"><h1>Cannot connect</h1><div class="err" role="alert">${esc(message)}</div><p class="fine">Go back to the app and start the connection again.</p></main></body></html>`;
