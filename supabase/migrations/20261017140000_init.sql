-- Agora: agent-to-agent marketplace. Core schema.
-- Access model: the MCP server/gateway use the service role (bypasses RLS). The public UI uses the anon key and
-- may read only the public-facing tables below. Tables with RLS enabled and no policy are unreadable to anon.

create extension if not exists pgcrypto;

-- ───────────────────────────── agents ─────────────────────────────
create table agents (
  id            uuid primary key default gen_random_uuid(),
  handle        text not null unique check (handle ~ '^[a-z0-9][a-z0-9_-]{1,38}$'),
  roles         text[] not null default '{buyer}' check (roles <@ array['buyer','provider']),
  owner_ref     text not null,                      -- the human principal responsible for this agent
  description   text not null default '',
  capabilities  text[] not null default '{}',
  api_key_hash  text,                               -- sha256 of the key; the key itself is never stored
  seeded        boolean not null default false,
  created_at    timestamptz not null default now()
);

-- Per-agent limits set by the human principal; enforced server-side before any funding or call.
create table spending_policies (
  agent_id               uuid primary key references agents(id) on delete cascade,
  max_per_agreement_cents bigint not null default 1000 check (max_per_agreement_cents >= 0),
  max_total_cents         bigint not null default 5000 check (max_total_cents >= 0),
  allowed_capabilities    text[],                    -- null = any
  updated_at              timestamptz not null default now()
);

-- ───────────────────────────── discovery ─────────────────────────────
create table benchmarks (
  id           uuid primary key default gen_random_uuid(),
  slug         text not null unique,
  title        text not null,
  task         text not null,
  category     text not null,
  metric       text not null default 'accuracy',
  visibility   text not null default 'public' check (visibility in ('public','private','unlisted')),
  owner_id     uuid references agents(id),
  dev_examples jsonb not null default '[]',          -- visible examples
  n_test       int  not null default 0,
  fingerprint  text,                                 -- hash of the hidden test set
  version      int  not null default 1,
  seeded       boolean not null default false,
  created_at   timestamptz not null default now()
);

-- Hidden test sets live apart from the public table. No policy => anon can never read them.
create table benchmark_tests (
  benchmark_id uuid primary key references benchmarks(id) on delete cascade,
  examples     jsonb not null
);

create table listings (
  id            uuid primary key default gen_random_uuid(),
  provider_id   uuid not null references agents(id) on delete cascade,
  title         text not null,
  capability    text not null,
  kind          text not null check (kind in ('agent','mcp','llm','api')),
  endpoint_type text not null check (endpoint_type in ('http','mcp')),
  endpoint_url  text not null,                       -- real provider endpoint; never shown to buyers
  pricing       jsonb not null,                      -- {"model":"per_call","amount_cents":2}
  sla           jsonb not null default '{}',         -- {"p95_ms":3000,"availability":0.99}
  active        boolean not null default true,
  seeded        boolean not null default false,
  created_at    timestamptz not null default now()
);

create table benchmark_results (
  id              uuid primary key default gen_random_uuid(),
  benchmark_id    uuid not null references benchmarks(id) on delete cascade,
  listing_id      uuid not null references listings(id) on delete cascade,
  quality         double precision not null check (quality between 0 and 1),
  ci_low          double precision not null,
  ci_high         double precision not null,
  n               int not null check (n > 0),
  cost_per_call_cents numeric not null,
  p50_ms          int not null,
  p95_ms          int not null,
  verified        boolean not null default true,     -- platform executed it
  seeded          boolean not null default false,
  created_at      timestamptz not null default now()
);
create index on benchmark_results (benchmark_id, listing_id, created_at desc);

-- ───────────────────────────── tasks & agreements ─────────────────────────────
create table tasks (
  id          uuid primary key default gen_random_uuid(),
  buyer_id    uuid not null references agents(id),
  title       text not null,
  description text not null,
  spec        jsonb not null default '{}',           -- inputs, expected outputs, deadline
  created_at  timestamptz not null default now()
);

create table agreements (
  id          uuid primary key default gen_random_uuid(),
  task_id     uuid not null references tasks(id),
  listing_id  uuid not null references listings(id),
  buyer_id    uuid not null references agents(id),
  provider_id uuid not null references agents(id),
  status      text not null default 'proposed' check (status in
              ('draft','proposed','countered','funded','active','closing','settled','disputed','rejected','expired','cancelled')),
  -- terms: {price:{model,amount_cents}, budget_cap_cents, sla:{p95_ms}, evals:[...], holdback_pct,
  --         check_window_s, dispute_window_s, deadline}
  terms       jsonb not null,
  version     int not null default 1,                -- bumps on each counter-offer
  proposed_at timestamptz not null default now(),
  activated_at timestamptz,
  closed_at   timestamptz,
  check (buyer_id <> provider_id)
);
create index on agreements (buyer_id, status);
create index on agreements (provider_id, status);

-- Negotiation history and every state transition: the audit trail of the agreement itself.
create table agreement_events (
  id           bigint generated always as identity primary key,
  agreement_id uuid not null references agreements(id) on delete cascade,
  actor_id     uuid references agents(id),
  kind         text not null,                        -- proposed|countered|approved|funded|activated|closed|disputed|...
  payload      jsonb not null default '{}',
  created_at   timestamptz not null default now()
);

create table access_grants (
  id            uuid primary key default gen_random_uuid(),
  agreement_id  uuid not null unique references agreements(id) on delete cascade,
  key_hash      text not null,
  budget_cap_cents bigint not null,
  rate_limit_per_min int not null default 60,
  expires_at    timestamptz not null,
  revoked_at    timestamptz,
  created_at    timestamptz not null default now()
);

-- ───────────────────────────── ledger (escrow) ─────────────────────────────
-- kinds: external (funding source/sink, may go negative), wallet, escrow, earnings.
create table ledger_accounts (
  id             uuid primary key default gen_random_uuid(),
  kind           text not null check (kind in ('external','wallet','escrow','earnings')),
  agent_id       uuid references agents(id),
  agreement_id   uuid references agreements(id),
  allow_negative boolean generated always as (kind = 'external') stored,
  created_at     timestamptz not null default now()
);
create unique index on ledger_accounts (agent_id, kind) where kind in ('wallet','earnings');
create unique index on ledger_accounts (agreement_id) where kind = 'escrow';

create table ledger_entries (
  id              bigint generated always as identity primary key,
  txn_id          uuid not null,                     -- entries sharing a txn_id must sum to zero
  account_id      uuid not null references ledger_accounts(id),
  amount_cents    bigint not null check (amount_cents <> 0),
  kind            text not null check (kind in
                  ('topup','fund_escrow','hold','release','refund','holdback_release','return_unspent','penalty')),
  agreement_id    uuid references agreements(id),
  reason          text not null,
  evidence        jsonb not null default '{}',       -- ids/scores that justify this movement
  idempotency_key text not null,
  created_at      timestamptz not null default now(),
  unique (idempotency_key, account_id)
);
create index on ledger_entries (account_id);
create index on ledger_entries (txn_id);
create index on ledger_entries (agreement_id);

-- ───────────────────────────── calls, traces, charges ─────────────────────────────
create table calls (
  id            uuid primary key default gen_random_uuid(),
  agreement_id  uuid not null references agreements(id),
  seq           bigint not null,
  request       jsonb not null,
  response      jsonb,
  status_code   int,
  latency_ms    int,
  cost_cents    numeric not null default 0,
  prev_hash     text,                                -- hash chain: tampering with any trace breaks every later hash
  hash          text not null,
  eval_results  jsonb not null default '{}',
  passed        boolean,
  created_at    timestamptz not null default now(),
  unique (agreement_id, seq)
);

create table charges (
  id           uuid primary key default gen_random_uuid(),
  agreement_id uuid not null references agreements(id),
  call_id      uuid not null unique references calls(id),
  amount_cents bigint not null check (amount_cents >= 0),
  state        text not null default 'pending' check (state in ('pending','released','refunded','disputed','frozen')),
  release_at   timestamptz not null,                 -- end of the check window
  updated_at   timestamptz not null default now()
);
create index on charges (agreement_id, state);
create index on charges (state, release_at);

-- ───────────────────────────── disputes ─────────────────────────────
create table disputes (
  id           uuid primary key default gen_random_uuid(),
  agreement_id uuid not null references agreements(id),
  charge_id    uuid references charges(id),          -- set for micro disputes
  scope        text not null check (scope in ('micro','full')),
  opened_by    uuid not null references agents(id),
  claim_type   text not null,                        -- wrong_output|over_billed|late|malformed|non_delivery|sla_breach|...
  claim        jsonb not null default '{}',
  status       text not null default 'open' check (status in
               ('open','awaiting_response','under_review','resolved','withdrawn')),
  response     jsonb,
  verdict      jsonb,                                -- {outcome, refund_pct, reasoning, evidence, rules_applied}
  opened_at    timestamptz not null default now(),
  resolved_at  timestamptz,
  check ((scope = 'micro') = (charge_id is not null))
);
create index on disputes (agreement_id, status);

-- ───────────────────────────── reviews & reputation ─────────────────────────────
create table reviews (
  id           uuid primary key default gen_random_uuid(),
  agreement_id uuid not null references agreements(id),
  reviewer_id  uuid not null references agents(id),
  reviewee_id  uuid not null references agents(id),
  ratings      jsonb not null,                       -- {accuracy, sla, clarity, cost_fairness}: 1..5
  comment      text not null default '',
  weight       numeric not null default 1,           -- scaled by agreement value at settlement
  seeded       boolean not null default false,
  created_at   timestamptz not null default now(),
  unique (agreement_id, reviewer_id),
  check (reviewer_id <> reviewee_id)
);

-- Observability: every tool call an agent makes against the marketplace.
create table tool_sessions (
  id          bigint generated always as identity primary key,
  agent_id    uuid references agents(id),
  client      text,
  tool        text not null,
  args_summary text,
  outcome     text not null,
  latency_ms  int,
  created_at  timestamptz not null default now()
);
create index on tool_sessions (created_at desc);

-- Derived, never typed in: reputation from measured outcomes.
create view agent_reputation as
select a.id as agent_id, a.handle,
  coalesce((select count(*) from agreements g where (g.provider_id = a.id or g.buyer_id = a.id) and g.status = 'settled'), 0) as settled_agreements,
  coalesce((select count(*) from disputes d join agreements g on g.id = d.agreement_id
            where g.provider_id = a.id and d.status = 'resolved' and (d.verdict->>'outcome') = 'upheld'), 0) as disputes_upheld_against,
  coalesce((select count(*) from disputes d join agreements g on g.id = d.agreement_id where g.provider_id = a.id), 0) as disputes_against,
  (select round(avg((r.ratings->>'accuracy')::numeric), 2) from reviews r where r.reviewee_id = a.id) as avg_accuracy,
  (select count(*) from reviews r where r.reviewee_id = a.id) as review_count
from agents a;

-- ───────────────────────────── ledger & trace invariants ─────────────────────────────
-- 1. every txn_id sums to zero; 2. non-external accounts never go negative; both checked at commit.
create or replace function ledger_check() returns trigger language plpgsql as $$
declare s bigint; bal bigint; neg boolean;
begin
  perform pg_advisory_xact_lock(hashtext(new.account_id::text));      -- serialize per account
  select coalesce(sum(amount_cents), 0) into s from ledger_entries where txn_id = new.txn_id;
  if s <> 0 then
    raise exception 'ledger txn % does not balance (sum=%)', new.txn_id, s using errcode = 'check_violation';
  end if;
  select allow_negative into neg from ledger_accounts where id = new.account_id;
  select coalesce(sum(amount_cents), 0) into bal from ledger_entries where account_id = new.account_id;
  if not neg and bal < 0 then
    raise exception 'account % would go negative (balance=%)', new.account_id, bal using errcode = 'check_violation';
  end if;
  return null;
end $$;

create constraint trigger ledger_invariants after insert on ledger_entries
  deferrable initially deferred for each row execute function ledger_check();

-- Append-only: the ledger and the traces are evidence; they are never edited or deleted.
create or replace function forbid_mutation() returns trigger language plpgsql as $$
begin raise exception '% is append-only', tg_table_name using errcode = 'restrict_violation'; end $$;

create trigger ledger_entries_append_only before update or delete on ledger_entries
  for each row execute function forbid_mutation();
create trigger calls_no_delete before delete on calls
  for each row execute function forbid_mutation();
create trigger agreement_events_append_only before update or delete on agreement_events
  for each row execute function forbid_mutation();

-- Balance helper used by the app and the UI.
create view ledger_balances as
select account_id, sum(amount_cents)::bigint as balance_cents from ledger_entries group by account_id;

-- ───────────────────────────── row-level security ─────────────────────────────
alter table agents             enable row level security;
alter table spending_policies  enable row level security;
alter table benchmarks         enable row level security;
alter table benchmark_tests    enable row level security;
alter table listings           enable row level security;
alter table benchmark_results  enable row level security;
alter table tasks              enable row level security;
alter table agreements         enable row level security;
alter table agreement_events   enable row level security;
alter table access_grants      enable row level security;
alter table ledger_accounts    enable row level security;
alter table ledger_entries     enable row level security;
alter table calls              enable row level security;
alter table charges            enable row level security;
alter table disputes           enable row level security;
alter table reviews            enable row level security;
alter table tool_sessions      enable row level security;

-- Public marketplace data the UI may read with the anon key. Everything else has no policy => denied.
create policy public_read_agents    on agents            for select to anon using (true);
create policy public_read_bench     on benchmarks        for select to anon using (visibility = 'public');
create policy public_read_results   on benchmark_results for select to anon using (
  exists (select 1 from benchmarks b where b.id = benchmark_id and b.visibility = 'public'));
create policy public_read_listings  on listings          for select to anon using (active);
create policy public_read_reviews   on reviews           for select to anon using (true);

-- Supabase grants table privileges to anon/authenticated by default, and column-level REVOKEs do nothing against a
-- table-level grant. So: revoke everything, then grant back exactly the public columns.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;

grant select (id, handle, roles, description, capabilities, seeded, created_at) on agents to anon;     -- no api_key_hash, owner_ref
grant select (id, slug, title, task, category, metric, visibility, dev_examples, n_test, fingerprint, version, seeded, created_at)
  on benchmarks to anon;
grant select (id, benchmark_id, listing_id, quality, ci_low, ci_high, n, cost_per_call_cents, p50_ms, p95_ms, verified, seeded, created_at)
  on benchmark_results to anon;
grant select (id, provider_id, title, capability, kind, endpoint_type, pricing, sla, active, seeded, created_at)
  on listings to anon;                                                                                  -- no endpoint_url
grant select on reviews to anon;
grant select on agent_reputation to anon;
