import { useState } from "react";
import type { DecideRefundData, ListRefundRequestsData } from "../../lib/schemas.js";
import { ErrorCard, Card, Pill, Shell, SkeletonCard, money, pct } from "../_ui/kit.js";
import { usePolledTool, useToolCaller } from "../_ui/hooks.js";

type Req = ListRefundRequestsData["refunds"][number];
type Done = "approve" | "reject";

const said = (label: string | null) => (label === "hotdog" ? "a hot dog" : label === "not_hotdog" ? "not a hot dog" : label ?? "nothing");

function Request({ r }: { r: Req }) {
  const decide = useToolCaller<DecideRefundData>("decide_refund");
  const [note, setNote] = useState("");
  const [done, setDone] = useState<Done>();
  const [err, setErr] = useState<Error>();
  const answer = async (decision: Done) => {
    setErr(undefined);
    try {
      await decide.call({ refund_id: r.refund_id, decision, ...(note.trim() ? { note: note.trim() } : {}) });
      setDone(decision);
    } catch (e) {
      setErr(e as Error);
    }
  };
  return (
    <Card
      title={`Call #${r.call_seq ?? "?"}`}
      subtitle={`${r.buyer ?? "a buyer"} asks for ${money(r.amount_cents)} back`}
      seed={r.refund_id}
      palette={done === "approve" ? "mint" : done === "reject" ? "terra" : "sand"}
      icon="inbox"
      right={done ? <Pill tone={done === "approve" ? "mint" : "terra"}>{done === "approve" ? "refunded" : "rejected"}</Pill> : <Pill tone="amber">needs you</Pill>}
    >
      {r.image_url && <img src={r.image_url} alt="" style={{ width: "100%", maxHeight: 280, objectFit: "cover", borderRadius: 12, marginBottom: 12, display: "block" }} />}
      <div className="pv-callout">Your model answered <b>{said(r.answered.label)}</b>{r.answered.confidence != null ? ` (${pct(r.answered.confidence)} sure)` : ""}.</div>
      <div className="pv-callout" style={{ marginTop: 8 }}><b>{r.buyer ?? "The buyer"} says:</b> {r.claim.reason}</div>
      {err && <div style={{ marginTop: 12 }}><ErrorCard error={err} title="Could not answer" /></div>}
      {done ? (
        <div className="pv-callout" data-tone={done === "approve" ? "mint" : "terra"} style={{ marginTop: 12 }}>
          {done === "approve" ? <>Refunded. <b>{money(r.amount_cents)}</b> went back to the buyer from escrow.</> : <>Rejected. The buyer can appeal, and Pareto then checks the recorded call against the reference answer.</>}
        </div>
      ) : (
        <>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Note to the buyer (optional)"
            maxLength={300}
            style={{ width: "100%", marginTop: 12, boxSizing: "border-box", padding: "9px 12px", borderRadius: 10, border: "1px solid var(--pv-line)", background: "var(--pv-surface)", color: "var(--pv-text)", font: "inherit", outline: "none" }}
          />
          <div className="pv-actions">
            <button className="pv-btn" disabled={decide.isPending} onClick={() => void answer("approve")}>{decide.isPending ? "Working…" : "Approve refund"}</button>
            <button className="pv-btn ghost" disabled={decide.isPending} onClick={() => void answer("reject")}>Reject</button>
          </div>
        </>
      )}
    </Card>
  );
}

function Requests({ initial }: { initial: ListRefundRequestsData }) {
  // new requests arrive while the card is open; ones already answered stay on screen with their outcome
  const live = usePolledTool<ListRefundRequestsData>("list_refund_requests", {}, true, 3000);
  const [seen] = useState(() => new Map<string, Req>());
  for (const r of [...initial.refunds, ...(live?.refunds ?? [])]) if (!seen.has(r.refund_id)) seen.set(r.refund_id, r);
  const all = [...seen.values()].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  if (all.length === 0)
    return (
      <Card title="No refund requests" subtitle="Nothing is waiting for you" seed="refunds" palette="sand" icon="inbox">
        <div className="pv-callout">When a buyer asks for a refund on one of your calls, it shows up here by itself.</div>
      </Card>
    );
  return <div style={{ display: "grid", gap: 12 }}>{all.map((r) => <Request key={r.refund_id} r={r} />)}</div>;
}

export default function RefundRequests() {
  return (
    <Shell<ListRefundRequestsData> skeleton={<SkeletonCard lines={4} />}>
      {(d) => <Requests initial={d} />}
    </Shell>
  );
}
