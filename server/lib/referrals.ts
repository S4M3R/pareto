import { db, rpc } from "./db.js";

/** Benchmark owners earn a referral when an agent hires a provider after choosing through their benchmark: this share of
 * what the hire settled to (spend minus refunds), paid by the platform into the owner's earnings at close. */
export const REFERRAL_PCT = 5;

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Pay the referral for a settled agreement, once. Nothing is paid when the agreement did not cite a benchmark, when the
 * owner is the buyer or the provider (no paying yourself), or when the net spend is too small to round to a cent. */
export async function payReferral(agreementId: string): Promise<{ owner_id: string; cents: number } | null> {
  const { data: ag } = await db.from("agreements").select("id,buyer_id,provider_id,terms").eq("id", agreementId).maybeSingle();
  const benchmarkId = (ag?.terms as Row | undefined)?.benchmark_id as string | undefined;
  if (!ag || !benchmarkId) return null;
  const { data: b } = await db.from("benchmarks").select("id,slug,title,owner_id").eq("id", benchmarkId).maybeSingle();
  if (!b?.owner_id || b.owner_id === ag.buyer_id || b.owner_id === ag.provider_id) return null;
  const { data: charges } = await db.from("charges").select("amount_cents,refunded_cents").eq("agreement_id", agreementId);
  const net = (charges ?? []).reduce((s, c) => s + Number(c.amount_cents) - Number(c.refunded_cents ?? 0), 0);
  const cents = Math.floor((net * REFERRAL_PCT) / 100);
  if (cents < 1) return null;
  const ext = await rpc<string>("ensure_account", { p_kind: "external", p_agent: null, p_agreement: null });
  const earn = await rpc<string>("ensure_account", { p_kind: "earnings", p_agent: b.owner_id, p_agreement: null });
  await rpc("ledger_move", {
    p_from: ext, p_to: earn, p_cents: cents, p_kind: "referral", p_agreement: agreementId,
    p_reason: `referral: ${REFERRAL_PCT}% of ${net}c settled on a hire chosen with the benchmark "${b.title}"`,
    p_evidence: { benchmark_id: b.id, slug: b.slug, net_spend_cents: net, pct: REFERRAL_PCT }, p_key: `referral:${agreementId}`,
  });
  return { owner_id: b.owner_id, cents };
}
