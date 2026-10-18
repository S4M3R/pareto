import type { Card } from "./cards.js";
import { brandName } from "./cards.js";

/** The page a human opens to add or manage cards. Self-contained, matching the add-funds page. Cards are typed on
 * Stripe's own page; this page only starts that and shows what is on file (brand, last four, expiry). */
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function cardPage(o: { token: string; handle: string; cards: Card[]; added?: Card; error?: string; testMode: boolean }): string {
  const row = (c: Card) => `<li class="c" data-id="${esc(c.id)}"><div><b>${esc(brandName(c.brand))} ••••${esc(c.last4)}</b>
<span class="m">expires ${String(c.exp_month ?? "").padStart(2, "0")}/${String(c.exp_year ?? "").slice(-2)}${c.is_default ? ' · <i class="d">default</i>' : ""}</span></div>
<div class="a">${c.is_default ? "" : '<button class="l" data-act="default">Make default</button>'}<button class="l x" data-act="remove">Remove</button></div></li>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cards · Pareto</title>
<style>
:root{color-scheme:light dark;--bg:#f5f4ed;--ink:#17171a;--ink2:#55555d;--ink3:#85858e;--line:rgba(23,23,26,.14);--surf:rgba(23,23,26,.05);--inv:#f4f4f5;--mint:#4aa384;--peri:#7b84e6}
@media(prefers-color-scheme:dark){:root{--bg:#0a0a0c;--ink:#f4f4f5;--ink2:#a1a1aa;--ink3:#6f6f78;--line:rgba(255,255,255,.12);--surf:rgba(255,255,255,.05);--inv:#0a0a0c}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font:14px/1.45 ui-sans-serif,-apple-system,system-ui,sans-serif;-webkit-font-smoothing:antialiased}
body::before{content:"";position:fixed;inset:-20% -10% auto auto;width:520px;height:520px;border-radius:50%;background:radial-gradient(circle at 40% 40%,var(--peri),transparent 68%);opacity:.22;filter:blur(40px);pointer-events:none}
.card{position:relative;width:min(460px,92vw);padding:22px;border-radius:18px;border:1px solid var(--line);background:linear-gradient(180deg,var(--surf),transparent)}
h1{font-size:16px;margin:0 0 2px;letter-spacing:-.01em}.sub{color:var(--ink2);font-size:12.5px;margin:0 0 16px}
.note{padding:11px 13px;border-radius:12px;border:1px solid color-mix(in srgb,#c99a3d 45%,transparent);background:color-mix(in srgb,#c99a3d 9%,transparent);font-size:13px;color:var(--ink2);margin-bottom:14px}
.ok{padding:11px 13px;border-radius:12px;border:1px solid color-mix(in srgb,var(--mint) 50%,transparent);background:color-mix(in srgb,var(--mint) 11%,transparent);font-size:13px;margin-bottom:14px}
ul{list-style:none;margin:0 0 14px;padding:0;display:grid;gap:8px}li.c{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:12px 13px;border-radius:12px;border:1px solid var(--line);background:var(--surf)}
.m{display:block;color:var(--ink3);font-size:12px;margin-top:1px}.d{font-style:normal;color:var(--mint)}.a{display:flex;gap:6px}
button.l{border:1px solid var(--line);background:transparent;color:var(--ink2);border-radius:9px;padding:6px 10px;font:12px inherit;cursor:pointer;min-height:32px}button.l.x:hover{color:#d4896f;border-color:#d4896f}
button.go{width:100%;min-height:48px;border:0;border-radius:12px;background:var(--ink);color:var(--inv);font:600 14px inherit;cursor:pointer}button.go:disabled{opacity:.5;cursor:default}
.empty{color:var(--ink3);font-size:13px;margin:0 0 14px}.fine{color:var(--ink3);font-size:11.5px;margin:12px 0 0}.err{margin-top:12px;color:#d4896f;font-size:13px}code{font:12px ui-monospace,Menlo,monospace;color:var(--ink)}
</style></head><body><main class="card">
<h1>Cards</h1><p class="sub">${esc(o.handle)} · you add the card yourself, on Stripe's page</p>
${o.added ? `<div class="ok"><b>${esc(brandName(o.added.brand))} ••••${esc(o.added.last4)}</b> added. You can close this tab and tell your agent to continue.</div>` : ""}
${o.testMode ? `<div class="note"><b>Test mode.</b> Use card <code>4242 4242 4242 4242</code>, any future expiry, any CVC. No real money moves.</div>` : ""}
${o.cards.length ? `<ul id="cards">${o.cards.map(row).join("")}</ul>` : `<p class="empty">No card on file yet.</p>`}
<button class="go" id="add">Add a card with Stripe</button><div class="err" id="err" role="alert">${o.error ? esc(o.error) : ""}</div>
<p class="fine">Card details are entered on Stripe's own page and never reach Pareto or your agent. We keep only the brand, last four digits and expiry. Your default card pays for wallet top-ups.</p>
</main><script>
const $=id=>document.getElementById(id),post=(p,b)=>fetch(location.pathname.replace(/\\/return$/,"")+p,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(b||{})}).then(async r=>{const j=await r.json();if(!r.ok)throw new Error(j.error||"Something went wrong");return j});
$("add").onclick=async()=>{$("add").disabled=true;$("add").textContent="Opening Stripe…";$("err").textContent="";try{const j=await post("");location.href=j.url}catch(e){$("err").textContent=e.message;$("add").disabled=false;$("add").textContent="Add a card with Stripe"}};
document.querySelectorAll("button[data-act]").forEach(b=>b.onclick=async()=>{const id=b.closest("li").dataset.id;try{await post("/"+b.dataset.act,{id});location.href=location.pathname.replace(/\\/return$/,"")}catch(e){$("err").textContent=e.message}});
</script></body></html>`;
}
