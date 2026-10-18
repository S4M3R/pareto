import { ThemeProvider, ToolError, useHostContext, useSendFollowUp, useToolContext, type ToolContextError } from "mcp-use/react";
import { useCallback, useId, useState, type ReactNode } from "react";
import "./styles.css";

// ───────── formatting ─────────
export const money = (cents: number, opts: { sign?: boolean } = {}) => {
  const abs = Math.abs(cents);
  const s = `$${(abs / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (cents < 0) return `-${s}`;
  return opts.sign && cents > 0 ? `+${s}` : s;
};
export const pct = (x: number, digits = 0) => `${(x * 100).toFixed(digits)}%`;
export const q2 = (x: number) => x.toFixed(2);
export const ms = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${Math.round(n)} ms`);
export const shortId = (id: string) => id.slice(0, 8);
export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export type Tone = "mint" | "peri" | "terra" | "amber" | "neutral";

// ───────── icons (outlined, monochrome, inherit the grain glyph colour) ─────────
const ICONS = {
  wallet: "M3 7a2 2 0 0 1 2-2h13v4M3 7v10a2 2 0 0 0 2 2h14a1 1 0 0 0 1-1v-9a1 1 0 0 0-1-1H5a2 2 0 0 1-2-2zM16 14h2",
  scale: "M12 4v16M6 20h12M5 8l-3 7a3 3 0 0 0 6 0zM19 8l-3 7a3 3 0 0 0 6 0zM5 8h14",
  check: "M5 12.5l4.2 4.2L19 7",
  alert: "M12 8v5M12 16.5v.5M10.3 4.3 2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0z",
  doc: "M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6",
  coins: "M12 3c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3zM4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6",
  shield: "M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z",
  gavel: "M14 4l6 6M11 7l6 6M4 20l7-7M8.5 3.5l6 6M3 21h8",
  inbox: "M3 13l3-8h12l3 8v6H3zM3 13h5l1 3h6l1-3h5",
  list: "M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0",
  bolt: "M13 3L5 14h6l-1 7 8-11h-6z",
  receipt: "M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6",
} as const;
export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICONS[name]} />
    </svg>
  );
}

// ───────── the signature: a grainy gradient circle, seeded from an id ─────────
const PALETTES = {
  terra: { base: ["#e8b8a5", "#c98d78"], streak: "#cf8a70" },
  mint: { base: ["#a9dac5", "#8cc6ae"], streak: "#5fb396" },
  peri: { base: ["#a1a7ee", "#8087de"], streak: "#3f4be0" },
  sand: { base: ["#d6d1c4", "#bdb8a9"], streak: "#a8a291" },
  rose: { base: ["#e5b9c9", "#cc93a9"], streak: "#c0607f" },
  sky: { base: ["#adcfe6", "#8bb3d2"], streak: "#4a86b8" },
} as const;
export type PaletteName = keyof typeof PALETTES;
const PALETTE_NAMES = Object.keys(PALETTES) as PaletteName[];

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

export function GrainCircle({ seed, size = 40, palette, icon }: { seed: string; size?: number; palette?: PaletteName; icon?: IconName }) {
  const h = hash(seed);
  const p = PALETTES[palette ?? PALETTE_NAMES[h % PALETTE_NAMES.length]];
  const angle = 130 + ((h >> 3) % 70);
  const x = 15 + ((h >> 8) % 45);
  const y = 15 + ((h >> 14) % 60);
  const w = 35 + ((h >> 20) % 30);
  const id = `g${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  return (
    <span className="pv-grain" style={{ width: size, height: size }} aria-hidden="true">
      <span
        className="pv-grain-fill"
        style={{ background: `radial-gradient(ellipse ${w}% 85% at ${x}% ${y}%, ${p.streak} 0 26%, transparent 72%), linear-gradient(${angle}deg, ${p.base[0]}, ${p.base[1]})` }}
      />
      <svg className="pv-grain-noise" xmlns="http://www.w3.org/2000/svg">
        <filter id={id}>
          <feTurbulence type="fractalNoise" baseFrequency="1.1" numOctaves="2" stitchTiles="stitch" />
          <feColorMatrix type="saturate" values="0" />
        </filter>
        <rect width="100%" height="100%" filter={`url(#${id})`} />
      </svg>
      {icon && (
        <svg className="pv-grain-glyph" viewBox="0 0 24 24">
          <path d={ICONS[icon]} />
        </svg>
      )}
    </span>
  );
}

// ───────── building blocks ─────────
export function Card({
  title, subtitle, seed, palette, icon, right, tone, children, className,
}: {
  title?: ReactNode; subtitle?: ReactNode; seed?: string; palette?: PaletteName; icon?: IconName; right?: ReactNode;
  tone?: Exclude<Tone, "peri" | "neutral">; children?: ReactNode; className?: string;
}) {
  return (
    <section className={`pv-card pv-rise${className ? ` ${className}` : ""}`} data-tone={tone}>
      {(title || seed) && (
        <header className="pv-head">
          {seed && <GrainCircle seed={seed} palette={palette} icon={icon} />}
          <div className="pv-titles">
            {title && <h2 className="pv-title">{title}</h2>}
            {subtitle && <p className="pv-sub">{subtitle}</p>}
          </div>
          {right}
        </header>
      )}
      {children}
    </section>
  );
}

export function Money({ cents, big, sign, tone }: { cents: number; big?: boolean; sign?: boolean; tone?: "plus" | "minus" }) {
  const s = money(cents, { sign });
  const cls = `pv-money${big ? " big" : ""}${tone ? ` ${tone}` : ""}`;
  if (!big) return <span className={cls}>{s}</span>;
  const dot = s.lastIndexOf(".");
  return (
    <span className={cls}>
      {s.slice(0, dot)}
      <small>{s.slice(dot)}</small>
    </span>
  );
}

export function Pill({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className="pv-pill" data-tone={tone}>
      <i />
      {children}
    </span>
  );
}

const STATUS_TONE: Record<string, Tone> = {
  proposed: "amber", countered: "amber", approved: "peri", active: "peri", closing: "peri",
  settled: "mint", disputed: "terra", rejected: "terra", expired: "terra", cancelled: "terra", draft: "neutral",
  pending: "amber", released: "mint", refunded: "terra", partially_refunded: "terra", frozen: "terra", auto_refunded: "terra",
  upheld: "mint", partially_upheld: "amber", awaiting_response: "amber", under_review: "peri", resolved: "mint",
};
export const statusTone = (s: string): Tone => STATUS_TONE[s] ?? "neutral";
export const StatusPill = ({ status, label }: { status: string; label?: string }) => <Pill tone={statusTone(status)}>{label ?? status.replace(/_/g, " ")}</Pill>;

export function Rows({ children }: { children: ReactNode }) {
  return <div className="pv-rows">{children}</div>;
}
export function Row({ label, children, total }: { label: ReactNode; children: ReactNode; total?: boolean }) {
  return (
    <div className={`pv-row${total ? " total" : ""}`}>
      <span>{label}</span>
      <b>{children}</b>
    </div>
  );
}

export function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="pv-stat">
      <div className="pv-label">{label}</div>
      {children}
    </div>
  );
}

export function Bar({ segments, total }: { segments: { cents: number; tone: Exclude<Tone, "neutral">; label: string }[]; total: number }) {
  const t = Math.max(total, 1);
  return (
    <>
      <div className="pv-bar" role="img" aria-label={segments.map((s) => `${s.label} ${money(s.cents)}`).join(", ")}>
        {segments.filter((s) => s.cents > 0).map((s) => (
          <span key={s.label} data-tone={s.tone} style={{ width: `${Math.min(100, (s.cents / t) * 100)}%` }} />
        ))}
      </div>
      <div className="pv-legend">
        {segments.map((s) => (
          <span key={s.label}>
            <i data-tone={s.tone} />
            {s.label} <b className="pv-mono" style={{ fontWeight: 400, color: "var(--pv-text)" }}>{money(s.cents)}</b>
          </span>
        ))}
      </div>
    </>
  );
}

export const Skel = ({ w = "100%", h = 14, r }: { w?: number | string; h?: number; r?: number }) => (
  <div className="pv-skel" style={{ width: w, height: h, borderRadius: r }} />
);

export function SkeletonCard({ lines = 3, avatar = true }: { lines?: number; avatar?: boolean }) {
  return (
    <section className="pv-card" aria-busy="true" aria-label="Loading">
      <div className="pv-head">
        {avatar && <div className="pv-skel" style={{ width: 40, height: 40, borderRadius: "50%" }} />}
        <div className="pv-titles" style={{ display: "grid", gap: 8 }}>
          <Skel w="55%" h={14} />
          <Skel w="35%" h={11} />
        </div>
      </div>
      <div style={{ display: "grid", gap: 10 }}>
        {Array.from({ length: lines }, (_, i) => (
          <Skel key={i} w={`${92 - i * 14}%`} h={13} />
        ))}
      </div>
    </section>
  );
}

// ───────── errors: every error from the server carries { code, error, fix } ─────────
export function errorParts(err: ToolContextError | Error): { code?: string; message: string; fix?: string } {
  if (err instanceof ToolError) {
    const sc = err.result.structuredContent as { code?: string; error?: string; fix?: string } | undefined;
    if (sc?.error) return { code: sc.code, message: sc.error, fix: sc.fix };
  }
  return { message: err.message };
}

export function ErrorCard({ error, title = "That didn't go through" }: { error: ToolContextError | Error; title?: string }) {
  const e = errorParts(error);
  return (
    <Card title={title} seed={e.code ?? "error"} palette="terra" icon="alert" tone="terra" right={e.code ? <Pill tone="terra">{e.code}</Pill> : undefined}>
      <div className="pv-callout" data-tone="terra" role="alert">
        <p>{e.message}</p>
        {e.fix && (
          <p style={{ marginTop: 8 }}>
            <b>Fix:</b> {e.fix}
          </p>
        )}
      </div>
    </Card>
  );
}

// ───────── the shell every view renders inside ─────────
/** Reads the tool call that rendered this view and renders skeleton, error, or the ready data. */
export function Shell<T>({ skeleton, children, onError }: { skeleton?: ReactNode; children: (data: T, input: Record<string, unknown>) => ReactNode; onError?: (error: ToolContextError) => ReactNode | undefined }) {
  const v = useToolContext();
  let body: ReactNode;
  if (v.status === "pending") body = skeleton ?? <SkeletonCard />;
  else if (v.status === "error") body = onError?.(v.error) ?? <ErrorCard error={v.error} />;
  else body = children(v.toolOutput as unknown as T, (v.toolInput ?? {}) as Record<string, unknown>);
  return (
    <ThemeProvider>
      <div className="pv-root">{body}</div>
    </ThemeProvider>
  );
}

/** Ask the model to continue ("hire this one", "find providers"). Hidden when the host cannot send messages. */
export function useFollowUp() {
  const send = useSendFollowUp();
  const { hostCapabilities } = useHostContext();
  const [sent, setSent] = useState(false);
  const available = Boolean((hostCapabilities as { message?: unknown } | undefined)?.message);
  const ask = useCallback(
    async (prompt: string) => {
      try {
        await send({ prompt });
        setSent(true);
      } catch {
        /* host declined: leave the button usable */
      }
    },
    [send],
  );
  return { ask, available, sent };
}

/** A 95% interval on a 0..1 scale, with the point estimate: shows how much to trust a score. */
export function CiBar({ q, lo, hi }: { q: number; lo: number; hi: number }) {
  const c = (x: number) => `${Math.min(100, Math.max(0, x * 100))}%`;
  return (
    <div className="pv-ci" role="img" aria-label={`quality ${q2(q)}, 95% interval ${q2(lo)} to ${q2(hi)}`}>
      <span className="pv-ci-range" style={{ left: c(lo), width: c(Math.max(0, hi - lo)) }} />
      <span className="pv-ci-dot" style={{ left: c(q) }} />
    </div>
  );
}

export function Stepper({ steps, current }: { steps: string[]; current: number }) {
  return (
    <div className="pv-steps" role="list">
      {steps.map((s, i) => (
        <div className="pv-step" role="listitem" key={s} data-state={i < current ? "done" : i === current ? "now" : "todo"} aria-current={i === current ? "step" : undefined}>
          <i />
          {s}
        </div>
      ))}
    </div>
  );
}

/** "platform-operated" for providers we run to bootstrap the marketplace; "verified" when the platform ran the numbers. */
export function Tags({ seeded, verified }: { seeded?: boolean; verified?: boolean }) {
  return (
    <div className="pv-tags">
      {verified && <Pill tone="mint">verified by platform</Pill>}
      {seeded && <Pill>platform-operated</Pill>}
    </div>
  );
}
