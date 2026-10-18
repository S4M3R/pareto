/** The standalone page a human opens to approve a top-up. Self-contained (no build step, no external assets). */
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const usd = (c: number) => `$${(c / 100).toFixed(2)}`;

export function topupPage(o: { token: string; handle: string; walletCents: number; neededCents: number | null; reason: string | null; presets: number[]; suggested: number; max: number; rail: string; doneCents?: number }): string {
  const short = o.neededCents && o.neededCents > o.walletCents ? o.neededCents - o.walletCents : 0;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Add funds · Pareto</title>
<style>
:root{color-scheme:light dark;--bg:#f5f4ed;--ink:#17171a;--ink2:#55555d;--ink3:#85858e;--line:rgba(23,23,26,.14);--surf:rgba(23,23,26,.05);--inv:#f4f4f5;--mint:#4aa384;--peri:#7b84e6}
@media(prefers-color-scheme:dark){:root{--bg:#0a0a0c;--ink:#f4f4f5;--ink2:#a1a1aa;--ink3:#6f6f78;--line:rgba(255,255,255,.12);--surf:rgba(255,255,255,.05);--inv:#0a0a0c}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font:14px/1.45 ui-sans-serif,-apple-system,system-ui,sans-serif;-webkit-font-smoothing:antialiased}
body::before{content:"";position:fixed;inset:-20% -10% auto auto;width:520px;height:520px;border-radius:50%;background:radial-gradient(circle at 40% 40%,var(--peri),transparent 68%);opacity:.22;filter:blur(40px);pointer-events:none}
.card{position:relative;width:min(440px,92vw);padding:22px;border-radius:18px;border:1px solid var(--line);background:linear-gradient(180deg,var(--surf),transparent)}
h1{font-size:16px;margin:0 0 2px;letter-spacing:-.01em}.sub{color:var(--ink2);font-size:12.5px;margin:0 0 16px}.note{padding:11px 13px;border-radius:12px;border:1px solid color-mix(in srgb,#c99a3d 45%,transparent);background:color-mix(in srgb,#c99a3d 9%,transparent);font-size:13px;color:var(--ink2);margin-bottom:14px}
.bal{display:flex;justify-content:space-between;align-items:flex-end;padding-bottom:14px;margin-bottom:14px;border-bottom:1px solid var(--line)}.lbl{font-size:12px;color:var(--ink3)}.big{font:500 32px ui-monospace,Menlo,monospace;letter-spacing:-.03em}.delta{font:12px ui-monospace,Menlo,monospace;color:var(--mint)}
.presets{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}button.p{font:500 14px ui-monospace,Menlo,monospace;min-height:46px;border-radius:12px;border:1px solid var(--line);background:var(--surf);color:var(--ink2);cursor:pointer}button.p[aria-pressed=true]{color:var(--ink);border-color:var(--peri);box-shadow:0 0 0 3px color-mix(in srgb,var(--peri) 22%,transparent)}
.row{display:flex;justify-content:space-between;color:var(--ink2);font-size:13px;margin-top:10px}.row b{font:400 13px ui-monospace,Menlo,monospace;color:var(--ink)}
button.go{width:100%;min-height:48px;margin-top:18px;border:0;border-radius:12px;background:var(--ink);color:var(--inv);font:600 14px inherit;cursor:pointer}button.go:disabled{opacity:.5;cursor:default}
.fine{color:var(--ink3);font-size:11.5px;margin:12px 0 0}.ok{text-align:center;padding:8px 0}.ok h1{font-size:20px}.err{margin-top:12px;color:#d4896f;font-size:13px}
</style></head><body><main class="card" id="app">
${o.doneCents !== undefined ? `<div class="ok"><h1>${usd(o.doneCents)} added</h1><p class="sub">Balance <b>${usd(o.walletCents)}</b>. Close this tab and tell your agent to continue, or add more.</p>
<button class="go" id="more">Add more money</button></div>` : `
<h1>Add funds to wallet</h1><p class="sub">${esc(o.handle)} · approve this yourself (test mode, no real money)</p>
${short || o.reason ? `<div class="note">${short ? `<b>${usd(o.neededCents!)}</b> is needed and the wallet has <b>${usd(o.walletCents)}</b>. ` : ""}${o.reason ? esc(o.reason) : ""}</div>` : ""}
<div class="bal"><div><div class="lbl">Wallet balance</div><div class="big" id="bal">${usd(o.walletCents)}</div></div><span class="delta" id="delta"></span></div>
<div class="presets" id="presets">${o.presets.map((p) => `<button class="p" data-c="${p}" aria-pressed="${p === o.suggested}">${usd(p).replace(/\.00$/, "")}</button>`).join("")}</div>
<div class="row"><span>${o.rail === "stripe-test" ? "Stripe test card · Visa 4242" : "Mock rail (no Stripe key set)"}</span><b>${o.rail === "stripe-test" ? "Stripe" : "mock"}</b></div>
<div class="row"><span>New balance</span><b id="newbal"></b></div>
<button class="go" id="go"></button><div class="err" id="err" role="alert"></div>
<p class="fine">Held in your Pareto ledger. It moves to escrow only when you fund an agreement, within the cap your spending policy allows.</p>`}
</main>
${o.doneCents !== undefined ? `<script>document.getElementById("more").onclick=()=>{location.search="?more=1"}</script>` : `<script>
const W=${o.walletCents},MAX=${o.max};const more=()=>{location.search="?more=1"};let amt=${o.suggested};const $=id=>document.getElementById(id),usd=c=>"$"+(c/100).toFixed(2);
function draw(){$("go").textContent="Add "+usd(amt);$("delta").textContent="+ "+usd(amt);$("newbal").textContent=usd(W+amt);document.querySelectorAll("#presets button").forEach(b=>b.setAttribute("aria-pressed",String(+b.dataset.c===amt)))}
document.querySelectorAll("#presets button").forEach(b=>b.onclick=()=>{amt=+b.dataset.c;draw()});draw();
$("go").onclick=async()=>{$("go").disabled=true;$("go").textContent="Adding…";$("err").textContent="";
 try{const r=await fetch(location.pathname,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({amount_cents:amt})});const j=await r.json();
  if(!r.ok){if(j.card_url){$("err").innerHTML=(j.error||"Add a card first.")+' <a href="'+j.card_url+'" target="_blank" rel="noopener" style="color:inherit;font-weight:700">Add a card</a>, then come back and try again.';$("go").disabled=false;draw();return}throw new Error(j.error||"Could not add funds")}
  $("app").innerHTML='<div class="ok"><h1>'+usd(amt)+' added</h1><p class="sub">Balance <b>'+usd(j.wallet_cents)+'</b>. Close this tab and tell your agent to continue, or add more.</p><button class="go" id="more">Add more money</button></div>';$("more").onclick=more}
 catch(e){$("err").textContent=e.message;$("go").disabled=false;draw()}};
</script>`}
</body></html>`;
}

export const expiredPage = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Link expired</title><body style="font:15px ui-sans-serif,system-ui;display:grid;place-items:center;min-height:100vh;margin:0"><p>This approval link has expired. Ask your agent to open a new one.</p></body>`;
