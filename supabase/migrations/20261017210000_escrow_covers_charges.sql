-- A charge may only be recorded if escrow can pay for it. The old check compared spend net of refunds with the budget cap,
-- so every refund (which leaves escrow for the buyer's wallet) freed budget that escrow no longer held, and a long run of
-- calls with automatic refunds could commit more than was funded; closing then failed with a negative escrow balance.
-- Claims on escrow: charges not yet paid out (pending, disputed, frozen) plus the holdback kept on released ones.
create or replace function append_call(p_agreement uuid, p_request jsonb, p_response jsonb, p_status int, p_latency int,
                                       p_eval jsonb, p_passed boolean, p_charge_cents bigint, p_window_s int)
returns jsonb language plpgsql as $$
declare a agreements; cap bigint; spent bigint; esc bigint; claims bigint; s bigint; prev text; h text; cid uuid := gen_random_uuid(); chid uuid := gen_random_uuid();
begin
  perform pg_advisory_xact_lock(hashtext('call:' || p_agreement::text));
  select * into a from agreements where id = p_agreement;
  if a.status <> 'active' then raise exception 'not_active: agreement is %', a.status; end if;
  cap := (a.terms->>'budget_cap_cents')::bigint;
  select coalesce(sum(amount_cents - refunded_cents), 0) into spent from charges where agreement_id = p_agreement;
  esc := account_balance(ensure_account('escrow', null, p_agreement));
  select coalesce(sum(amount_cents) filter (where state in ('pending','disputed','frozen')), 0)
       + coalesce(sum(holdback_cents) filter (where state = 'released'), 0) into claims from charges where agreement_id = p_agreement;
  if spent + p_charge_cents > cap or claims + p_charge_cents > esc then
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
