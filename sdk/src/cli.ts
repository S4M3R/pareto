#!/usr/bin/env node
/** The `pareto` command line. One command today: publish a benchmark from a folder of labelled images and score providers on it.
 *
 *   pareto publish-benchmark ./hotdogs --slug my-hotdogs-v1 --title "My hot dogs" --task "Is it a hot dog?" \
 *     --labels hotdog,not_hotdog --providers bunvision,dogspotter,seefood-lite
 *
 * Images go in `<dir>/<label>/*.jpg`, or `<dir>/<label>__*.jpg`. Env: PARETO_API_KEY, PARETO_URL. */
import { chmod, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { Pareto, ParetoError, type BenchmarkExample, type Score } from "./index.js";

const IMAGE = /\.(jpe?g|png|webp)$/i;

const CONFIG = join(homedir(), ".pareto", "config.json");
const DEFAULT_URL = "https://calm-forge-j3pb5.run.mcp-use.com";

const USAGE = `pareto login --key <api key> [--name <profile>] [--default] [--url <server>]   save an account on this machine (~/.pareto/config.json)
pareto profiles                                    the saved accounts; * is the default
pareto use <profile>                               change the default account
pareto --profile <name> <command>                  run one command as another account
pareto whoami                                      which account and server this machine uses
pareto benchmarks                                  public benchmarks you can choose with or reuse the models of
pareto earnings                                    what your benchmarks earned (5% referrals)
pareto deals [--status active]
pareto publish-benchmark <dir> --slug <slug> --title <title> --labels a,b [--task <task>] [--providers p1,p2 | --providers-from <benchmark>] [--dev-count n]

  <dir>        images in <dir>/<label>/*.jpg, or <dir>/<label>__*.jpg
  --providers  handles of providers whose listing to score (all of them are scored on the hidden test set)
  --providers-from  score the same models that are scored on another benchmark (its slug), e.g. animals-general-v1
Settings: PARETO_API_KEY and PARETO_URL (environment) win over the saved profile (PARETO_PROFILE picks one); the default server is the live one.
From any folder: pareto publish-benchmark ./photos --slug my-bench --title "My bench" --labels cat,dog --providers-from animals-general-v1`;

/** Read the labelled images: a folder per label, or files named `<label>__anything.jpg`. */
async function readExamples(dir: string, labels: string[]): Promise<BenchmarkExample[]> {
  const out: BenchmarkExample[] = [];
  for (const entry of (await readdir(dir)).sort()) {
    const path = join(dir, entry);
    if ((await stat(path)).isDirectory()) {
      if (!labels.includes(entry)) continue;
      for (const f of (await readdir(path)).sort()) if (IMAGE.test(f)) out.push({ label: entry, file: join(path, f) });
    } else if (IMAGE.test(entry) && entry.includes("__")) {
      const label = entry.split("__")[0];
      if (labels.includes(label)) out.push({ label, file: path });
    }
  }
  return out;
}

const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));

async function publish(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      slug: { type: "string" }, title: { type: "string" }, task: { type: "string" }, labels: { type: "string" },
      providers: { type: "string" }, "providers-from": { type: "string" }, "dev-count": { type: "string" }, help: { type: "boolean", short: "h" },
    },
  });
  const dir = positionals[0];
  if (values.help || !dir || !values.slug || !values.title || !values.labels) {
    console.log(USAGE);
    process.exit(values.help ? 0 : 2);
  }
  const labels = values.labels.split(",").map((l) => l.trim()).filter(Boolean);
  const task = values.task ?? `Classify each image as one of: ${labels.join(", ")}.`;
  const pareto = new Pareto();

  const examples = await readExamples(dir, labels);
  const per = labels.map((l) => `${l}: ${examples.filter((e) => e.label === l).length}`).join(", ");
  console.log(`Read ${examples.length} images (${per}).`);
  const bench = await pareto.benchmarks.publish({ slug: values.slug, title: values.title, task, labels, examples, devCount: values["dev-count"] ? Number(values["dev-count"]) : undefined });
  console.log(`Published ${bench.slug}: ${bench.n_test} hidden test images, ${bench.dev_examples} public dev examples.`);

  let wanted = (values.providers ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  if (values["providers-from"]) {
    wanted = [...new Set([...wanted, ...(await pareto.benchmarks.providersOf(values["providers-from"]))])];
    console.log(`Same models as ${values["providers-from"]}: ${wanted.join(", ")}.`);
  }
  const scores: { provider: string; price: number; score?: Score; error?: string }[] = [];
  if (wanted.length) {
    const listings = await pareto.listings.list({ capability: "image-classification" });
    for (const handle of wanted) {
      const l = listings.find((x) => x.provider === handle);
      if (!l) { scores.push({ provider: handle, price: 0, error: "no active listing" }); continue; }
      process.stdout.write(`Scoring ${handle} ... `);
      try {
        const score = await pareto.benchmarks.score(l.listing_id, bench.benchmark_id);
        console.log(`${(score.accuracy * 100).toFixed(1)}%`);
        scores.push({ provider: handle, price: l.price_cents_per_call, score });
      } catch (e) {
        console.log("failed");
        scores.push({ provider: handle, price: l.price_cents_per_call, error: e instanceof ParetoError ? `${e.message}${e.fix ? ` (${e.fix})` : ""}` : String(e) });
      }
    }
    console.log(`\n${pad("provider", 16)}${pad("accuracy", 10)}${pad("95% interval", 16)}${pad("n", 5)}${pad("p95 ms", 8)}price`);
    for (const s of scores) {
      if (!s.score) { console.log(`${pad(s.provider, 16)}${s.error}`); continue; }
      const r = s.score;
      console.log(`${pad(s.provider, 16)}${pad((r.accuracy * 100).toFixed(1) + "%", 10)}${pad(`${(r.ci95[0] * 100).toFixed(0)}-${(r.ci95[1] * 100).toFixed(0)}%`, 16)}${pad(String(r.n), 5)}${pad(String(r.p95_ms), 8)}${s.price}c/call`);
    }
  }
  console.log(`\nShare it: any agent that cites benchmark_id ${bench.benchmark_id} (${bench.slug}) when it hires a provider pays YOU, its author, 5% of what it spends.`);
  console.log(`Your earnings: ${pareto.baseUrl}/console/benchmarks`);
}

async function deals(argv: string[]) {
  const { values } = parseArgs({ args: argv, options: { status: { type: "string" } } });
  const list = await new Pareto().deals.list({ status: values.status });
  if (!list.length) return console.log("No deals.");
  console.log(`${pad("deal", 38)}${pad("status", 10)}${pad("provider", 20)}${pad("price", 12)}${pad("cap", 8)}`);
  for (const d of list) console.log(`${pad(d.deal_id, 38)}${pad(d.status, 10)}${pad(d.provider, 20)}${pad(d.price_cents_per_call + "c/call", 12)}$${(d.cap_cents / 100).toFixed(2)}`);
}

/** Profiles live in ~/.pareto/config.json: { default, profiles: { <name>: { apiKey, url } } }. An old single-account file is read as one profile. */
type Profile = { apiKey: string; url: string };
type Config = { default?: string; profiles: Record<string, Profile> };
async function readConfig(): Promise<Config> {
  try {
    const raw = JSON.parse(await readFile(CONFIG, "utf8")) as Partial<Config> & { apiKey?: string; url?: string };
    if (raw.profiles) return { default: raw.default, profiles: raw.profiles };
    if (raw.apiKey) return { default: "default", profiles: { default: { apiKey: raw.apiKey, url: raw.url ?? DEFAULT_URL } } };
  } catch { /* not logged in */ }
  return { profiles: {} };
}
async function writeConfig(c: Config) {
  await mkdir(dirname(CONFIG), { recursive: true });
  await writeFile(CONFIG, JSON.stringify(c, null, 2) + "\n");
  await chmod(CONFIG, 0o600);
}

/** The profile to use: --profile NAME, else PARETO_PROFILE, else the default. Environment variables PARETO_API_KEY / PARETO_URL still win. */
async function loadConfig(profile?: string) {
  const cfg = await readConfig();
  const name = profile ?? process.env.PARETO_PROFILE ?? cfg.default;
  if (profile && !cfg.profiles[profile]) { console.error(`No profile called '${profile}'. Profiles: ${Object.keys(cfg.profiles).join(", ") || "none (run pareto login)"}`); process.exit(1); }
  const p = name ? cfg.profiles[name] : undefined;
  // only assign real values: process.env turns undefined into the text "undefined"
  if (!process.env.PARETO_API_KEY && p?.apiKey) process.env.PARETO_API_KEY = p.apiKey;
  if (!process.env.PARETO_URL) process.env.PARETO_URL = p?.url || DEFAULT_URL;
}

async function login(argv: string[]) {
  const { values } = parseArgs({ args: argv, options: { key: { type: "string" }, url: { type: "string" }, name: { type: "string" }, default: { type: "boolean" } } });
  if (!values.key) { console.log("Usage: pareto login --key <api key> [--name <profile>] [--default] [--url <server>]"); process.exit(2); }
  const url = (values.url ?? process.env.PARETO_URL ?? DEFAULT_URL).replace(/\/+$/, "");
  const me = await new Pareto({ apiKey: values.key, baseUrl: url }).request<{ owner: string }>("GET", "/api/owner/benchmarks"); // proves the key works
  const cfg = await readConfig();
  const name = values.name ?? me.owner;
  cfg.profiles[name] = { apiKey: values.key, url };
  if (values.default || !cfg.default || !cfg.profiles[cfg.default]) cfg.default = name;
  await writeConfig(cfg);
  console.log(`Saved profile '${name}' (${me.owner} on ${url})${cfg.default === name ? ", now the default" : ""}. File: ${CONFIG}`);
}

async function profiles() {
  const cfg = await readConfig();
  const names = Object.keys(cfg.profiles);
  if (!names.length) return console.log("No profiles. Run: pareto login --key <api key> --default");
  for (const n of names) console.log(`${n === cfg.default ? "*" : " "} ${pad(n, 22)}${cfg.profiles[n].url}`);
  console.log("\n* = default. Use another one for one command: pareto --profile <name> <command>. Change the default: pareto use <name>");
}

async function use(argv: string[]) {
  const cfg = await readConfig();
  const name = argv[0];
  if (!name || !cfg.profiles[name]) { console.log(`Usage: pareto use <profile>. Profiles: ${Object.keys(cfg.profiles).join(", ") || "none"}`); process.exit(2); }
  cfg.default = name;
  await writeConfig(cfg);
  console.log(`Default profile is now '${name}'.`);
}

async function whoami() {
  const pareto = new Pareto();
  if (!process.env.PARETO_API_KEY) { console.log(`Not logged in. Server: ${pareto.baseUrl}\nRun: pareto login --key <api key>`); process.exit(1); }
  const me = await pareto.request<{ owner: string; referral_pct: number; earned_total_cents: number; benchmarks: unknown[] }>("GET", "/api/owner/benchmarks");
  console.log(`${me.owner} on ${pareto.baseUrl} (${me.benchmarks.length} benchmark${me.benchmarks.length === 1 ? "" : "s"} published, $${(me.earned_total_cents / 100).toFixed(2)} earned)`);
}

async function benchmarks() {
  const r = await new Pareto().request<{ benchmarks: { slug: string; title: string; n_test: number; owner?: { handle: string } }[] }>("GET", "/api/benchmarks");
  console.log(`${pad("slug", 24)}${pad("hidden", 8)}${pad("by", 20)}title`);
  for (const b of r.benchmarks) console.log(`${pad(b.slug, 24)}${pad(String(b.n_test), 8)}${pad(b.owner?.handle ?? "", 20)}${b.title}`);
}

async function earnings() {
  const r = await new Pareto().request<{ owner: string; referral_pct: number; earned_total_cents: number; benchmarks: { slug: string; hires: number; agents: number; spend_cents: number; earned_cents: number }[] }>("GET", "/api/owner/benchmarks");
  console.log(`${r.owner}: $${(r.earned_total_cents / 100).toFixed(2)} earned (${r.referral_pct}% of what agents spend on hires that cite your benchmarks)\n`);
  console.log(`${pad("benchmark", 24)}${pad("hires", 8)}${pad("agents", 8)}${pad("spent", 12)}earned`);
  for (const b of r.benchmarks) console.log(`${pad(b.slug, 24)}${pad(String(b.hires), 8)}${pad(String(b.agents), 8)}${pad("$" + (b.spend_cents / 100).toFixed(2), 12)}$${(b.earned_cents / 100).toFixed(2)}`);
}

async function main() {
  const args = process.argv.slice(2);
  // --profile <name> works before or after the command
  let profile: string | undefined;
  const at = args.indexOf("--profile");
  if (at >= 0) { profile = args[at + 1]; args.splice(at, 2); }
  const [cmd, ...rest] = args;
  await loadConfig(profile);
  if (cmd === "login") return login(rest);
  if (cmd === "profiles") return profiles();
  if (cmd === "use") return use(rest);
  if (cmd === "whoami") return whoami();
  if (cmd === "benchmarks") return benchmarks();
  if (cmd === "earnings") return earnings();
  if (cmd === "publish-benchmark") return publish(rest);
  if (cmd === "deals") return deals(rest);
  console.log(USAGE);
  process.exit(cmd && cmd !== "--help" && cmd !== "-h" ? 2 : 0);
}

main().catch((e) => {
  if (e instanceof ParetoError) console.error(`${e.code}: ${e.message}${e.fix ? `\n  fix: ${e.fix}` : ""}`);
  else console.error(e);
  process.exit(1);
});
