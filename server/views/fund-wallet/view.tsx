import type { RequestFundsData } from "../../lib/schemas.js";
import { FundCard } from "../_ui/fund.js";
import { Shell, SkeletonCard } from "../_ui/kit.js";

export default function FundWalletView() {
  return <Shell<RequestFundsData> skeleton={<SkeletonCard lines={4} />}>{(d) => <FundCard d={d} />}</Shell>;
}
