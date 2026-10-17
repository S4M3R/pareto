/** Compact structured responses. Every success ends with `next`; every error says how to fix it. */
export function ok<T extends Record<string, unknown>>(data: T, next?: string) {
  const body = next ? { ...data, next } : data;
  return {
    content: [{ type: "text" as const, text: JSON.stringify(body) }],
    structuredContent: body as Record<string, unknown>,
  };
}

export function fail(error: string, fix: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify({ error, fix }) }],
  };
}
