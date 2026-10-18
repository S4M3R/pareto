import { z } from "zod";
import { createCardApproval } from "../lib/approvals.js";
import { listCards } from "../lib/cards.js";
import { BASE_URL } from "../lib/env.js";
import { type AnyServer, defineTool } from "./define.js";

const CardOut = z.object({
  id: z.string(), brand: z.string(), last4: z.string(), exp_month: z.number().nullable(), exp_year: z.number().nullable(), is_default: z.boolean(),
});

export function registerCards(server: AnyServer) {
  defineTool(server, {
    name: "add_card",
    description: "Start adding a payment card to this Pareto account. Moves no money and cannot see or enter card details: it returns approval_url, which the HUMAN must open in a browser to add the card on Stripe's own page (test mode: Stripe test cards only). Give the human the link; do not try to add a card yourself. The default card pays for wallet top-ups.",
    input: z.object({}),
    role: "buyer",
    readOnly: true,
    output: z.object({ approval_url: z.string(), handle: z.string(), cards_on_file: z.number(), test_mode: z.boolean(), expires_in_minutes: z.number(), next: z.string().optional() }),
  }, async (_a, agent) => {
    const cards = await listCards(agent!.id);
    const token = createCardApproval({ agentId: agent!.id, handle: agent!.handle });
    const url = `${BASE_URL}/approve/card/${token}`;
    return {
      data: { approval_url: url, handle: agent!.handle, cards_on_file: cards.length, test_mode: !process.env.STRIPE_SECRET_KEY || /_test_/.test(process.env.STRIPE_SECRET_KEY), expires_in_minutes: 30 },
      next: "Ask the human to open approval_url and add the card; then list_cards confirms it.",
      say: `Reply with ONE short sentence giving the human this link to add their card on Stripe: ${url}. Do not ask for or accept card numbers in chat.`,
    };
  });

  defineTool(server, {
    name: "list_cards",
    description: "Cards on file for this account: brand, last four digits, expiry and which is the default. Card numbers are never stored or shown.",
    input: z.object({}),
    role: "buyer",
    readOnly: true,
    output: z.object({ cards: z.array(CardOut), next: z.string().optional() }),
  }, async (_a, agent) => {
    const cards = await listCards(agent!.id);
    return { data: { cards }, next: cards.length ? "Top-ups charge the default card." : "add_card, then give the human the link." };
  });
}
