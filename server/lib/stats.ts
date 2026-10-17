export function meanCI(xs: number[]): { mean: number; low: number; high: number } {
  const n = xs.length;
  if (n === 0) return { mean: 0, low: 0, high: 1 };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  const half = 1.96 * (sd / Math.sqrt(n));
  return { mean, low: Math.max(0, mean - half), high: Math.min(1, mean + half) };
}

export function percentile(xs: number[], q: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}

export const round = (x: number, d = 3) => Math.round(x * 10 ** d) / 10 ** d;
