import { z } from "zod";
import { topupViaRail } from "../lib/payments.js";
import { LedgerOut, RequestFundsOut, TopupOut } from "../lib/schemas.js";
import { MAX_TOPUP_CENTS, type Row, db, rpc, topupCard, walletCents } from "./common.js";
import { type AnyServer, defineTool } from "./define.js";

export function registerMoney(server: AnyServer) {
  defineTool(server, {
    name: "show_topup_card",
    description: "Display only: opens the add-funds card for the human. This tool moves no money and takes no amount; the human picks an amount and clicks the button themselves (test mode, no real card). Use it when the human wants to add funds to their wallet. The result includes approval_url: if your client cannot show the card, give that link to the human to open in a browser and approve.",
    input: z.object({
      reason: z.string().max(200).optional().describe("One line shown on the card, e.g. 'to fund the extraction job'"),
    }),
    role: "buyer",
    readOnly: true,
    output: RequestFundsOut,
    view: { name: "fund-wallet", description: "Wallet top-up card with amount presets" },
  }, async (a, agent) => {
    const card = await topupCard(agent!, { reason: a.reason });
    return {
      data: card,
      next: "Show the card, or if your client cannot render it, tell the human to open approval_url in a browser to approve. Once they have added funds, retry whatever needed them (for example fund_escrow).",
      // The card shows the balance, amount and test-mode note. The reply should be one line, not a repeat of them.
      say: `The add-funds card is on the user's screen. Reply with ONE short sentence, like: "Click Add on the card to approve (or use this link if you don't see it): ${card.approval_url}". Do not restate the balance, the amount or that it is test mode, and do not explain.`,
    };
  });

  const topupWallet = defineTool(server, {
    name: "topup_wallet",
    description: "Called by the top-up card's button when the human clicks it; agents do not call this. Adds test-mode funds to the wallet (Stripe test card if configured, otherwise a labelled mock rail). Max 5000 cents per call.",
    input: z.object({ amount_cents: z.number().int().min(1).max(MAX_TOPUP_CENTS), idempotency_key: z.string().min(6).max(64).optional() }),
    role: "buyer",
    output: TopupOut,
    visibility: "app", // only a human click in the card moves money; hosts hide this tool from the model
  }, async (a, agent) => {
    const r = await topupViaRail(agent!.id, a.amount_cents, a.idempotency_key ?? crypto.randomUUID());
    return { data: r, next: "propose_agreement, then fund_escrow." };
  });

  // Read-only and app-only: the add-funds card asks for the live balance so it never shows a stale "add funds" screen
  // after the wallet was already topped up (here, on the approval page, or in another card).
  defineTool(server, {
    name: "wallet_balance",
    description: "Called by the add-funds card to show the current balance; agents do not call this (use whoami).",
    input: z.object({}),
    role: "buyer",
    readOnly: true,
    output: z.object({ wallet_cents: z.number(), next: z.string().optional() }),
    visibility: "app",
  }, async (_a, agent) => ({ data: { wallet_cents: await walletCents(agent!.id) } }));

  defineTool(server, {
    name: "set_spending_policy",
    description: "Limits the human principal places on this agent, enforced server-side before any agreement is proposed or funded: max per agreement, max total across open agreements, and optionally which capabilities may be bought.",
    input: z.object({
      max_per_agreement_cents: z.number().int().min(0), max_total_cents: z.number().int().min(0),
      allowed_capabilities: z.array(z.string()).optional(),
    }),
    role: "buyer",
    idempotent: true,
  }, async (a, agent) => {
    await db.from("spending_policies").upsert({
      agent_id: agent!.id, max_per_agreement_cents: a.max_per_agreement_cents, max_total_cents: a.max_total_cents,
      allowed_capabilities: a.allowed_capabilities ?? null, updated_at: new Date().toISOString(),
    });
    return { data: { policy: a } };
  });

  defineTool(server, {
    name: "get_ledger",
    description: "Money movements with reasons: your wallet and earnings, plus the escrow of an agreement if you pass agreement_id. Every movement shows why it happened and the evidence behind it. Balances are derived from these entries.",
    input: z.object({ agreement_id: z.string().uuid().optional(), limit: z.number().int().min(1).max(60).default(25) }),
    readOnly: true,
    show: {
      name: "show_ledger",
      description: "Display only: shows the human a ledger card of recent money movements with the reason for each. To read it yourself use get_ledger.",
      view: { name: "ledger-table", description: "Recent money movements with the reason for each" },
      output: LedgerOut,
    },
  }, async (a, agent) => {
    const { data: own } = await db.from("ledger_accounts").select("id,kind").eq("agent_id", agent!.id);
    const accounts = [...(own ?? [])];
    if (a.agreement_id) {
      const { data: ag } = await db.from("agreements").select("buyer_id,provider_id").eq("id", a.agreement_id).maybeSingle();
      if (ag && (ag.buyer_id === agent!.id || ag.provider_id === agent!.id)) {
        const { data: esc } = await db.from("ledger_accounts").select("id,kind").eq("agreement_id", a.agreement_id).eq("kind", "escrow");
        accounts.push(...(esc ?? []));
      }
    }
    const kind = Object.fromEntries(accounts.map((x) => [x.id, x.kind]));
    const balances: Record<string, number> = {};
    for (const x of accounts) balances[`${x.kind}${x.kind === "escrow" ? ":" + a.agreement_id?.slice(0, 8) : ""}`] = await rpc<number>("account_balance", { p_account: x.id });
    let q = db.from("ledger_entries").select("created_at,account_id,amount_cents,kind,reason,evidence").in("account_id", accounts.map((x) => x.id)).order("id", { ascending: false }).limit(a.limit);
    if (a.agreement_id) q = q.eq("agreement_id", a.agreement_id);
    const { data } = await q;
    const entries = (data ?? []).map((e: Row) => ({ at: e.created_at, account: kind[e.account_id], cents: e.amount_cents, kind: e.kind, reason: e.reason, evidence: e.evidence }));
    return { data: { balances_cents: balances, entries } };
  });

  return { topupWallet };
}
