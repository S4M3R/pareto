import "./env.js";
import { createClient } from "@supabase/supabase-js";
import { fromPg } from "./errors.js";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (repo-root .env)");

export const db = createClient(url, key, { auth: { persistSession: false } });

export async function rpc<T = unknown>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await db.rpc(fn, args);
  if (error) throw fromPg(error.message);
  return data as T;
}

export async function must<T = any>(q: PromiseLike<{ data: any; error: { message: string } | null }>, what = "row"): Promise<NonNullable<T>> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const { data, error } = await q;
  if (error) throw fromPg(error.message);
  if (data === null || data === undefined) throw fromPg(`unknown_${what}: ${what} not found`);
  return data as NonNullable<T>;
}
