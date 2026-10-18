-- One call releases every due charge on active agreements (the periodic sweep used to make one call per agreement),
-- and grants allow a realistic call rate by default (batch jobs such as classifying a few hundred images).
create or replace function release_all_due() returns int
language plpgsql as $$
declare r record; n int := 0;
begin
  for r in
    select c.id from charges c join agreements a on a.id = c.agreement_id
    where a.status = 'active' and c.state = 'pending' and c.release_at <= now()
  loop
    perform release_charge(r.id); n := n + 1;
  end loop;
  return n;
end $$;

alter table access_grants alter column rate_limit_per_min set default 600;
update access_grants set rate_limit_per_min = 600 where revoked_at is null and rate_limit_per_min < 600;
