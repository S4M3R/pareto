-- Benchmark owners earn a referral when an agent hires a provider after choosing through their benchmark.
-- The payout is its own kind of ledger entry so it is explained as such in get_ledger.
alter table ledger_entries drop constraint if exists ledger_entries_kind_check;
alter table ledger_entries add constraint ledger_entries_kind_check
  check (kind in ('topup','fund_escrow','hold','release','refund','holdback_release','return_unspent','penalty','referral'));
