import { createHash } from "node:crypto";
import { type Capability, capabilityFor } from "./capabilities.js";

/** Acceptance evals written into the agreement. The platform runs them on every call (cheap checks) or on a
 * deterministic sample (ground-truth checks), and re-runs all of them, unsampled, to resolve a dispute. */
export type EvalSpec =
  | { type: "schema" }
  | { type: "latency"; max_ms: number }
  | { type: "billing_matches" }
  | { type: "field_accuracy"; min: number; sample_rate?: number };

export interface Trace {
  request: Record<string, unknown>;
  response: Record<string, unknown> | null;
  status: number;
  latency_ms: number;
  units_measured: number;
}

export interface EvalOutcome {
  type: EvalSpec["type"];
  ran: boolean;
  passed: boolean;
  detail: string;
  value?: number;
}

const h01 = (s: string) => parseInt(createHash("sha1").update(s).digest("hex").slice(0, 8), 16) / 0xffffffff;

export function runEvals(specs: EvalSpec[], t: Trace, forceSample = false, capability?: string): EvalOutcome[] {
  const cap: Capability = capabilityFor(capability);
  const fields = cap.fieldsOf(t.response);
  return specs.map((s): EvalOutcome => {
    switch (s.type) {
      case "schema": {
        const missing = cap.missing(fields);
        const passed = t.status === 200 && missing.length === 0;
        return { type: "schema", ran: true, passed, detail: passed ? "all fields present" : t.status !== 200 ? `HTTP ${t.status}` : `missing: ${missing.join(", ")}` };
      }
      case "latency": {
        const passed = t.latency_ms <= s.max_ms;
        return { type: "latency", ran: true, passed, value: t.latency_ms, detail: `${t.latency_ms} ms vs SLA ${s.max_ms} ms` };
      }
      case "billing_matches": {
        const billed = Number(t.response?.units_billed ?? 0);
        const passed = billed === t.units_measured;
        return { type: "billing_matches", ran: true, passed, value: billed, detail: `provider billed ${billed} unit(s); platform measured ${t.units_measured}` };
      }
      case "field_accuracy": {
        const rate = s.sample_rate ?? 1;
        const sampled = forceSample || rate >= 1 || h01(`sample:${JSON.stringify(t.request)}`) < rate;
        if (!sampled) return { type: "field_accuracy", ran: false, passed: true, detail: "not sampled" };
        const r = cap.check(t.request, fields);
        if (!r) return { type: "field_accuracy", ran: false, passed: true, detail: "no reference answer for this input" };
        const passed = r.accuracy >= s.min;
        return {
          type: "field_accuracy", ran: true, passed, value: r.accuracy,
          detail: passed ? `field accuracy ${r.accuracy.toFixed(2)} >= ${s.min}` : `field accuracy ${r.accuracy.toFixed(2)} < ${s.min}; wrong: ${r.wrong.join(", ")}`,
        };
      }
    }
  });
}

export const failed = (o: EvalOutcome[]) => o.filter((x) => x.ran && !x.passed);
