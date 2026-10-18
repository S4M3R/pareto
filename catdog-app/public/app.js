// CatDog UI. Polls the app's own server (which holds the Pareto key); never talks to Pareto's API from the browser.
const $ = (id) => document.getElementById(id);
const FINAL = new Set(["refunded", "refunded_on_appeal", "denied_on_appeal"]);
const money = (c) => `$${(c / 100).toFixed(2)}`;
const cents = (c) => (c < 100 ? `${c}¢` : money(c));
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

let state = null;
let selected = null; // image id
let drawerSig = "";
let refundDetail = null; // the open photo's refund, fetched from Pareto
let busy = false;
const tiles = new Map();

async function api(method, path, body) {
  const res = await fetch(path, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error ? `${j.error}${j.fix ? ` ${j.fix}` : ""}` : `HTTP ${res.status}`);
  return j;
}

// ───────── polling ─────────
async function tick() {
  try {
    state = await api("GET", "/api/state");
    render();
  } catch (e) {
    $("error").hidden = false;
    $("error").textContent = `The app lost its server: ${e.message}`;
  }
  const hot = state?.run.running || (state?.tiles ?? []).some((t) => t.refund && !FINAL.has(t.refund.status));
  setTimeout(tick, hot || selected ? 900 : 2200);
}

async function pollRefund() {
  const t = selected && state?.tiles.find((x) => x.id === selected);
  if (t?.refund) {
    try { refundDetail = await api("GET", `/api/refunds/${t.refund.refund_id}`); renderDrawer(); } catch { /* the next tick tries again */ }
  }
  setTimeout(pollRefund, 1200);
}

// ───────── render ─────────
function render() {
  const s = state;
  $("error").hidden = !s.error;
  $("error").textContent = s.error ? `Pareto: ${s.error}` : "";

  const deal = s.deal;
  $("empty").hidden = Boolean(deal);
  $("grid").hidden = false; // the photos are always shown; without a classifier they are grey and the message sits over them
  $("grid").classList.toggle("idle", !deal);
  $("toolbar").hidden = !deal;
  $("meter").hidden = !deal;
  $("sub").textContent = deal ? `Classifying with ${deal.provider}` : "Is it a cat or a dog?";


  if (deal) {
    $("deal").innerHTML = `<span class="dot"></span><span><b>${esc(deal.provider)}</b> &middot; ${cents(deal.price_cents_per_call)} per call &middot; cap ${money(deal.cap_cents)}</span>`;
    const sp = deal.spend ?? { calls: 0, charged_cents: 0, refunded_cents: 0 };
    const net = sp.charged_cents - sp.refunded_cents;
    $("spent").textContent = money(net);
    $("of").textContent = `of ${money(deal.cap_cents)}`;
    const pct = (v) => `${Math.min(100, (v / Math.max(deal.cap_cents, 1)) * 100)}%`;
    $("bar-charged").style.width = pct(sp.charged_cents);
    $("bar-refunded").style.width = pct(sp.refunded_cents);
    $("meter-calls").textContent = `${sp.calls} calls`;
    $("meter-refunded").textContent = sp.refunded_cents ? `${money(sp.refunded_cents)} refunded` : "";
    renderRun();
    renderGrid();
    fitGrid();
    renderOutcome();
  } else {
    $("outcome").hidden = true;
    renderGrid();
    fitGrid();
  }
  if (selected) renderDrawer();
}

function renderRun() {
  const r = state.run;
  const done = state.tiles.filter((t) => t.label).length;
  const btn = $("run");
  $("progress-wrap").hidden = !r.running;
  $("progress").style.width = `${(r.done / r.total) * 100}%`;
  $("progress-text").textContent = r.running ? `${r.done} / ${r.total}` : r.message || (done && done < r.total ? `${done} / ${r.total} done` : "");
  btn.disabled = r.running || done === r.total;
  btn.textContent = r.running ? "Classifying..." : done === r.total ? "100 classified" : done ? "Run the rest" : "Run 100 images";
}

/** "a refund for 24 hours" / "a refund for 15 min": how long a call can be asked back for. */
function windowText(sec) {
  if (!sec) return "a refund";
  const t = sec < 60 ? `${sec} seconds` : sec < 3600 ? `${Math.round(sec / 60)} minutes` : sec % 3600 === 0 ? `${sec / 3600} hours` : `${(sec / 3600).toFixed(1)} hours`;
  return `a refund for ${t}`;
}
/** 86400000 ms -> "24h 00m"; under an hour "14m 05s"; under a minute "45s". */
function left(ms) {
  const s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const two = (n) => String(n).padStart(2, "0");
  return h ? `${h}h ${two(m)}m` : m ? `${m}m ${two(r)}s` : `${r}s`;
}
/** How long this photo's call can still be asked back for. Ticks every second while the refund form is open. */
function updateWindowNote() {
  const el = $("window-note");
  if (!el) return;
  const t = state?.tiles.find((x) => x.id === selected);
  const w = state?.deal?.check_window_s;
  if (!t?.created_at || !w) { el.hidden = true; return; }
  const remaining = new Date(t.created_at).getTime() + w * 1000 - Date.now();
  el.hidden = false;
  el.classList.toggle("closed", remaining <= 0);
  el.innerHTML = remaining <= 0 ? "The refund window for this call has closed." : `<span class="clock">\u23F1</span> <b>${left(remaining)}</b> left to ask for a refund on this call`;
}
setInterval(updateWindowNote, 1000);
const autoRefunded = (t) => !t.refund && (t.charge_state === "refunded" || t.charge_state === "partially_refunded");
function tileLabel(t) { return t.label === "cat" ? "Cat!" : t.label === "dog" ? "Dog!" : t.label; }

function renderGrid() {
  const grid = $("grid");
  for (const t of state.tiles) {
    let el = tiles.get(t.id);
    if (!el) {
      el = document.createElement("button");
      el.className = "tile";
      el.innerHTML = `<img alt="" loading="lazy"><span class="lab"><span></span><span></span></span><span class="flag" hidden>!</span>`;
      el.querySelector("img").src = `${state.paretoUrl}/images/${t.id}.jpg`;
      el.onclick = () => openDrawer(t.id);
      grid.appendChild(el);
      tiles.set(t.id, el);
    }
    const done = Boolean(t.label);
    el.classList.toggle("done", done);
    el.classList.toggle("cat", t.label === "cat");
    el.classList.toggle("dog", done && t.label !== "cat");
    el.classList.toggle("err", Boolean(t.error));
    const [l, p] = el.querySelectorAll(".lab span");
    l.textContent = done ? tileLabel(t) : "";
    p.textContent = done && t.confidence != null ? `${Math.round(t.confidence * 100)}%` : "";
    const rs = t.refund?.status ?? (autoRefunded(t) ? "refunded" : undefined);
    if (rs) el.dataset.rs = rs; else delete el.dataset.rs;
    const flag = el.querySelector(".flag");
    flag.hidden = !rs;
    flag.textContent = rs === "refunded" || rs === "refunded_on_appeal" ? "✓" : rs === "denied_on_appeal" ? "×" : "!";
    el.title = t.error || (autoRefunded(t) ? "Refunded automatically: Pareto's check caught this answer." : "");
  }
}

function renderOutcome() {
  const reqs = state.tiles.filter((t) => t.refund);
  $("outcome").hidden = reqs.length === 0;
  if (!reqs.length) return;
  const n = (...ss) => reqs.filter((t) => ss.includes(t.refund.status)).length;
  const bits = [];
  if (n("refunded", "refunded_on_appeal")) bits.push(`<b>${n("refunded", "refunded_on_appeal")} refunded</b>`);
  if (n("denied_on_appeal")) bits.push(`<b>${n("denied_on_appeal")} denied on appeal</b>, final`);
  if (n("rejected")) bits.push(`<b>${n("rejected")} rejected</b> by the provider, you can appeal`);
  if (n("awaiting_provider")) bits.push(`<b>${n("awaiting_provider")} waiting</b> for ${esc(state.deal.provider)}`);
  if (n("under_review")) bits.push(`<b>${n("under_review")} under review</b> by Pareto`);
  $("outcome").innerHTML = `Refund requests: ${bits.join(" &middot; ")}.`;
}

// Size the tiles so all 100 fit the window without scrolling: the columns that give the biggest square tiles.
function fitGrid() {
  const g = $("grid");
  if (g.hidden) return;
  const W = g.clientWidth - 4, H = g.clientHeight - 4, gap = 6, n = state?.tiles.length || 100;
  let best = { size: 0, cols: 10 };
  for (let cols = 4; cols <= 25; cols++) {
    const rows = Math.ceil(n / cols);
    const size = Math.floor(Math.min((W - gap * (cols - 1)) / cols, (H - gap * (rows - 1)) / rows));
    if (size > best.size) best = { size, cols };
  }
  g.style.gridTemplateColumns = `repeat(${best.cols}, ${best.size}px)`;
  g.style.gap = `${gap}px`;
  g.classList.toggle("tiny", best.size < 76);
}
addEventListener("resize", fitGrid);

// ───────── drawer ─────────
function openDrawer(id) {
  if (!state?.deal) return; // nothing to ask a refund on before a classifier is installed
  selected = id;
  refundDetail = null;
  drawerSig = "";
  $("drawer").classList.add("open");
  $("drawer").setAttribute("aria-hidden", "false");
  $("d-img").src = `${state.paretoUrl}/images/${id}.jpg`;
  $("d-id").textContent = id;
  renderDrawer();
}
function closeDrawer() { selected = null; $("drawer").classList.remove("open"); $("drawer").setAttribute("aria-hidden", "true"); }
$("close").onclick = closeDrawer;
addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });

const STATUS = {
  awaiting_provider: (r, p) => ["Waiting for " + p, "Your request is with the provider. The charge is held until they decide."],
  refunded: () => ["Refunded", "The provider agreed. The money is back in your escrow."],
  rejected: () => ["Rejected by the provider", "You can appeal. Pareto will check the recorded call against the reference answer."],
  under_review: () => ["Pareto is reviewing", "The platform is checking the recorded call. This takes a moment."],
  refunded_on_appeal: () => ["Refunded on appeal", "Pareto upheld your appeal."],
  denied_on_appeal: () => ["Appeal denied", "Pareto reviewed the call. This decision is final."],
};

function renderDrawer() {
  const t = state?.tiles.find((x) => x.id === selected);
  if (!t) return;
  const chip = $("d-chip");
  chip.textContent = t.label && t.confidence != null ? `${Math.round(t.confidence * 100)}% sure` : "";
  $("d-shot").dataset.v = t.label === "cat" ? "cat" : t.label ? "dog" : "none";
  $("d-verdict").textContent = t.label ? tileLabel(t) : "Not classified yet";
  const status = t.refund?.status ?? null;
  const d = refundDetail && refundDetail.refund_id === t.refund?.refund_id ? refundDetail : null;
  const sig = [t.id, status, Boolean(d), busy, Boolean(t.label), t.charge_state].join("|");
  if (sig === drawerSig) return; // do not rebuild while someone is typing
  drawerSig = sig;
  const box = $("d-content");

  if (!t.label) { box.innerHTML = `<div class="stat"><p>This photo has not been classified yet.</p></div>`; return; }
  if (!status && autoRefunded(t)) {
    box.innerHTML = `<div class="stat" data-s="refunded"><div class="head"><span class="dot"></span>Refunded automatically</div><p>Pareto's own check caught this answer and returned the ${cents(state.deal.price_cents_per_call)} from escrow. Nothing to request.</p></div>`;
    return;
  }
  if (!status && t.charge_state !== "pending") {
    box.innerHTML = `<div class="stat"><div class="head">Outside the refund window</div><p>This charge was already paid out to the provider. Refunds can be requested while a charge is still inside its check window.</p></div>`;
    return;
  }
  if (!status) {
    box.innerHTML = `<div class="window-note" id="window-note" hidden></div>
      <div class="field"><label class="k" for="reason">Why is this wrong?</label>
      <textarea id="reason" placeholder="e.g. This is a cat, the model said it is a dog."></textarea></div>
      <div class="actions"><button class="btn primary" id="ask" ${busy ? "disabled" : ""}>${busy ? "Sending..." : "Request refund"}</button></div>
      <div class="msg" id="msg"></div>
      <p class="small">The provider decides first. You pay ${cents(state.deal.price_cents_per_call)} for this call unless it is refunded. You can ask for ${windowText(state.deal.check_window_s)} after the call.</p>`;
    $("ask").onclick = () => requestRefund(t);
    updateWindowNote();
    return;
  }

  const [title, text] = STATUS[status](d, state.deal.provider);
  let html = `<div class="stat" data-s="${status}"><div class="head"><span class="dot"></span>${esc(title)}</div><p>${text}</p></div>`;
  if (d?.claim?.reason) html += `<div class="stat"><span class="k">Your reason</span><p><q>${esc(d.claim.reason)}</q></p></div>`;
  if (d?.provider_decision?.note) html += `<div class="stat"><span class="k">${esc(state.deal.provider)} says</span><p><q>${esc(d.provider_decision.note)}</q></p></div>`;
  if (d?.final?.reasoning) html += `<div class="stat"><span class="k">Pareto's review</span><p>${esc(d.final.reasoning)}</p></div>`;
  if (status === "rejected") {
    html += `<div class="field"><label class="k" for="note">Add a note (optional)</label><textarea id="note" placeholder="Look at the photo again."></textarea></div>
      <div class="actions"><button class="btn primary" id="appeal" ${busy ? "disabled" : ""}>${busy ? "Reviewing..." : "Appeal to Pareto"}</button></div><div class="msg" id="msg"></div>`;
  }
  box.innerHTML = html;
  if (status === "rejected") $("appeal").onclick = () => appeal(t);
}

// ───────── actions ─────────
async function install(id) {
  const msg = $("manual-msg");
  msg.hidden = true;
  try { await api("POST", "/api/install", { deal_id: id }); tiles.clear(); $("grid").innerHTML = ""; await refetch(); }
  catch (e) {
    // shown on the page, not in an alert(): standalone app windows swallow those
    msg.textContent = e.message;
    msg.hidden = false;
  }
}
$("uninstall").onclick = async () => { if (!confirm("Remove this model from the app? The deal itself stays open on Pareto.")) return; try { await api("POST", "/api/uninstall"); closeDrawer(); tiles.clear(); $("grid").innerHTML = ""; await refetch(); } catch (e) { alert(e.message); } };
$("manual").onsubmit = (e) => { e.preventDefault(); const v = $("manual-id").value.trim(); if (v) install(v); };
$("run").onclick = async () => { try { await api("POST", "/api/run"); await refetch(); } catch (e) { $("error").hidden = false; $("error").textContent = e.message; } };
async function refetch() { state = await api("GET", "/api/state"); render(); }

async function requestRefund(t) {
  const reason = $("reason").value; // read it before the drawer re-renders into its "Sending..." state, which empties the box
  busy = true; drawerSig = ""; renderDrawer();
  try {
    refundDetail = await api("POST", "/api/refunds", { charge_id: t.charge_id, reason });
    await refetch();
  } catch (e) { busy = false; drawerSig = ""; renderDrawer(); $("msg").textContent = e.message; return; }
  busy = false; drawerSig = ""; renderDrawer();
}
async function appeal(t) {
  busy = true; drawerSig = ""; const note = $("note")?.value; renderDrawer();
  try {
    refundDetail = await api("POST", `/api/refunds/${t.refund.refund_id}/appeal`, { note });
    await refetch();
  } catch (e) { busy = false; drawerSig = ""; renderDrawer(); $("msg").textContent = e.message; return; }
  busy = false; drawerSig = ""; renderDrawer();
}

tick();
pollRefund();
