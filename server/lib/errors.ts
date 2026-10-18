/** Every failure carries a stable code and a fix the calling agent can act on. */
export class MarketError extends Error {
  constructor(public code: string, message: string, public fix?: string, public details?: Record<string, unknown>) {
    super(message);
  }
}

const FIXES: Record<string, string> = {
  insufficient_funds: "Call show_topup_card (it opens the add-funds card for your human, who clicks to approve; you never move money), then retry fund_escrow. Keep your reply to one short sentence.",
  wrong_status: "Call get_agreement to see the current status and what has to happen next.",
  budget_exceeded: "Budget cap reached. Close the task with close_task, or open a new agreement with a higher budget_cap_cents.",
  not_active: "The agreement is not active. Call get_agreement; it must be funded (status active) to use the provider.",
  outside_window: "Micro disputes need a charge still inside its check window. Use file_dispute with scope 'full' instead.",
  open_dispute: "Resolve the open dispute first (get_dispute shows its state).",
  unknown_agreement: "Check the agreement_id; list yours with get_agreement.",
  unknown_charge: "Check the charge_id from list_calls.",
  cannot_refund: "That charge was already settled.",
};

export function fixFor(code: string): string | undefined {
  return FIXES[code];
}

/** Postgres `raise exception 'code: detail'` -> MarketError. */
export function fromPg(message: string): MarketError {
  const m = /^([a-z_]+):\s*(.*)$/s.exec(message);
  if (m && FIXES[m[1]]) return new MarketError(m[1], m[2] || message, FIXES[m[1]]);
  return new MarketError("database_error", message);
}
