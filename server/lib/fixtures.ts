/** The controlled "world" the demo providers operate on: synthetic profile pages with known ground truth.
 * Synthetic people only: no real individuals, no scraping of real sites. */
export interface Profile {
  name: string;
  title: string;
  company: string;
  location: string;
  years: number;
  skills: string[];
}

export const FIELDS = ["name", "title", "company", "location", "years", "skills"] as const;
export type Field = (typeof FIELDS)[number];

const FIRST = ["Ava", "Liam", "Noah", "Mia", "Ethan", "Zoe", "Lucas", "Nora", "Omar", "Priya", "Mateo", "Hana", "Ivan", "Lena", "Kofi", "Sara", "Tariq", "Elena", "Diego", "Yuki"];
const LAST = ["Nguyen", "Garcia", "Okafor", "Schmidt", "Rossi", "Kim", "Haddad", "Larsen", "Silva", "Novak", "Moreau", "Tanaka", "Reyes", "Costa", "Ivanov", "Patel", "Baker", "Singh", "Duarte", "Weiss"];
const TITLES = ["Data Engineer", "Product Manager", "Site Reliability Engineer", "Account Executive", "ML Researcher", "Security Analyst", "Designer", "Backend Engineer", "Operations Lead", "Solutions Architect"];
const COMPANIES = ["Northwind Labs", "Acme Robotics", "Brightpath Health", "Kestrel Systems", "Lumen Analytics", "Orbit Freight", "Pinecrest Bank", "Quartz Software", "Riverstone AI", "Summit Cloud", "Tidal Media", "Umbra Security", "Vertex Biotech", "Willow Retail", "Zenith Energy"];
const CITIES = ["Toronto", "San Francisco", "Berlin", "Lisbon", "Singapore", "Austin", "London", "Montreal", "Sydney", "Nairobi"];
const SKILLS = ["python", "sql", "typescript", "kubernetes", "figma", "excel", "go", "rust", "airflow", "terraform", "react", "tableau", "spark", "salesforce", "pytorch", "postgres", "aws", "gcp", "dbt", "kafka"];

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(r: () => number, xs: T[]) => xs[Math.floor(r() * xs.length)];

export function truth(id: number): Profile {
  const r = mulberry32(id * 7919 + 13);
  const skills = new Set<string>();
  while (skills.size < 3) skills.add(pick(r, SKILLS));
  return {
    name: `${pick(r, FIRST)} ${pick(r, LAST)}`,
    title: pick(r, TITLES),
    company: pick(r, COMPANIES),
    location: pick(r, CITIES),
    years: 1 + Math.floor(r() * 20),
    skills: [...skills].sort(),
  };
}

export function html(id: number): string {
  const p = truth(id);
  if (id % 2 === 0) {
    return `<div class="profile"><h1 class="name">${p.name}</h1><p class="headline">${p.title} at ${p.company}</p>` +
      `<span class="loc">${p.location}</span><span class="exp">${p.years} years of experience</span>` +
      `<ul class="skills">${p.skills.map((s) => `<li>${s}</li>`).join("")}</ul></div>`;
  }
  return `<article><header><h2>${p.name}</h2></header><dl><dt>Role</dt><dd>${p.title}</dd><dt>Employer</dt><dd>${p.company}</dd>` +
    `<dt>Based in</dt><dd>${p.location}</dd><dt>Experience</dt><dd>${p.years} yrs</dd><dt>Skills</dt><dd>${p.skills.join(", ")}</dd></dl></article>`;
}

/** Reference parser: what a careful provider does. */
export function parse(page: string): Profile {
  const g = (re: RegExp) => (re.exec(page)?.[1] ?? "").trim();
  if (page.startsWith("<div")) {
    const head = /<p class="headline">(.*?) at (.*?)<\/p>/.exec(page);
    return {
      name: g(/<h1 class="name">(.*?)<\/h1>/),
      title: head?.[1] ?? "",
      company: head?.[2] ?? "",
      location: g(/<span class="loc">(.*?)<\/span>/),
      years: Number(g(/<span class="exp">(\d+) years/)),
      skills: [...page.matchAll(/<li>(.*?)<\/li>/g)].map((m) => m[1]).sort(),
    };
  }
  return {
    name: g(/<h2>(.*?)<\/h2>/),
    title: g(/<dt>Role<\/dt><dd>(.*?)<\/dd>/),
    company: g(/<dt>Employer<\/dt><dd>(.*?)<\/dd>/),
    location: g(/<dt>Based in<\/dt><dd>(.*?)<\/dd>/),
    years: Number(g(/<dt>Experience<\/dt><dd>(\d+) yrs/)),
    skills: g(/<dt>Skills<\/dt><dd>(.*?)<\/dd>/).split(",").map((s) => s.trim()).filter(Boolean).sort(),
  };
}

/** Per-field correctness of a returned profile against ground truth. */
export function scoreFields(got: Partial<Profile> | undefined, id: number): { accuracy: number; wrong: Field[] } {
  const t = truth(id);
  const wrong: Field[] = [];
  for (const f of FIELDS) {
    const a = got?.[f];
    const b = t[f];
    const same = Array.isArray(b) ? Array.isArray(a) && [...a].sort().join("|") === [...b].sort().join("|") : a === b;
    if (!same) wrong.push(f);
  }
  return { accuracy: (FIELDS.length - wrong.length) / FIELDS.length, wrong };
}
