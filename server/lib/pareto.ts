/** Pareto analysis over providers: maximize quality, minimize price. A provider is on the frontier when no other
 * provider is at least as good on both and strictly better on one. Dominance by point estimate can be noise, so
 * `confidently_dominated` also asks that the dominator's 95% interval sits wholly above this one's. */
export interface Scored {
  id: string;
  price: number;
  quality: number;
  ci_low: number;
  ci_high: number;
}

export interface Verdict {
  on_frontier: boolean;
  dominated_by: string | null;
  confidently_dominated: boolean;
}

export function analyze(points: Scored[]): Map<string, Verdict> {
  const out = new Map<string, Verdict>();
  for (const p of points) {
    const doms = points.filter(
      (q) => q.id !== p.id && q.price <= p.price && q.quality >= p.quality && (q.price < p.price || q.quality > p.quality),
    );
    // name the cheapest dominator, then the best one, so the explanation is stable
    const by = [...doms].sort((a, b) => a.price - b.price || b.quality - a.quality)[0];
    out.set(p.id, {
      on_frontier: doms.length === 0,
      dominated_by: by?.id ?? null,
      confidently_dominated: doms.some((q) => q.ci_low > p.ci_high),
    });
  }
  return out;
}

/** The pick for a buyer who gave constraints: on a budget, the best quality on the frontier; with a quality floor, the
 * cheapest frontier provider (all candidates already satisfy the constraints). No constraints, no pick: the frontier
 * is the shortlist and the choice is the buyer's. */
export function recommend(frontier: Scored[], c: { min_quality?: number; max_price_cents?: number }): { id: string; reason: string } | null {
  if (frontier.length === 0) return null;
  if (c.min_quality !== undefined) {
    const p = [...frontier].sort((a, b) => a.price - b.price || b.quality - a.quality)[0];
    return { id: p.id, reason: `Cheapest provider on the frontier that clears your quality floor of ${c.min_quality}.` };
  }
  if (c.max_price_cents !== undefined) {
    const p = [...frontier].sort((a, b) => b.quality - a.quality || a.price - b.price)[0];
    return { id: p.id, reason: `Highest quality on the frontier within your budget of ${c.max_price_cents}c per call.` };
  }
  return null;
}
