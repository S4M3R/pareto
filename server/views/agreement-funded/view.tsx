import { ToolError } from "mcp-use/react";
import type { FundEscrowData, RequestFundsData } from "../../lib/schemas.js";
import { AgreementView } from "../_ui/agreement.js";
import { FundCard } from "../_ui/fund.js";
import { Icon, Money, Pill, Shell, SkeletonCard } from "../_ui/kit.js";

/** An empty wallet is not a dead end: show the add-funds card where the error would be. */
function topupFromError(e: unknown) {
  const sc = e instanceof ToolError ? (e.result.structuredContent as { code?: string; details?: RequestFundsData } | undefined) : undefined;
  return sc?.code === "insufficient_funds" && sc.details?.presets_cents ? <FundCard d={sc.details} /> : undefined;
}

export default function AgreementFunded() {
  return (
    <Shell<FundEscrowData> skeleton={<SkeletonCard lines={5} />} onError={topupFromError}>
      {(d) => (
        <AgreementView
          initial={d}
          extra={
            <>
              <hr className="pv-divider" />
              <div className="pv-callout" data-tone="mint">
                <b><Money cents={d.escrow_cents} /></b> is held in escrow. Wallet left: <Money cents={d.wallet_cents} />. Each call is released to the provider only after its checks pass.
              </div>
              <div style={{ marginTop: 14 }}>
                <div className="pv-label" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><Icon name="shield" size={13} /> Access grant</span>
                  <Pill tone="amber">shown once</Pill>
                </div>
                <div className="pv-rows">
                  <div className="pv-row"><span>Gateway</span><b className="pv-code">{d.access.gateway_url}</b></div>
                  <div className="pv-row"><span>Header</span><b className="pv-code">{d.access.header}: {d.access.grant_key}</b></div>
                  <div className="pv-row"><span>Expires</span><b>{new Date(d.access.expires_at).toLocaleString()}</b></div>
                </div>
              </div>
            </>
          }
        />
      )}
    </Shell>
  );
}
