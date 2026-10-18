import type { CompareProvidersData } from "../../lib/schemas.js";
import { Pill } from "./kit.js";

type Owner = NonNullable<CompareProvidersData["benchmark"]["owner"]>;

/** Who made this benchmark, said plainly. A stranger's small benchmark should not be mistaken for an established one. */
export function OwnerLine({ owner, n }: { owner?: Owner; n?: number }) {
  if (!owner) return null;
  const fresh = owner.settled_agreements === 0 && !owner.platform;
  const deals = owner.platform ? "platform benchmark" : fresh ? "new account, no settled deals" : `${owner.settled_agreements} settled deal${owner.settled_agreements === 1 ? "" : "s"}`;
  const pubs = `${owner.benchmarks_published} benchmark${owner.benchmarks_published === 1 ? "" : "s"} published`;
  return (
    <div className="pv-tags" style={{ margin: "0 0 12px" }}>
      <Pill tone={fresh ? "amber" : "neutral"}>by {owner.handle} · {deals}</Pill>
      <Pill>{pubs}</Pill>
      {n !== undefined && n < 50 && <Pill tone="amber">small test set (n={n}): wide intervals</Pill>}
    </div>
  );
}
