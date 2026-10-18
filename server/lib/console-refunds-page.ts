/** The provider's console page for refund requests. Self-contained, dark, one column, thumb-sized buttons. The sign-in link carries the session token;
 * it is kept in sessionStorage and removed from the address bar. Polls every 2 seconds so a new request shows up on its own. */
export const refundsPage = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#0a0a0c"><title>Pareto console · Refunds</title>
<style>
:root{color-scheme:dark;--bg:#0a0a0c;--ink:#f4f4f5;--ink2:#a1a1aa;--ink3:#6f6f78;--line:rgba(255,255,255,.1);--surf:rgba(255,255,255,.045);--mint:#6fcaa8;--peri:#8a92e6;--terra:#d4896f;--amber:#c99a3d}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}body{margin:0;min-height:100vh;background:var(--bg);color:var(--ink);font:15px/1.45 ui-sans-serif,-apple-system,system-ui,sans-serif;-webkit-font-smoothing:antialiased;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)}
body::before{content:"";position:fixed;inset:-18% -30% auto auto;width:460px;height:460px;border-radius:50%;background:radial-gradient(circle at 40% 40%,var(--peri),transparent 68%);opacity:.2;filter:blur(46px);pointer-events:none}
body::after{content:"";position:fixed;inset:auto auto -22% -30%;width:420px;height:420px;border-radius:50%;background:radial-gradient(circle at 50% 50%,var(--terra),transparent 68%);opacity:.12;filter:blur(50px);pointer-events:none}
.wrap{position:relative;max-width:520px;margin:0 auto;padding:18px 16px 56px}
nav{display:flex;gap:6px;margin:0 0 20px}nav a{color:var(--ink2);text-decoration:none;padding:8px 14px;border-radius:99px;border:1px solid var(--line);font-size:13px}nav a[aria-current=page]{color:var(--ink);background:var(--surf)}
.brand{display:flex;align-items:center;gap:10px;font-weight:600;letter-spacing:-.01em;margin:0 0 2px}.dot{width:22px;height:22px;border-radius:50%;background:radial-gradient(ellipse at 30% 25%,#cf8a70,transparent 70%),linear-gradient(135deg,#7b84e6,#3b3f8a)}
.sub{color:var(--ink2);font-size:13px;margin:0 0 18px}.sub b{color:var(--ink);font-weight:500}
h2{font:11px ui-monospace,Menlo,monospace;color:var(--ink3);text-transform:uppercase;letter-spacing:.09em;margin:22px 0 10px;font-weight:400}
.card{border:1px solid var(--line);border-radius:18px;background:linear-gradient(180deg,rgba(255,255,255,.06),rgba(255,255,255,.02));overflow:hidden;margin:0 0 14px}
.card.wait{border-color:color-mix(in srgb,var(--amber) 55%,transparent);box-shadow:0 0 0 3px color-mix(in srgb,var(--amber) 12%,transparent)}
.photo{width:100%;aspect-ratio:4/3;object-fit:cover;display:block;background:#15151a}.nophoto{aspect-ratio:4/3;display:grid;place-items:center;color:var(--ink3);background:#15151a;font:12px ui-monospace,Menlo,monospace}
.in{padding:14px 16px 16px}.top{display:flex;justify-content:space-between;align-items:baseline;gap:10px}.ans{font:500 17px ui-monospace,Menlo,monospace;letter-spacing:-.02em}.conf{color:var(--ink3);font:12px ui-monospace,Menlo,monospace}
.amt{font:500 15px ui-monospace,Menlo,monospace;color:var(--ink)}.who{color:var(--ink3);font-size:12.5px;margin:2px 0 10px}
.q{margin:0 0 12px;padding:10px 12px;border-radius:12px;background:var(--surf);border:1px solid var(--line);color:var(--ink);font-size:14px}.q small{display:block;color:var(--ink3);font:11px ui-monospace,Menlo,monospace;margin-bottom:3px;text-transform:uppercase;letter-spacing:.06em}
input.note{width:100%;min-height:46px;border-radius:12px;border:1px solid var(--line);background:rgba(255,255,255,.04);color:var(--ink);padding:0 14px;font:inherit;margin:0 0 10px}input.note::placeholder{color:var(--ink3)}input.note:focus{outline:none;border-color:var(--peri)}
.btns{display:grid;grid-template-columns:1fr 1fr;gap:10px}button{font:600 15px inherit;min-height:52px;border-radius:14px;border:1px solid var(--line);cursor:pointer;color:var(--ink);background:var(--surf)}
button.ok{background:var(--mint);color:#07120d;border-color:transparent}button.no{background:transparent;color:var(--terra);border-color:color-mix(in srgb,var(--terra) 55%,transparent)}button:disabled{opacity:.5}
.pill{font:11px ui-monospace,Menlo,monospace;padding:3px 10px;border-radius:99px;border:1px solid var(--line);color:var(--ink2);white-space:nowrap}.pill.g{color:var(--mint);border-color:color-mix(in srgb,var(--mint) 45%,transparent)}.pill.r{color:var(--terra);border-color:color-mix(in srgb,var(--terra) 45%,transparent)}.pill.a{color:var(--amber);border-color:color-mix(in srgb,var(--amber) 45%,transparent)}
.hist{display:grid;grid-template-columns:56px 1fr auto;gap:12px;align-items:center;padding:10px 12px;border:1px solid var(--line);border-radius:14px;background:var(--surf);margin:0 0 8px}.hist img,.hist .nophoto{width:56px;height:56px;aspect-ratio:1;border-radius:10px;object-fit:cover}
.hist .t{font:13px ui-monospace,Menlo,monospace}.hist .s{color:var(--ink3);font-size:12px;margin-top:2px}.hist .why{color:var(--ink2);font-size:12.5px;margin-top:4px}
.empty{color:var(--ink3);text-align:center;padding:36px 8px;border:1px dashed var(--line);border-radius:18px}.err{border:1px solid color-mix(in srgb,var(--terra) 50%,transparent);background:color-mix(in srgb,var(--terra) 10%,transparent);border-radius:14px;padding:14px;margin:0 0 12px}
.live{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--mint);margin-right:6px;animation:p 1.6s infinite}@keyframes p{50%{opacity:.25}}
</style></head><body><div class="wrap">
<nav><a href="#" aria-current="page">Refund requests</a><a href="#" id="nav-ben">Benchmarks</a></nav>
<div class="brand"><span class="dot"></span>Pareto console</div><p class="sub" id="sub">Loading…</p>
<div id="app"></div></div>
<script>
const q=new URLSearchParams(location.search);let T=q.get("t");if(T){sessionStorage.setItem("pareto_t",T);history.replaceState(null,"",location.pathname)}else T=sessionStorage.getItem("pareto_t");
const $=id=>document.getElementById(id);$("nav-ben").onclick=e=>{e.preventDefault();location.href="/console/benchmarks?t="+encodeURIComponent(T||"")};
const usd=c=>"$"+(c/100).toFixed(2);
const esc=s=>String(s==null?"":s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"})[c]);
const ago=iso=>{const s=Math.max(0,(Date.now()-new Date(iso))/1000);return s<60?"just now":s<3600?Math.floor(s/60)+"m ago":s<86400?Math.floor(s/3600)+"h ago":Math.floor(s/86400)+"d ago"};
const H={authorization:"Bearer "+T}; // GETs must not carry a JSON content-type (the server would try to parse a body)
const LABEL={awaiting_provider:["Waiting for you","a"],refunded:["You approved","g"],rejected:["You rejected","r"],under_review:["Platform reviewing","a"],refunded_on_appeal:["Refunded on appeal","g"],denied_on_appeal:["Appeal denied","r"]};
const photo=r=>{const src=r.image_id?"/images/"+encodeURIComponent(r.image_id)+".jpg":r.image_url;return src?'<img class="photo" src="'+esc(src)+'" alt="">':'<div class="nophoto">no preview</div>'};
const conf=r=>r.answered.confidence==null?"":Math.round(r.answered.confidence*100)+"% sure";
const buyer=r=>esc(r.buyer||"a buyer")+" · call #"+(r.call_seq==null?"?":r.call_seq)+" · "+ago(r.created_at);
let last="",notes={};
function card(r){return '<div class="card wait" data-id="'+r.refund_id+'">'+photo(r)+'<div class="in"><div class="top"><div><div class="ans">'+esc(r.answered.label||"no answer")+'</div><div class="conf">your model answered · '+conf(r)+'</div></div><div class="amt">'+usd(r.amount_cents)+'</div></div><div class="who">'+buyer(r)+'</div>'
 +'<div class="q"><small>Buyer says</small>'+esc(r.claim.reason)+'</div>'
 +(r.appeal?'<div class="q"><small>Appeal</small>'+esc(r.appeal.note||"The buyer appealed.")+'</div>':"")
 +'<input class="note" placeholder="Note to the buyer (optional)" value="'+esc(notes[r.refund_id]||"")+'" data-n="'+r.refund_id+'" maxlength="300">'
 +'<div class="btns"><button class="no" data-d="reject" data-id="'+r.refund_id+'">Reject</button><button class="ok" data-d="approve" data-id="'+r.refund_id+'">Approve refund</button></div></div></div>'}
function row(r){const l=LABEL[r.status]||[r.status,""];const src=r.image_id?"/images/"+encodeURIComponent(r.image_id)+".jpg":r.image_url;
 const why=r.final?r.final.reasoning:(r.provider_decision&&r.provider_decision.note)||"";
 return '<div class="hist">'+(src?'<img src="'+esc(src)+'" alt="">':'<div class="nophoto"></div>')+'<div><div class="t">'+esc(r.answered.label||"no answer")+' · '+usd(r.amount_cents)+'</div><div class="s">'+buyer(r)+'</div>'+(why?'<div class="why">'+esc(why.length>160?why.slice(0,157)+"…":why)+'</div>':"")+'</div><span class="pill '+l[1]+'">'+l[0]+'</span></div>'}
function draw(list){
 const wait=list.filter(r=>r.status==="awaiting_provider"),done=list.filter(r=>r.status!=="awaiting_provider");
 $("app").innerHTML='<h2><span class="live"></span>Needs your decision ('+wait.length+')</h2>'+(wait.length?wait.map(card).join(""):'<div class="empty">No refund requests right now.<br>New ones appear here by themselves.</div>')+(done.length?'<h2>Decided</h2>'+done.slice(0,6).map(row).join(""):"");
 document.querySelectorAll("input.note").forEach(i=>i.oninput=()=>{notes[i.dataset.n]=i.value});
 document.querySelectorAll("button[data-d]").forEach(b=>b.onclick=()=>decide(b));
}
async function decide(b){
 const id=b.dataset.id,box=b.closest(".card");box.querySelectorAll("button").forEach(x=>x.disabled=true);b.textContent=b.dataset.d==="approve"?"Approving…":"Rejecting…";
 try{const r=await fetch("/api/refunds/"+id+"/decision",{method:"POST",headers:{...H,"content-type":"application/json"},body:JSON.stringify({decision:b.dataset.d,note:(notes[id]||"").trim()||undefined})});const j=await r.json();
  if(!r.ok)throw new Error(j.error||"Could not save the decision");delete notes[id]}
 catch(e){alert(e.message)}
 last="";load()}
async function load(){
 if(!T){$("sub").textContent="";$("app").innerHTML='<div class="err">Open this page from your console sign-in link.</div>';return}
 try{
  const [m,l]=await Promise.all([fetch("/api/console/me",{headers:H}),fetch("/api/provider/refunds",{headers:H})]);const me=await m.json(),d=await l.json();
  if(!l.ok||!m.ok){const e=!l.ok?d:me;$("sub").textContent="";$("app").innerHTML='<div class="err">'+esc(e.error||"Could not load")+(e.fix?" "+esc(e.fix):"")+'</div>';return}
  $("sub").innerHTML='Refund requests for <b>'+esc(me.handle)+'</b>';
  const s=JSON.stringify(d.refunds);if(s===last)return;
  // keep what the person is typing: do not redraw while a note field has focus
  if(document.activeElement&&document.activeElement.classList.contains("note")){return}
  last=s;draw(d.refunds)
 }catch(e){console.error(e);$("sub").textContent="Offline. Retrying…"}
}
load();setInterval(load,2000);
</script></body></html>`;
