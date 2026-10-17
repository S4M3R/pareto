-- Count partially upheld disputes against the provider too (a 44% credit is still a finding against them).
create or replace view agent_reputation as
select a.id as agent_id, a.handle,
  coalesce((select count(*) from agreements g where (g.provider_id = a.id or g.buyer_id = a.id) and g.status = 'settled'), 0) as settled_agreements,
  coalesce((select count(*) from disputes d join agreements g on g.id = d.agreement_id
            where g.provider_id = a.id and d.status = 'resolved'
              and (d.verdict->>'outcome') in ('upheld','partially_upheld')), 0) as disputes_upheld_against,
  coalesce((select count(*) from disputes d join agreements g on g.id = d.agreement_id where g.provider_id = a.id), 0) as disputes_against,
  (select round(avg((r.ratings->>'accuracy')::numeric), 2) from reviews r where r.reviewee_id = a.id) as avg_accuracy,
  (select count(*) from reviews r where r.reviewee_id = a.id) as review_count
from agents a;
grant select on agent_reputation to anon;
