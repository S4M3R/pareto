import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Benchmark, Example, Run, Tool, Visibility } from "./types.js";

const FILE = process.env.STORE_FILE ?? "data/store.json";

interface Db {
  tools: Tool[];
  benchmarks: Benchmark[];
  runs: Run[];
}

let db: Db = existsSync(FILE)
  ? (JSON.parse(readFileSync(FILE, "utf8")) as Db)
  : { tools: [], benchmarks: [], runs: [] };

function save() {
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(db));
}

export const id = (prefix: string) => `${prefix}_${randomUUID().slice(0, 8)}`;

const norm = (s: string) => s.toLowerCase().replace(/\W+/g, " ").trim();

/** Deterministic 0..1 bucket so a given input always lands on the same side of the split. */
function bucket(text: string): number {
  return parseInt(createHash("sha1").update(norm(text)).digest("hex").slice(0, 8), 16) / 0xffffffff;
}

export function splitExamples(examples: Example[], testFrac: number): { dev: Example[]; test: Example[] } {
  const seen = new Set<string>();
  const dev: Example[] = [];
  const test: Example[] = [];
  for (const ex of examples) {
    const key = norm(ex.input);
    if (seen.has(key)) continue; // duplicates can never straddle the split
    seen.add(key);
    (bucket(ex.input) < testFrac ? test : dev).push(ex);
  }
  return { dev, test };
}

export function fingerprint(test: Example[]): string {
  const h = createHash("sha256");
  for (const ex of [...test].sort((a, b) => a.input.localeCompare(b.input))) h.update(ex.input + "\u0000" + ex.label + "\u0001");
  return h.digest("hex").slice(0, 16);
}

export const store = {
  tools: () => db.tools,
  benchmarks: () => db.benchmarks,
  runs: () => db.runs,
  tool: (toolId: string) => db.tools.find((t) => t.id === toolId),
  benchmark: (benchId: string) => db.benchmarks.find((b) => b.id === benchId),
  addTool(t: Tool) {
    db.tools = db.tools.filter((x) => x.id !== t.id).concat(t);
    save();
  },
  addBenchmark(b: Benchmark) {
    db.benchmarks = db.benchmarks.filter((x) => x.id !== b.id).concat(b);
    save();
  },
  addRun(r: Run) {
    db.runs.push(r);
    save();
  },
  setBenchmarkVisibility(benchId: string, v: Visibility) {
    const b = this.benchmark(benchId);
    if (b) b.visibility = v;
    save();
  },
  setRunPublished(runId: string, published: boolean) {
    const r = db.runs.find((x) => x.id === runId);
    if (r) r.published = published;
    save();
  },
  reset() {
    db = { tools: [], benchmarks: [], runs: [] };
    save();
  },
};
