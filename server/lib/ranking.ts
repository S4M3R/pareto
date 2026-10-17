import { store } from "./store.js";
import type { Benchmark, Constraints, Run, Tool } from "./types.js";

export interface Row {
  rank: number;
  tool_id: string;
  name: string;
  type: Tool["type"];
  quality: number;
  ci: [number, number];
  n: number;
  cost_per_1k: number;
  p50_ms: number;
  p95_ms: number;
  verified: boolean;
  tied_with_previous: boolean;
}

/** Searchable/listed: public benchmarks, plus your own. Unlisted and private never appear in search. */
export function canSee(b: Benchmark, owner: string): boolean {
  return b.visibility === "public" || b.owner === owner;
}

export function canRead(b: Benchmark, owner: string): boolean {
  // Unlisted benchmarks can be read by anyone who has the id, but never searched.
  return b.visibility !== "private" || b.owner === owner;
}

/** Latest verified test-split run per tool for a benchmark. Self-reported runs are excluded unless asked for. */
export function latestRuns(benchmarkId: string, includeUnverified = false, viewer?: string): Run[] {
  const best = new Map<string, Run>();
  for (const r of store.runs()) {
    if (r.benchmark_id !== benchmarkId || r.split !== "test") continue;
    if (!includeUnverified && !r.verified) continue;
    if (!r.published && r.owner !== viewer) continue;
    const prev = best.get(r.tool_id);
    if (!prev || prev.created_at < r.created_at) best.set(r.tool_id, r);
  }
  return [...best.values()];
}

export function leaderboard(benchmarkId: string, c: Constraints = {}, includeUnverified = false, viewer?: string): Row[] {
  const rows: Row[] = [];
  for (const r of latestRuns(benchmarkId, includeUnverified, viewer)) {
    const tool = store.tool(r.tool_id);
    if (!tool) continue;
    if (c.tool_types && !c.tool_types.includes(tool.type)) continue;
    if (c.min_quality !== undefined && r.quality < c.min_quality) continue;
    if (c.max_cost_per_1k !== undefined && r.cost_per_1k > c.max_cost_per_1k) continue;
    if (c.max_p95_ms !== undefined && r.p95_ms > c.max_p95_ms) continue;
    rows.push({
      rank: 0,
      tool_id: tool.id,
      name: tool.name,
      type: tool.type,
      quality: round(r.quality),
      ci: [round(r.ci_low), round(r.ci_high)],
      n: r.n,
      cost_per_1k: r.cost_per_1k,
      p50_ms: Math.round(r.p50_ms),
      p95_ms: Math.round(r.p95_ms),
      verified: r.verified,
      tied_with_previous: false,
    });
  }
  rows.sort((a, b) => b.quality - a.quality || a.cost_per_1k - b.cost_per_1k);
  rows.forEach((row, i) => {
    row.rank = i + 1;
    // Overlapping 95% intervals with the row above: report a statistical tie instead of a false order.
    if (i > 0) row.tied_with_previous = row.ci[1] >= rows[i - 1].ci[0];
  });
  return rows;
}

const round = (x: number) => Math.round(x * 1000) / 1000;
