-- Money movement and evidence as atomic database functions. The app calls these via RPC; the ledger triggers
-- from the init migration still verify balance and non-negativity at commit.

alter table agreements drop constraint agreements_status_check;
alter table agreements add constraint agreements_status_check check (status in
  ('draft','proposed','countered','approved','funded','active','closing','settled','disputed','rejected','expired','cancelled'));

alter table charges add column holdback_cents bigint not null default 0;
alter table charges add column refunded_cents bigint not null default 0;
alter table charges drop constraint charges_state_check;
alter table charges add constraint charges_state_check check (state in
  ('pending','released','refunded','partially_refunded','disputed','frozen'));

-- ───────── accounts & primitive move ─────────
create or replace function ensure_account(p_kind text, p_agent uuid, p_agreement uuid) returns uuid
language plpgsql as $$
declare v uuid;
begin
  if p_kind = 'external' then
    select id into v from ledger_accounts where kind = 'external' limit 1;
  elsif p_kind = 'escrow' then
    select id into v from ledger_accounts where kind = 'escrow' and agreement_id = p_agreement;
  else
    select id into v from ledger_accounts where kind = p_kind and agent_id = p_agent;
  end if;
  if v is null then
    insert into ledger_accounts(kind, agent_id, agreement_id) values (p_kind, p_agent, p_agreement) returning id into v;
  end if;
  return v;
end $$;

create or replace function account_balance(p_account uuid) returns bigint
language sql stable as $$ select coalesce(sum(amount_cents), 0)::bigint from ledger_entries where account_id = p_account $$;

-- Idempotent: returns null (no-op) if this key was already applied.
create or replace function ledger_move(p_from uuid, p_to uuid, p_cents bigint, p_kind text, p_agreement uuid,
                                       p_reason text, p_evidence jsonb, p_key text) returns uuid
language plpgsql as $$
declare t uuid := gen_random_uuid();
begin
  if p_cents <= 0 then raise exception 'ledger_move: amount must be positive (got %)', p_cents; end if;
  if exists (select 1 from ledger_entries where idempotency_key = p_key || ':out') then return null; end if;
  insert into ledger_entries(txn_id, account_id, amount_cents, kind, agreement_id, reason, evidence, idempotency_key) values
    (t, p_from, -p_cents, p_kind, p_agreement, p_reason, coalesce(p_evidence, '{}'), p_key || ':out'),
    (t, p_to,    p_cents, p_kind, p_agreement, p_reason, coalesce(p_evidence, '{}'), p_key || ':in');
  return t;
end $$;

-- ───────── wallet ─────────
create or replace function topup(p_agent uuid, p_cents bigint, p_key text, p_ref text default 'demo') returns bigint
language plpgsql as $$
declare ext uuid := ensure_account('external', null, null); w uuid := ensure_account('wallet', p_agent, null);
begin
  perform ledger_move(ext, w, p_cents, 'topup', null, 'wallet top-up (' || p_ref || ')', jsonb_build_object('ref', p_ref), p_key);
  return account_balance(w);
end $$;

-- ───────── escrow funding (activates the agreement) ─────────
create or replace function fund_escrow(p_agreement uuid, p_key text) returns jsonb
language plpgsql as $$
declare a agreements; cap bigint; w uuid; e uuid; bal bigint;
begin
  select * into a from agreements where id = p_agreement for update;
  if a.id is null then raise exception 'unknown_agreement'; end if;
  if a.status <> 'approved' then raise exception 'wrong_status: agreement is %, must be approved by the provider first', a.status; end if;
  cap := (a.terms->>'budget_cap_cents')::bigint;
  w := ensure_account('wallet', a.buyer_id, null);
  e := ensure_account('escrow', null, a.id);
  bal := account_balance(w);
  if bal < cap then raise exception 'insufficient_funds: need % cents, wallet has % cents', cap, bal; end if;
  perform ledger_move(w, e, cap, 'fund_escrow', a.id, 'escrow funded to budget cap', jsonb_build_object('budget_cap_cents', cap), p_key);
  update agreements set status = 'active', activated_at = now() where id = a.id;
  insert into agreement_events(agreement_id, actor_id, kind, payload)
    values (a.id, a.buyer_id, 'funded', jsonb_build_object('cents', cap));
  return jsonb_build_object('escrow_cents', account_balance(e), 'wallet_cents', account_balance(w));
end $$;

-- ───────── record a metered call and its pending charge (tamper-evident chain) ─────────
create or replace function append_call(p_agreement uuid, p_request jsonb, p_response jsonb, p_status int, p_latency int,
                                       p_eval jsonb, p_passed boolean, p_charge_cents bigint, p_window_s int)
returns jsonb language plpgsql as $$
declare a agreements; cap bigint; spent bigint; s bigint; prev text; h text; cid uuid := gen_random_uuid(); chid uuid := gen_random_uuid();
begin
  perform pg_advisory_xact_lock(hashtext('call:' || p_agreement::text));
  select * into a from agreements where id = p_agreement;
  if a.status <> 'active' then raise exception 'not_active: agreement is %', a.status; end if;
  cap := (a.terms->>'budget_cap_cents')::bigint;
  select coalesce(sum(amount_cents - refunded_cents), 0) into spent from charges where agreement_id = p_agreement;
  if spent + p_charge_cents > cap then
    raise exception 'budget_exceeded: spent % + call % > cap % cents', spent, p_charge_cents, cap;
  end if;
  select coalesce(max(seq), 0) + 1 into s from calls where agreement_id = p_agreement;
  select hash into prev from calls where agreement_id = p_agreement and seq = s - 1;
  h := encode(digest(coalesce(prev, '') || p_request::text || coalesce(p_response::text, '') || s::text, 'sha256'), 'hex');
  insert into calls(id, agreement_id, seq, request, response, status_code, latency_ms, cost_cents, prev_hash, hash, eval_results, passed)
    values (cid, p_agreement, s, p_request, p_response, p_status, p_latency, p_charge_cents, prev, h, coalesce(p_eval, '{}'), p_passed);
  insert into charges(id, agreement_id, call_id, amount_cents, state, release_at)
    values (chid, p_agreement, cid, p_charge_cents, 'pending', now() + make_interval(secs => p_window_s));
  return jsonb_build_object('call_id', cid, 'charge_id', chid, 'seq', s, 'hash', h, 'spent_cents', spent + p_charge_cents, 'cap_cents', cap);
end $$;

-- ───────── release & refund ─────────
create or replace function release_charge(p_charge uuid) returns void
language plpgsql as $$
declare c charges; a agreements; hold bigint; pay bigint; e uuid; earn uuid;
begin
  select * into c from charges where id = p_charge for update;
  if c.state <> 'pending' then return; end if;
  select * into a from agreements where id = c.agreement_id;
  hold := floor(c.amount_cents * coalesce((a.terms->>'holdback_pct')::numeric, 0) / 100);
  pay := c.amount_cents - hold;
  e := ensure_account('escrow', null, a.id);
  earn := ensure_account('earnings', a.provider_id, null);
  if pay > 0 then
    perform ledger_move(e, earn, pay, 'release', a.id, 'charge released after check window',
      jsonb_build_object('charge_id', c.id, 'holdback_cents', hold), 'rel:' || c.id);
  end if;
  update charges set state = 'released', holdback_cents = hold, updated_at = now() where id = c.id;
end $$;

create or replace function release_due(p_agreement uuid) returns int
language plpgsql as $$
declare r record; n int := 0;
begin
  for r in select id from charges where agreement_id = p_agreement and state = 'pending' and release_at <= now() loop
    perform release_charge(r.id); n := n + 1;
  end loop;
  return n;
end $$;

-- Refund pct (0..100) of an unreleased charge to the buyer; the remainder is paid to the provider.
create or replace function refund_charge(p_charge uuid, p_pct int, p_reason text, p_evidence jsonb) returns jsonb
language plpgsql as $$
declare c charges; a agreements; e uuid; w uuid; earn uuid; refund bigint; rest bigint;
begin
  select * into c from charges where id = p_charge for update;
  if c.state not in ('pending','disputed','frozen') then raise exception 'cannot_refund: charge is %', c.state; end if;
  select * into a from agreements where id = c.agreement_id;
  e := ensure_account('escrow', null, a.id);
  w := ensure_account('wallet', a.buyer_id, null);
  earn := ensure_account('earnings', a.provider_id, null);
  refund := floor(c.amount_cents * greatest(0, least(100, p_pct)) / 100.0);
  rest := c.amount_cents - refund;
  if refund > 0 then
    perform ledger_move(e, w, refund, 'refund', a.id, p_reason, p_evidence, 'ref:' || c.id);
  end if;
  if rest > 0 then
    perform ledger_move(e, earn, rest, 'release', a.id, 'unrefunded part of charge paid to provider', p_evidence, 'refrest:' || c.id);
  end if;
  update charges set state = case when refund >= c.amount_cents then 'refunded' when refund > 0 then 'partially_refunded' else 'released' end,
                     refunded_cents = refund, updated_at = now() where id = c.id;
  return jsonb_build_object('charge_id', c.id, 'refunded_cents', refund, 'paid_to_provider_cents', rest);
end $$;

-- ───────── micro dispute ─────────
create or replace function open_micro_dispute(p_charge uuid, p_opened_by uuid, p_claim_type text, p_claim jsonb) returns uuid
language plpgsql as $$
declare c charges; d uuid := gen_random_uuid();
begin
  select * into c from charges where id = p_charge for update;
  if c.id is null then raise exception 'unknown_charge'; end if;
  if c.state <> 'pending' then raise exception 'outside_window: charge is %, micro disputes need a pending charge (inside the check window)', c.state; end if;
  update charges set state = 'disputed', updated_at = now() where id = c.id;
  insert into disputes(id, agreement_id, charge_id, scope, opened_by, claim_type, claim, status)
    values (d, c.agreement_id, c.id, 'micro', p_opened_by, p_claim_type, coalesce(p_claim, '{}'), 'under_review');
  return d;
end $$;

create or replace function resolve_micro_dispute(p_dispute uuid, p_outcome text, p_refund_pct int, p_verdict jsonb) returns jsonb
language plpgsql as $$
declare d disputes; res jsonb := '{}';
begin
  select * into d from disputes where id = p_dispute for update;
  if d.status = 'resolved' then return d.verdict; end if;
  if p_outcome = 'upheld' then
    res := refund_charge(d.charge_id, p_refund_pct, 'micro dispute upheld', p_verdict);
  else
    update charges set state = 'pending', release_at = now(), updated_at = now() where id = d.charge_id;
  end if;
  update disputes set status = 'resolved', verdict = p_verdict || jsonb_build_object('outcome', p_outcome, 'refund_pct', p_refund_pct) , resolved_at = now()
    where id = p_dispute;
  return coalesce(res, '{}') || jsonb_build_object('outcome', p_outcome);
end $$;

-- ───────── full dispute ─────────
create or replace function open_full_dispute(p_agreement uuid, p_opened_by uuid, p_claim_type text, p_claim jsonb) returns uuid
language plpgsql as $$
declare a agreements; d uuid := gen_random_uuid();
begin
  select * into a from agreements where id = p_agreement for update;
  if a.status not in ('active','closing') then raise exception 'wrong_status: agreement is %, full disputes need an active or closing agreement', a.status; end if;
  update charges set state = 'frozen', updated_at = now() where agreement_id = a.id and state in ('pending','disputed');
  update access_grants set revoked_at = now() where agreement_id = a.id and revoked_at is null;
  update agreements set status = 'disputed' where id = a.id;
  insert into disputes(id, agreement_id, scope, opened_by, claim_type, claim, status)
    values (d, a.id, 'full', p_opened_by, p_claim_type, coalesce(p_claim, '{}'), 'awaiting_response');
  insert into agreement_events(agreement_id, actor_id, kind, payload)
    values (a.id, p_opened_by, 'disputed', jsonb_build_object('dispute_id', d, 'claim_type', p_claim_type));
  return d;
end $$;

-- refund_pct applies to everything at stake (frozen charges + holdbacks). Unspent budget always returns to the buyer.
create or replace function resolve_full_dispute(p_dispute uuid, p_refund_pct int, p_verdict jsonb) returns jsonb
language plpgsql as $$
declare d disputes; a agreements; e uuid; w uuid; earn uuid; frozen_total bigint; hold_total bigint; stake bigint;
        refund bigint; to_provider bigint; unspent bigint; pct int := greatest(0, least(100, p_refund_pct));
begin
  select * into d from disputes where id = p_dispute for update;
  if d.status = 'resolved' then return d.verdict; end if;
  select * into a from agreements where id = d.agreement_id for update;
  e := ensure_account('escrow', null, a.id);
  w := ensure_account('wallet', a.buyer_id, null);
  earn := ensure_account('earnings', a.provider_id, null);
  select coalesce(sum(amount_cents), 0) into frozen_total from charges where agreement_id = a.id and state = 'frozen';
  select coalesce(sum(holdback_cents), 0) into hold_total from charges where agreement_id = a.id and state = 'released';
  stake := frozen_total + hold_total;
  refund := floor(stake * pct / 100.0);
  to_provider := stake - refund;
  unspent := account_balance(e) - stake;
  if unspent < 0 then raise exception 'ledger_inconsistent: escrow % < stake %', account_balance(e), stake; end if;
  if refund > 0 then perform ledger_move(e, w, refund, 'refund', a.id, 'full dispute verdict: refund', p_verdict, 'fd:ref:' || d.id); end if;
  if to_provider > 0 then perform ledger_move(e, earn, to_provider, 'release', a.id, 'full dispute verdict: paid to provider', p_verdict, 'fd:pay:' || d.id); end if;
  if unspent > 0 then perform ledger_move(e, w, unspent, 'return_unspent', a.id, 'unspent budget returned', p_verdict, 'fd:un:' || d.id); end if;
  update charges set state = case when pct >= 100 then 'refunded' when pct > 0 then 'partially_refunded' else 'released' end,
                     refunded_cents = floor(amount_cents * pct / 100.0), updated_at = now()
    where agreement_id = a.id and state = 'frozen';
  update agreements set status = 'settled', closed_at = now() where id = a.id;
  update disputes set status = 'resolved', verdict = p_verdict || jsonb_build_object('refund_pct', pct,
      'refunded_cents', refund, 'paid_to_provider_cents', to_provider, 'returned_unspent_cents', unspent), resolved_at = now()
    where id = d.id;
  insert into agreement_events(agreement_id, kind, payload) values (a.id, 'settled', jsonb_build_object('via', 'full_dispute', 'dispute_id', d.id));
  return jsonb_build_object('refunded_cents', refund, 'paid_to_provider_cents', to_provider, 'returned_unspent_cents', unspent);
end $$;

-- ───────── normal close ─────────
create or replace function close_agreement(p_agreement uuid, p_actor uuid) returns jsonb
language plpgsql as $$
declare a agreements; e uuid; w uuid; earn uuid; r record; hold_total bigint; unspent bigint;
begin
  select * into a from agreements where id = p_agreement for update;
  if a.status <> 'active' then raise exception 'wrong_status: agreement is %, only active agreements can be closed', a.status; end if;
  if exists (select 1 from disputes where agreement_id = a.id and status <> 'resolved' and status <> 'withdrawn') then
    raise exception 'open_dispute: resolve or withdraw open disputes before closing';
  end if;
  for r in select id from charges where agreement_id = a.id and state = 'pending' loop perform release_charge(r.id); end loop;
  e := ensure_account('escrow', null, a.id);
  w := ensure_account('wallet', a.buyer_id, null);
  earn := ensure_account('earnings', a.provider_id, null);
  select coalesce(sum(holdback_cents), 0) into hold_total from charges where agreement_id = a.id and state = 'released';
  if hold_total > 0 then perform ledger_move(e, earn, hold_total, 'holdback_release', a.id, 'holdback released at close', '{}', 'close:hold:' || a.id); end if;
  unspent := account_balance(e);
  if unspent > 0 then perform ledger_move(e, w, unspent, 'return_unspent', a.id, 'unspent budget returned at close', '{}', 'close:un:' || a.id); end if;
  update agreements set status = 'settled', closed_at = now() where id = a.id;
  update access_grants set revoked_at = now() where agreement_id = a.id and revoked_at is null;
  insert into agreement_events(agreement_id, actor_id, kind, payload)
    values (a.id, p_actor, 'settled', jsonb_build_object('holdback_released_cents', hold_total, 'returned_unspent_cents', unspent));
  return jsonb_build_object('holdback_released_cents', hold_total, 'returned_unspent_cents', unspent);
end $$;

-- ───────── spend summary ─────────
create or replace function agreement_spend(p_agreement uuid) returns jsonb
language plpgsql stable as $$
declare a agreements; e uuid;
begin
  select * into a from agreements where id = p_agreement;
  select id into e from ledger_accounts where kind = 'escrow' and agreement_id = p_agreement;
  return jsonb_build_object(
    'budget_cap_cents', (a.terms->>'budget_cap_cents')::bigint,
    'calls', (select count(*) from calls where agreement_id = p_agreement),
    'charged_cents', (select coalesce(sum(amount_cents), 0) from charges where agreement_id = p_agreement),
    'pending_cents', (select coalesce(sum(amount_cents), 0) from charges where agreement_id = p_agreement and state in ('pending','disputed','frozen')),
    'released_cents', (select coalesce(sum(amount_cents - holdback_cents), 0) from charges where agreement_id = p_agreement and state = 'released'),
    'holdback_cents', (select coalesce(sum(holdback_cents), 0) from charges where agreement_id = p_agreement and state = 'released'),
    'refunded_cents', (select coalesce(sum(refunded_cents), 0) from charges where agreement_id = p_agreement),
    'escrow_balance_cents', coalesce(account_balance(e), 0));
end $$;
