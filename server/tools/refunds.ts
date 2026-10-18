import { z } from "zod";
import { usd } from "../lib/format.js";
import { ListRefundRequestsOut } from "../lib/schemas.js";
import { appealRefund, decideRefund, listRefunds, requestRefund } from "../lib/refunds.js";
import { type AnyServer, defineTool } from "./define.js";

/** Refund requests: the provider decides first, the platform decides on appeal. Same logic as the REST endpoints in
 * lib/api-refunds.ts. A held charge is not released by the sweep and close_task refuses while a request is open. */
export function registerRefunds(server: AnyServer) {
  defineTool(server, {
    name: "request_refund",
    description: "Buyer: ask for ONE call's charge back, with a reason. Unlike file_dispute, the provider answers first: they approve (refunded from escrow right away) or reject (you may then appeal_refund and the platform decides on the recorded trace). The charge must still be pending, inside the check window. The charge is held until the request is settled.",
    input: z.object({ charge_id: z.string().uuid(), reason: z.string().min(3).max(500) }),
    role: "buyer",
  }, async (a, agent) => {
    const r = await requestRefund(agent!, { chargeId: a.charge_id, reason: a.reason });
    return { data: { ...r }, next: "The provider has been asked. list_refunds shows the answer; if it is rejected you can appeal_refund.", say: `Refund requested for ${usd(r.amount_cents)}. Waiting for the provider. Reply in one short sentence.` };
  });

  defineTool(server, {
    name: "appeal_refund",
    description: "Buyer: appeal a rejected refund. The platform reviews it against the recorded call and the agreement's reference answer, and the result is final: refunded_on_appeal or denied_on_appeal. Inputs without a reference answer (an image URL or your own upload) cannot be verified, so the provider's decision stands.",
    input: z.object({ refund_id: z.string().uuid(), note: z.string().max(300).optional() }),
    role: "buyer",
    destructive: true,
  }, async (a, agent) => {
    const r = await appealRefund(agent!, { refundId: a.refund_id, note: a.note });
    return { data: { ...r }, next: r.status === "refunded_on_appeal" ? "Refunded. Continue, or close_task." : "The decision is final. Continue, or close_task.", say: `Appeal ${r.status === "refunded_on_appeal" ? "upheld: refunded" : "denied"}. ${r.final?.reasoning ?? ""} Reply in one short sentence.` };
  });

  defineTool(server, {
    name: "list_refunds",
    description: "Refund requests you are party to (as buyer or provider), newest first, with status, the call's answer, the reason and the final reasoning. Optionally limit to one agreement.",
    input: z.object({ agreement_id: z.string().uuid().optional() }),
    readOnly: true,
  }, async (a, agent) => {
    const refunds = await listRefunds(agent!, { agreementId: a.agreement_id });
    const open = refunds.filter((r) => r.status === "awaiting_provider" || r.status === "under_review").length;
    return { images: refunds.filter((r) => r.image_id).map((r) => ({ id: r.image_id as string, caption: `Photo for call #${r.call_seq} (${r.status.replace(/_/g, " ")}): the model answered ${r.answered.label ?? "nothing"}.` })), data: { refunds, count: refunds.length, open }, next: refunds.some((r) => r.status === "rejected") ? "A rejected refund can be appealed with appeal_refund." : open ? "Waiting on the provider; check again shortly." : "Nothing is waiting." };
  });

  defineTool(server, {
    name: "list_refund_requests",
    description: "Provider: refund requests buyers have made on your deals that wait for your decision (status awaiting_provider), with the image, what your model answered and the buyer's reason. Answer each with decide_refund.",
    input: z.object({}),
    role: "provider",
    readOnly: true,
    show: {
      name: "show_refund_requests",
      description: "Display only: shows the provider a card for each refund request waiting for them, with the photo, what their model answered and the buyer's reason, and Approve and Reject buttons. Use it when the human should decide. To read the requests yourself use list_refund_requests.",
      view: { name: "refund-requests", description: "Refund requests waiting for the provider, with Approve and Reject" },
      output: ListRefundRequestsOut,
    },
  }, async (_a, agent) => {
    const refunds = await listRefunds(agent!, { as: "provider", status: "awaiting_provider" });
    return { images: refunds.filter((r) => r.image_id).map((r) => ({ id: r.image_id as string, caption: `Photo for call #${r.call_seq}: the model answered ${r.answered.label ?? "nothing"}; the buyer says "${r.claim.reason}".` })), data: { refunds, count: refunds.length }, next: refunds.length ? "decide_refund with approve or reject for each." : "Nothing is waiting for you." };
  });

  defineTool(server, {
    name: "decide_refund",
    description: "Provider: approve a refund request (the charge returns to the buyer from escrow now) or reject it (the buyer may appeal, and the platform then decides on the recorded call). Be honest: a rejected request that was right costs you on appeal.",
    input: z.object({ refund_id: z.string().uuid(), decision: z.enum(["approve", "reject"]), note: z.string().max(300).optional() }),
    role: "provider",
    destructive: true,
  }, async (a, agent) => {
    const r = await decideRefund(agent!, { refundId: a.refund_id, decision: a.decision, note: a.note });
    return { data: { ...r }, next: a.decision === "approve" ? "Refunded from escrow." : "Rejected. The buyer may appeal; the platform then decides.", say: `Refund ${a.decision === "approve" ? "approved" : "rejected"}. Reply in one short sentence.` };
  });
}
