import { useModelContext, useViewState } from "mcp-use/react";
import { useCallback, useEffect, useState } from "react";
import type { RequestFundsData, TopupData } from "../../lib/schemas.js";
import { useToolCaller } from "./hooks.js";
import { Card, ErrorCard, GrainCircle, Money, Pill, Row, Rows, errorParts, money, shortId, useFollowUp } from "./kit.js";

type Saved = { amount?: number; key: string; done?: TopupData & { added: number }; mode?: "more" };

/** The wallet as it is now. The card is drawn from the result of the call that opened it, so when you come back to a chat
 * (or approve on the web page) its own numbers are old; this asks the server again on load, when you return to the
 * window, and every few seconds while it is open. */
function useLiveWallet() {
  const balance = useToolCaller<{ wallet_cents: number }>("wallet_balance");
  const [live, setLive] = useState<number>();
  const call = balance.call;
  const check = useCallback(async () => {
    try {
      const r = await call({});
      if (r && typeof r.wallet_cents === "number") setLive(r.wallet_cents);
    } catch {
      /* keep what we last knew */
    }
  }, [call]);
  useEffect(() => {
    void check();
    const again = () => { if (!document.hidden) void check(); };
    window.addEventListener("focus", again);
    document.addEventListener("visibilitychange", again);
    const id = setInterval(again, 5000);
    return () => {
      window.removeEventListener("focus", again);
      document.removeEventListener("visibilitychange", again);
      clearInterval(id);
    };
  }, [check]);
  return live;
}

export function FundCard({ d }: { d: RequestFundsData }) {
  const [saved, setSaved] = useViewState<Saved>({ key: crypto.randomUUID() });
  const topup = useToolCaller<TopupData>("topup_wallet");
  const follow = useFollowUp();
  const context = useModelContext();
  const [told, setTold] = useState(false);
  const [failure, setFailure] = useState<Error>();
  const live = useLiveWallet();
  const wallet = live ?? d.wallet_cents;
  const amount = saved.amount ?? d.suggested_cents;
  const short = d.needed_cents != null && d.needed_cents > wallet ? d.needed_cents - wallet : 0;
  // Funds were added since this card was shown (on the approval page, or from another card): show that, not the add screen.
  const addedElsewhere = !saved.done && saved.mode !== "more" && live !== undefined && live > d.wallet_cents;
  const finished = saved.done ?? (addedElsewhere ? { rail: d.rail, ref: "", wallet_cents: live!, added: live! - d.wallet_cents } : undefined);
  const addMore = () => setSaved({ key: crypto.randomUUID(), mode: "more" });
  const rail = d.rail === "stripe-test" ? "Stripe test card · Visa 4242" : "Mock rail (no Stripe key set)";

  if (finished) {
    const done = finished;
    return (
      <Card tone="mint">
        <div className="pv-hero">
          <span className="pv-glow" style={{ ["--glow" as string]: "var(--pv-mint)" }}>
            <GrainCircle seed={`${d.handle}-done`} palette="mint" icon="check" size={56} />
          </span>
          <h2>{money(done.added)} added</h2>
          <p className="pv-muted" style={{ fontSize: 13 }}>
            Available now. Balance <span className="pv-mono" style={{ color: "var(--pv-text)" }}>{money(done.wallet_cents)}</span>
          </p>
        </div>
        <div className="pv-callout" style={{ margin: "16px 0 0" }}>
          <div className="pv-row" style={{ gap: 12 }}>
            <span>Wallet funded</span>
            <Money cents={done.added} sign tone="plus" />
          </div>
          <div className="pv-faint pv-mono" style={{ fontSize: 11.5, marginTop: 4 }}>
            {done.ref ? `${done.rail} · ${shortId(done.ref.replace(/^[a-z-]+:/, ""))}… · just now` : "Balance updated · just now"}
          </div>
        </div>
        <p className="pv-muted" style={{ fontSize: 13, marginTop: 14 }}>
          {told ? "Your agent knows. Say “continue” in the chat." : "Say “continue” in the chat and your agent will pick up from here."}
        </p>
        <div className="pv-actions">
          <button className="pv-btn" onClick={addMore}>Add more money</button>
          {follow.available && (
            /* Sending a message on the user's behalf makes the host ask for confirmation; the note above needs none. */
            <button className="pv-btn ghost" disabled={follow.sent} onClick={() => void follow.ask(`I added ${money(done.added)} to the wallet (balance ${money(done.wallet_cents)}). Please continue.`)}>
              {follow.sent ? "Sent" : "Or send “continue” for me"}
            </button>
          )}
        </div>
      </Card>
    );
  }

  const run = async () => {
    setFailure(undefined);
    try {
      const r = await topup.call({ amount_cents: amount, idempotency_key: saved.key });
      setSaved({ ...saved, done: { ...r, added: amount } });
      // Tell the agent quietly (no prompt, no confirmation): it reads this with the user's next message. This must never
      // affect the payment, which has already succeeded, so it is isolated: a host that cannot take context is fine.
      void (async () => {
        try {
          await context.add("wallet-topup", { type: "text", text: `The human approved and added ${money(amount)} to the wallet (balance now ${money(r.wallet_cents)}). Retry whatever needed the funds, e.g. fund_escrow.` });
          setTold(true);
        } catch {
          /* the note on the card asks the user to say "continue" */
        }
      })();
    } catch (e) {
      setFailure(e as Error);
    }
  };

  return (
    <Card title="Add funds to wallet" subtitle={`${d.handle} · confirmed by you`} seed={`${d.handle}-wallet`} palette="peri" icon="wallet" right={<Pill>test mode</Pill>}>
      {(short > 0 || d.reason) && (
        <div className="pv-callout" data-tone="amber" style={{ marginBottom: 14 }}>
          {short > 0 && <><b>{money(d.needed_cents!)}</b> is needed and the wallet has <b>{money(d.wallet_cents)}</b>. </>}
          {d.reason}
        </div>
      )}
      <div className="pv-balance">
        <div>
          <div className="pv-label">Wallet balance</div>
          <Money cents={wallet} big />
        </div>
        <span className="pv-delta">+ {money(amount)}</span>
      </div>
      <div className="pv-presets" data-locked={topup.isPending} role="group" aria-label="Amount to add">
        {d.presets_cents.map((c) => (
          <button key={c} className="pv-preset" aria-pressed={c === amount} onClick={() => setSaved({ ...saved, amount: c })}>
            {money(c).replace(/\.00$/, "")}
          </button>
        ))}
      </div>
      <div style={{ marginTop: 16 }}>
        <Rows>
          <Row label={rail}>{d.rail === "stripe-test" ? "Stripe" : "mock"}</Row>
          <Row label="Processing fee"><Money cents={0} /></Row>
          <Row label="New balance" total><Money cents={wallet + amount} /></Row>
        </Rows>
      </div>
      {failure && <div style={{ marginTop: 14 }}><ErrorCard error={failure} title={errorParts(failure).code ?? "Payment failed"} /></div>}
      <div className="pv-actions">
        <button className="pv-btn" disabled={topup.isPending || amount <= 0 || amount > d.max_topup_cents} onClick={() => void run()}>
          {topup.isPending ? "Adding…" : failure ? `Retry ${money(amount)}` : `Add ${money(amount)}`}
        </button>
      </div>
      <p className="pv-faint" style={{ fontSize: 11.5, lineHeight: 1.5, marginTop: 12 }}>
        Held in your Pareto ledger. It moves to escrow only when you fund an agreement, within the cap your spending policy allows. Test mode: no real money.
      </p>
    </Card>
  );
}

