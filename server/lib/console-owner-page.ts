/** The benchmark owner's console: usage and referral income. Self-contained; the sign-in link carries the session token. */
export const ownerPage = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>Pareto console · Benchmarks</title>
<style>
:root{color-scheme:dark;--bg:#0a0a0c;--ink:#f4f4f5;--ink2:#a1a1aa;--ink3:#6f6f78;--line:rgba(255,255,255,.1);--surf:rgba(255,255,255,.045);--mint:#6fcaa8;--peri:#8a92e6;--amber:#c99a3d}
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:var(--bg);color:var(--ink);font:14px/1.45 ui-sans-serif,-apple-system,system-ui,sans-serif;-webkit-font-smoothing:antialiased;padding:env(safe-area-inset-top) 0 env(safe-area-inset-bottom)}
body::before{content:"";position:fixed;inset:-25% -15% auto auto;width:640px;height:640px;border-radius:50%;background:radial-gradient(circle at 40% 40%,var(--peri),transparent 68%);opacity:.18;filter:blur(50px);pointer-events:none}
.wrap{position:relative;max-width:880px;margin:0 auto;padding:22px 18px 60px}
nav{display:flex;gap:6px;margin:0 0 22px}nav a{color:var(--ink2);text-decoration:none;padding:8px 14px;border-radius:99px;border:1px solid var(--line);font-size:13px}nav a[aria-current=page]{color:var(--ink);background:var(--surf)}
.brand{display:flex;align-items:center;gap:10px;font-weight:600;letter-spacing:-.01em;margin:0 0 4px}.dot{width:22px;height:22px;border-radius:50%;background:radial-gradient(ellipse at 30% 25%,#cf8a70,transparent 70%),linear-gradient(150deg,#a1a7ee,#8087de)}
.sub{color:var(--ink2);margin:0 0 22px}.hero{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin:0 0 26px}
.stat{border:1px solid var(--line);border-radius:16px;background:linear-gradient(180deg,rgba(255,255,255,.06),rgba(255,255,255,.02));padding:16px 18px}.lbl{font:11px ui-monospace,Menlo,monospace;color:var(--ink3);text-transform:uppercase;letter-spacing:.08em}.big{font:500 40px/1.1 ui-monospace,Menlo,monospace;letter-spacing:-.03em;margin:6px 0 0}.big.mint{color:var(--mint)}.small{font:500 26px ui-monospace,Menlo,monospace;margin:6px 0 0}
.card{border:1px solid var(--line);border-radius:16px;background:linear-gradient(180deg,rgba(255,255,255,.05),rgba(255,255,255,.015));padding:18px;margin:0 0 14px}
.card h2{font-size:16px;margin:0 0 2px;letter-spacing:-.01em}.card .meta{color:var(--ink3);font:12px ui-monospace,Menlo,monospace;margin:0 0 14px}
.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:0 0 14px}.kpi .n{font:500 22px ui-monospace,Menlo,monospace}.kpi .n.mint{color:var(--mint)}
.row{display:flex;justify-content:space-between;gap:12px;padding:9px 0;border-top:1px solid var(--line);font-size:13px;color:var(--ink2)}.row b{font:400 13px ui-monospace,Menlo,monospace;color:var(--ink)}.row .p{color:var(--mint)}
.pill{font:11px ui-monospace,Menlo,monospace;padding:3px 9px;border-radius:99px;border:1px solid var(--line);color:var(--ink2)}.empty{color:var(--ink3);padding:30px 0;text-align:center}
.err{border:1px solid rgba(212,137,111,.5);background:rgba(212,137,111,.1);border-radius:12px;padding:14px;color:var(--ink)}
@media(max-width:560px){.kpis{grid-template-columns:repeat(2,1fr)}.big{font-size:34px}}
</style></head><body><div class="wrap">
<nav><a href="#" id="nav-ben" aria-current="page">Benchmarks</a><a href="#" id="nav-ref">Refund requests</a></nav>
<div class="brand"><span class="dot"></span>Pareto console</div><p class="sub" id="sub">Loading…</p>
<div id="app"></div></div>
<script>
const q=new URLSearchParams(location.search);let T=q.get("t");if(T){sessionStorage.setItem("pareto_t",T);history.replaceState(null,"",location.pathname)}else T=sessionStorage.getItem("pareto_t");
const $=id=>document.getElementById(id),usd=c=>"$"+(c/100).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2});
$("nav-ref").onclick=e=>{e.preventDefault();location.href="/console/refunds?t="+encodeURIComponent(T||"")};
const ago=iso=>{const s=Math.max(0,(Date.now()-new Date(iso))/1000);return s<60?"just now":s<3600?Math.floor(s/60)+"m ago":s<86400?Math.floor(s/3600)+"h ago":Math.floor(s/86400)+"d ago"};
const esc=s=>String(s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"})[c]);
async function load(){
 if(!T){$("sub").textContent="";$("app").innerHTML='<div class="err">Open this page from your console sign-in link.</div>';return}
 const r=await fetch("/api/owner/benchmarks",{headers:{authorization:"Bearer "+T}});const d=await r.json();
 if(!r.ok){$("sub").textContent="";$("app").innerHTML='<div class="err">'+esc(d.error||"Could not load")+(d.fix?" "+esc(d.fix):"")+'</div>';return}
 $("sub").textContent=d.owner+" · you earn "+d.referral_pct+"% of what agents spend on hires made through your benchmarks";
 const hires=d.benchmarks.reduce((s,b)=>s+b.hires,0),agents=new Set(d.benchmarks.flatMap(b=>b.recent.map(x=>x.agent))).size;
 $("app").innerHTML='<div class="hero"><div class="stat"><div class="lbl">Referral earnings</div><div class="big mint">'+usd(d.earned_total_cents)+'</div></div><div class="stat"><div class="lbl">Hires through your benchmarks</div><div class="small">'+hires+'</div></div><div class="stat"><div class="lbl">Wallet earnings</div><div class="small">'+usd(d.earnings_balance_cents)+'</div></div></div>'+
 (d.benchmarks.length?d.benchmarks.map(b=>'<div class="card"><h2>'+esc(b.title)+'</h2><div class="meta">'+esc(b.slug)+' · '+b.n_test+' hidden test items · published '+ago(b.created_at)+'</div><div class="kpis"><div class="kpi"><div class="lbl">Agents</div><div class="n">'+b.agents+'</div></div><div class="kpi"><div class="lbl">Hires</div><div class="n">'+b.hires+'</div></div><div class="kpi"><div class="lbl">Spend</div><div class="n">'+usd(b.spend_cents)+'</div></div><div class="kpi"><div class="lbl">Earned</div><div class="n mint">'+usd(b.earned_cents)+'</div></div></div>'+
  (b.recent.length?b.recent.map(x=>'<div class="row"><span>'+esc(x.agent)+' hired a provider · '+ago(x.at)+' <span class="pill">'+esc(x.status)+'</span></span><b>'+usd(x.spend_cents)+(x.referral_cents?' <span class="p">+'+usd(x.referral_cents)+'</span>':'')+'</b></div>').join(""):'<div class="empty">No hires yet. Agents that choose a provider with this benchmark will show up here.</div>')+'</div>').join(""):'<div class="empty">You have not published a benchmark yet.</div>');
}
load();setInterval(load,6000);
</script></body></html>`;
