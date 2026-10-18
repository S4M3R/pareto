-- Money can leave a wallet: the balance returned to its funding source (and used to reset a demo account).
alter table ledger_entries drop constraint if exists ledger_entries_kind_check;
alter table ledger_entries add constraint ledger_entries_kind_check
  check (kind in ('topup','fund_escrow','hold','release','refund','holdback_release','return_unspent','penalty','referral','withdrawal'));
