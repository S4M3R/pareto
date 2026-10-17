import type { Benchmark } from "./types.js";

const STOP = new Set(["the", "a", "an", "of", "to", "for", "and", "or", "in", "on", "is", "my", "i", "need", "that", "with", "from"]);
const tokens = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter((t) => t.length > 2 && !STOP.has(t));

export interface Match {
  benchmark_id: string;
  title: string;
  match_confidence: number;
  why: string;
}

/** Lexical match on task text + overlap of sample inputs with the benchmark's dev examples.
 * Swap for embeddings later; the contract (a confidence in 0..1 and a reason) stays the same. */
export function matchBenchmarks(task: string, samples: string[], candidates: Benchmark[]): Match[] {
  const q = new Set(tokens(task));
  const sampleTokens = new Set(samples.flatMap(tokens));
  return candidates
    .map((b) => {
      const doc = new Set(tokens(`${b.title} ${b.task} ${b.category} ${b.labels.join(" ")}`));
      const taskHits = [...q].filter((t) => doc.has(t));
      const devTokens = new Set(b.dev.slice(0, 200).flatMap((e) => tokens(e.input)));
      const sampleHits = [...sampleTokens].filter((t) => devTokens.has(t));
      const taskScore = q.size ? taskHits.length / q.size : 0;
      const sampleScore = sampleTokens.size ? sampleHits.length / sampleTokens.size : 0;
      const score = samples.length ? 0.5 * taskScore + 0.5 * sampleScore : taskScore;
      return {
        benchmark_id: b.id,
        title: b.title,
        match_confidence: Math.round(Math.min(1, score) * 100) / 100,
        why: `task terms matched: [${taskHits.slice(0, 6).join(", ")}]` +
          (samples.length ? `; ${Math.round(sampleScore * 100)}% of your sample vocabulary appears in this benchmark's dev examples` : ""),
      };
    })
    .filter((m) => m.match_confidence > 0)
    .sort((a, b) => b.match_confidence - a.match_confidence);
}
