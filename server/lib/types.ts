export type ToolType = "model" | "harness" | "agent" | "devtool" | "mcp";
export type Visibility = "public" | "private" | "unlisted";
export type Split = "dev" | "test";

export interface Tool {
  id: string;
  name: string;
  type: ToolType;
  provider: string;
  description: string;
  /** Estimated list price for 1,000 calls on a typical request; recomputed from measured tokens when run. */
  est_cost_per_1k: number | null;
  integration: string;
  seeded: boolean;
  owner: string;
}

export interface Example {
  input: string;
  label: string;
}

export interface Benchmark {
  id: string;
  title: string;
  task: string;
  category: string;
  visibility: Visibility;
  owner: string;
  metric: "accuracy";
  labels: string[];
  dev: Example[];
  /** Held server-side. Never returned by any tool. */
  test: Example[];
  fingerprint: string;
  created_at: string;
  forked_from?: string;
}

export interface Run {
  id: string;
  benchmark_id: string;
  tool_id: string;
  split: Split;
  /** true = the platform executed the tool; false = numbers supplied by the owner. */
  verified: boolean;
  n: number;
  quality: number;
  ci_low: number;
  ci_high: number;
  cost_per_1k: number;
  p50_ms: number;
  p95_ms: number;
  error_rate: number;
  owner: string;
  published: boolean;
  created_at: string;
}

export interface Constraints {
  min_quality?: number;
  max_cost_per_1k?: number;
  max_p95_ms?: number;
  tool_types?: ToolType[];
}
