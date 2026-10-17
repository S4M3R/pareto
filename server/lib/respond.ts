import { MarketError, fixFor } from "./errors.js";

/** Compact structured success: data plus a `next` hint. */
export function ok(data: Record<string, unknown>, next?: string) {
  const body = next ? { ...data, next } : data;
  return {
    content: [{ type: "text" as const, text: JSON.stringify(body) }],
    structuredContent: body,
  };
}

/** Error with a stable code and a concrete fix. */
export function fail(error: string, fix: string, code = "error") {
  const body = { code, error, fix };
  return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(body) }], structuredContent: body };
}

export function failFrom(e: unknown) {
  if (e instanceof MarketError) return fail(e.message, e.fix ?? fixFor(e.code) ?? "See the error.", e.code);
  const msg = e instanceof Error ? e.message : String(e);
  return fail(msg, "Unexpected server error; retry once, then report the message.", "internal_error");
}
