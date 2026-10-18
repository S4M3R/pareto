-- Cards on file. Card numbers never touch our servers: Stripe's hosted page collects them and we keep only the
-- Stripe ids plus display data (brand, last four, expiry). Server-side only: no policy and no anon/authenticated grants.

create table payment_customers (
  agent_id           uuid primary key references agents(id) on delete cascade,
  stripe_customer_id text not null unique,
  created_at         timestamptz not null default now()
);

create table payment_methods (
  id           uuid primary key default gen_random_uuid(),
  agent_id     uuid not null references agents(id) on delete cascade,
  stripe_pm_id text not null unique,
  brand        text not null,
  last4        text not null check (last4 ~ '^[0-9]{4}$'),
  exp_month    int  check (exp_month between 1 and 12),
  exp_year     int,
  is_default   boolean not null default false,
  created_at   timestamptz not null default now(),
  removed_at   timestamptz
);
-- One live default card per agent.
create unique index payment_methods_one_default on payment_methods (agent_id) where is_default and removed_at is null;
create index payment_methods_agent on payment_methods (agent_id) where removed_at is null;

alter table payment_customers enable row level security;
alter table payment_methods   enable row level security;
revoke all on payment_customers, payment_methods from anon, authenticated;
