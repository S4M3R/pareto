/** Output schemas for every tool that renders a view. The schema is the contract between the tool and its view:
 * the server validates `structuredContent` against it, and views import the inferred types (type-only). Objects are
 * loose on purpose, so adding a field to a tool never breaks a view that does not use it yet. */
import { z } from "zod";

const o = z.looseObject;
const num = z.number();
const str = z.string();
const next = str.optional();

// ───────── shared pieces ─────────
export const Terms = o({
  price: o({ model: str.optional(), amount_cents: num }),
  budget_cap_cents: num,
  sla: o({ max_latency_ms: num.optional(), p95_ms: num.optional() }).optional(),
  evals: z.array(o({ type: str })).optional(),
  holdback_pct: num.optional(),
  check_window_s: num.optional(),
  dispute_response_s: num.optional(),
  acceptance: o({ min_pass_rate: num.optional() }).optional(),
  auto_refund_failed: z.boolean().optional(),
});

export const Spend = o({
  budget_cap_cents: num,
  calls: num,
  charged_cents: num,
  pending_cents: num,
  released_cents: num,
  holdback_cents: num,
  refunded_cents: num,
  escrow_balance_cents: num,
  remaining_budget_cents: num.optional(),
});

const Reputation = o({
  settled_agreements: num.optional(),
  disputes_against: num.optional(),
  disputes_upheld_against: num.optional(),
  reviews: num.optional(),
  review_count: num.optional(),
  avg_accuracy: z.union([num, str]).nullable().optional(),
});

const Ratings = o({ accuracy: num, sla: num, clarity: num, cost_fairness: num });

// ───────── account & money ─────────
export const WhoamiOut = o({
  handle: str,
  roles: z.array(str),
  wallet_cents: num,
  earnings_cents: num,
  spending_policy: z.union([
    o({ max_per_agreement_cents: num, max_total_cents: num, allowed_capabilities: z.array(str).nullable().optional() }),
    str,
  ]),
  open_agreements: z.array(o({ id: str, status: str })),
  next,
});

export const RequestFundsOut = o({
  handle: str,
  wallet_cents: num,
  needed_cents: num.nullable(),
  suggested_cents: num,
  presets_cents: z.array(num),
  max_topup_cents: num,
  rail: z.enum(["stripe-test", "mock"]),
  reason: str.nullable(),
  approval_url: str.optional(),
  next,
});

export const TopupOut = o({ rail: str, ref: str, wallet_cents: num, next });

export const LedgerOut = o({
  balances_cents: z.record(str, num),
  entries: z.array(o({ at: str, account: str.optional(), cents: num, kind: str, reason: str.nullable().optional(), evidence: z.unknown().optional() })),
  next,
});

// ───────── discovery ─────────
export const SearchBenchmarksOut = o({
  matches: z.array(o({
    benchmark_id: str, slug: str, title: str, match_confidence: num, why: str,
    category: str.optional(), metric: str.optional(), n_test: num.optional(), fingerprint: str.nullable().optional(),
    version: num.optional(), seeded: z.boolean().optional(),
    leaderboard: z.array(o({ provider: str, title: str, quality: num, ci95: z.array(num), n: num, price_cents_per_call: num })).optional(),
  })),
  note: str.optional(),
  next,
});

export const CompareProvidersOut = o({
  benchmark: o({ id: str, slug: str, title: str, metric: str, n_test: num }),
  providers: z.array(o({
    listing_id: str, provider: str, title: str,
    quality: num, ci95: z.array(num), n: num, verified: z.boolean(),
    price_cents_per_call: num, p50_ms: num, p95_ms: num,
    upheld_per_settled: num.nullable(), settled_agreements: num, seeded: z.boolean(),
    on_frontier: z.boolean(), dominated_by: str.nullable(), confidently_dominated: z.boolean(),
  })),
  recommendation: o({ listing_id: str, provider: str, reason: str }).nullable(),
  note: str.optional(),
  next,
});

export const ProviderRow = o({
  listing_id: str, provider: str, title: str,
  quality: num, ci95: z.array(num), n: num, verified: z.boolean(),
  price_cents_per_call: num, p50_ms: num, p95_ms: num,
  reputation: Reputation, seeded: z.boolean(), tied_with_previous: z.boolean(),
});

export const FindProvidersOut = o({ providers: z.array(ProviderRow), note: str.optional(), next });

export const GetProviderOut = o({
  provider: str.optional(),
  listing: o({
    id: str, title: str, capability: str, kind: str, seeded: z.boolean().optional(),
    pricing: o({ amount_cents: num }), sla: o({ p95_ms: num.optional() }).optional(),
  }),
  results: z.array(o({ benchmark_id: str, quality: num, ci_low: num, ci_high: num, n: num, p50_ms: num, p95_ms: num, verified: z.boolean() })),
  reputation: Reputation,
  recent_reviews: z.array(o({ ratings: Ratings, comment: str.nullable().optional(), weight: num, seeded: z.boolean().optional() })),
  next,
});

// ───────── deal ─────────
const AgreementBase = {
  agreement_id: str,
  status: str,
  terms: Terms,
  listing_title: str.optional(),
  buyer: str.optional(),
  provider: str.optional(),
  next,
};

export const ProposeAgreementOut = o(AgreementBase);

export const GetAgreementOut = o({
  ...AgreementBase,
  role: str,
  version: num,
  spend: Spend.nullable(),
  recent_events: z.array(o({ kind: str, created_at: str, payload: z.unknown().optional() })),
});

export const FundEscrowOut = o({
  ...AgreementBase,
  escrow_cents: num,
  wallet_cents: num,
  access: o({ gateway_url: str, header: str, grant_key: str, expires_at: str, note: str }),
});

export const ListRequestsOut = o({
  requests: z.array(o({
    agreement_id: str, status: str, listing: str.optional(), buyer: str.optional(),
    buyer_settled_agreements: num, terms: Terms,
  })),
  next,
});

export const ReviewProposalOut = o({ agreement_id: str, status: str, terms: Terms.optional(), next });

// ───────── use ─────────
export const CallProviderOut = o({
  call_id: str, charge_id: str, seq: num, hash: str,
  result: z.record(str, z.unknown()).nullable(),
  status: z.enum(["pending", "auto_refunded"]),
  charged_cents: num,
  checks: z.array(o({ type: str, passed: z.boolean(), detail: str })),
  check_window_s: num, spent_cents: num, cap_cents: num, latency_ms: num,
  next,
});

export const GetSpendOut = o({ ...Spend.shape, next });

export const ListCallsOut = o({
  calls: z.array(o({
    seq: num, call_id: str, charge_id: str.optional(), charge_state: str.optional(), cents: num.optional(),
    passed: z.boolean(), latency_ms: num, failed_checks: z.array(str),
  })),
  next,
});

// ───────── disputes, close, review ─────────
const Verdict = o({
  scope: str.optional(), outcome: str.optional(), reasoning: str.optional(), rules_applied: z.array(str).optional(),
  evidence: o({}).optional(), refund_pct: num.optional(), refunded_cents: num.optional(),
  paid_to_provider_cents: num.optional(), returned_unspent_cents: num.optional(), appeal: str.optional(),
});

export const FileDisputeOut = o({
  dispute_id: str,
  outcome: str.optional(),
  reasoning: str.optional(),
  settlement: o({ refunded_cents: num.optional(), paid_to_provider_cents: num.optional(), outcome: str.optional() }).optional(),
  evidence: o({}).optional(),
  rules_applied: z.array(str).optional(),
  status: str.optional(),
  response_deadline: str.optional(),
  next,
});

export const GetDisputeOut = o({
  dispute_id: str, scope: str, status: str, claim_type: str,
  claim: o({ note: str.optional(), response_deadline: str.optional() }).nullable(),
  response: o({ statement: str.optional() }).nullable(),
  verdict: Verdict.nullable(),
  opened_at: str, resolved_at: str.nullable(),
  next,
});

export const CloseTaskOut = o({
  status: str,
  holdback_released_cents: num,
  returned_unspent_cents: num,
  final: Spend,
  wallet_cents: num.optional(),
  provider: str.optional(),
  listing_title: str.optional(),
  next,
});

export const ReviewOut = o({ review: str, weight: num, value_cents: num, next });

export type WhoamiData = z.infer<typeof WhoamiOut>;
export type RequestFundsData = z.infer<typeof RequestFundsOut>;
export type TopupData = z.infer<typeof TopupOut>;
export type LedgerData = z.infer<typeof LedgerOut>;
export type SearchBenchmarksData = z.infer<typeof SearchBenchmarksOut>;
export type CompareProvidersData = z.infer<typeof CompareProvidersOut>;
export type FindProvidersData = z.infer<typeof FindProvidersOut>;
export type GetProviderData = z.infer<typeof GetProviderOut>;
export type AgreementData = z.infer<typeof GetAgreementOut>;
export type ProposeAgreementData = z.infer<typeof ProposeAgreementOut>;
export type FundEscrowData = z.infer<typeof FundEscrowOut>;
export type ListRequestsData = z.infer<typeof ListRequestsOut>;
export type ReviewProposalData = z.infer<typeof ReviewProposalOut>;
export type CallProviderData = z.infer<typeof CallProviderOut>;
export type SpendData = z.infer<typeof GetSpendOut>;
export type ListCallsData = z.infer<typeof ListCallsOut>;
export type FileDisputeData = z.infer<typeof FileDisputeOut>;
export type GetDisputeData = z.infer<typeof GetDisputeOut>;
export type CloseTaskData = z.infer<typeof CloseTaskOut>;
export type ReviewData = z.infer<typeof ReviewOut>;
export type TermsData = z.infer<typeof Terms>;
