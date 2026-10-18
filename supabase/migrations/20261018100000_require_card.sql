-- An account can be set to require a saved card before it may add funds. Without the flag, a top-up with no card on file
-- uses Stripe's generic test card (test mode convenience). With it, the person must add their own card first.
alter table agents add column if not exists require_card boolean not null default false;
