const STOP = new Set(["the", "and", "for", "that", "with", "from", "need", "needs", "this", "have", "can", "are", "get", "into", "pages", "page"]);
const tokens = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter((t) => t.length > 2 && !STOP.has(t));
const stem = (t: string) => t.replace(/(ing|ed|es|s)$/, "");

export interface BenchRow { id: string; slug: string; title: string; task: string; category: string; dev_examples: unknown }

export function matchBenchmarks(task: string, samples: string[], rows: BenchRow[]) {
  const q = new Set(tokens(task).map(stem));
  const sampleTokens = new Set(samples.flatMap(tokens).map(stem));
  return rows
    .map((b) => {
      const doc = new Set(tokens(`${b.title} ${b.task} ${b.category}`).map(stem));
      const examples = JSON.stringify(b.dev_examples ?? []);
      const devTokens = new Set(tokens(examples).map(stem));
      const hits = [...q].filter((t) => doc.has(t));
      const sHits = [...sampleTokens].filter((t) => devTokens.has(t));
      const taskScore = q.size ? hits.length / q.size : 0;
      const sampleScore = sampleTokens.size ? sHits.length / sampleTokens.size : 0;
      const score = samples.length ? 0.6 * taskScore + 0.4 * sampleScore : taskScore;
      return {
        benchmark_id: b.id, slug: b.slug, title: b.title,
        match_confidence: Math.round(Math.min(1, score) * 100) / 100,
        why: `matched task terms [${hits.slice(0, 6).join(", ")}]` + (samples.length ? `; ${Math.round(sampleScore * 100)}% of your sample vocabulary appears in its dev examples` : ""),
      };
    })
    .filter((m) => m.match_confidence > 0)
    .sort((a, b) => b.match_confidence - a.match_confidence);
}
