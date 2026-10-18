import { MarketError, fixFor } from "./errors.js";

/** Compact structured success: data plus a `next` hint. */
export function ok(data: Record<string, unknown>, next?: string, say?: string) {
  const body = next ? { ...data, next } : data;
  return {
    // `say` is what the model reads when the full data is for a view to draw (the view reads structuredContent).
    content: [{ type: "text" as const, text: say ?? JSON.stringify(body) }],
    structuredContent: body,
  };
}

/** Error with a stable code and a concrete fix. */
export function fail(error: string, fix: string, code = "error", details?: Record<string, unknown>) {
  const body = { code, error, fix, ...(details ? { details } : {}) };
  // details are for a view to draw; the model only needs the link in them, not the whole card
  const forModel = { code, error, fix, ...(typeof details?.approval_url === "string" ? { approval_url: details.approval_url } : {}) };
  return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(forModel) }], structuredContent: body };
}

export function failFrom(e: unknown) {
  if (e instanceof MarketError) return fail(e.message, e.fix ?? fixFor(e.code) ?? "See the error.", e.code, e.details);
  const msg = e instanceof Error ? e.message : String(e);
  return fail(msg, "Unexpected server error; retry once, then report the message.", "internal_error");
}
