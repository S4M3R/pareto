import type { AgreementData } from "../../lib/schemas.js";
import { AgreementView } from "../_ui/agreement.js";
import { Shell, SkeletonCard } from "../_ui/kit.js";

export default function AgreementCard() {
  return <Shell<AgreementData> skeleton={<SkeletonCard lines={5} />}>{(d) => <AgreementView initial={d} />}</Shell>;
}
