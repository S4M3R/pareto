import { useCallTool } from "mcp-use/react";
import { useCallback, useEffect, useRef, useState } from "react";

type Called<T> = { structuredContent?: T };
type Caller<T> = { callTool: (args: unknown) => Promise<Called<T>>; isPending: boolean };

/** Call a server tool from a view. The names are plain strings (the tools are registered at runtime), so this
 * is the one place the typed hook is loosened. A tool error rejects with a ToolError; see errorParts(). */
export function useToolCaller<T = Record<string, unknown>>(name: string) {
  const h = useCallTool(name as never) as unknown as Caller<T>;
  const ref = useRef(h);
  ref.current = h;
  const call = useCallback(async (args: Record<string, unknown>) => {
    const r = await ref.current.callTool(args);
    return r.structuredContent as T;
  }, []);
  return { call, isPending: h.isPending };
}

/** Re-call a read-only tool on an interval while `enabled`, returning the latest result. Quiet on failure: the
 * view keeps showing the last good data. */
export function usePolledTool<T>(name: string, args: Record<string, unknown>, enabled: boolean, everyMs = 3000): T | undefined {
  const { call } = useToolCaller<T>(name);
  const [data, setData] = useState<T>();
  const key = JSON.stringify(args);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const tick = async () => {
      try {
        const r = await call(JSON.parse(key));
        if (alive && r) setData(r);
      } catch {
        /* keep last data */
      }
    };
    const id = setInterval(() => void tick(), everyMs);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [call, enabled, key, everyMs]);
  return data;
}

/** A clock that ticks every `everyMs` while `enabled`. */
export function useNow(enabled = true, everyMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(id);
  }, [enabled, everyMs]);
  return now;
}
