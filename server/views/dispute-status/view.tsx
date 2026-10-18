import type { GetDisputeData } from "../../lib/schemas.js";
import { DisputePanel } from "../_ui/dispute.js";
import { Shell, SkeletonCard } from "../_ui/kit.js";

export default function DisputeStatus() {
  return <Shell<GetDisputeData> skeleton={<SkeletonCard lines={4} />}>{(d) => <DisputePanel initial={d} />}</Shell>;
}
