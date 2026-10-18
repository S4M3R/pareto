-- What agents did with deals that cited a benchmark, aggregated in the database (a benchmark with many hires has thousands of charges).
create or replace function benchmark_usage(p_benchmark uuid) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'hires', count(distinct a.id),
    'agents', count(distinct a.buyer_id),
    'spend_cents', coalesce(sum(c.amount_cents - c.refunded_cents), 0),
    'earned_cents', coalesce((select sum(e.amount_cents) from ledger_entries e join ledger_accounts la on la.id = e.account_id
                              where e.kind = 'referral' and la.kind = 'earnings' and e.amount_cents > 0
                                and e.agreement_id in (select id from agreements where terms->>'benchmark_id' = p_benchmark::text)), 0))
  from agreements a left join charges c on c.agreement_id = a.id
  where a.terms->>'benchmark_id' = p_benchmark::text and a.status in ('active','settled','disputed','approved');
$$;

create or replace function benchmark_recent(p_benchmark uuid, p_limit int default 8)
returns table(agreement_id uuid, agent text, status text, at timestamptz, spend_cents bigint, referral_cents bigint)
language sql stable as $$
  select a.id, g.handle, a.status, a.proposed_at,
         coalesce((select sum(c.amount_cents - c.refunded_cents) from charges c where c.agreement_id = a.id), 0)::bigint,
         coalesce((select sum(e.amount_cents) from ledger_entries e join ledger_accounts la on la.id = e.account_id
                   where e.agreement_id = a.id and e.kind = 'referral' and la.kind = 'earnings' and e.amount_cents > 0), 0)::bigint
  from agreements a join agents g on g.id = a.buyer_id
  where a.terms->>'benchmark_id' = p_benchmark::text and a.status in ('active','settled','disputed','approved')
  order by a.proposed_at desc limit p_limit;
$$;
