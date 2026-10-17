import type { MCPServer } from "mcp-use";
import type { z } from "zod";
import { type Agent, agentFromKey, keyFromCtx } from "../lib/auth.js";
import { db } from "../lib/db.js";
import { MarketError } from "../lib/errors.js";
import { failFrom, ok } from "../lib/respond.js";

export interface ToolCfg<S extends z.ZodObject<z.ZodRawShape>> {
  name: string;
  description: string;
  input: S;
  readOnly?: boolean;
  destructive?: boolean;
  idempotent?: boolean;
  role?: "buyer" | "provider";
  /** Set false for tools usable without an API key (registration). */
  auth?: boolean;
}

type Result = { data: Record<string, unknown>; next?: string };

/** One place for what every tool shares: auth, role check, annotations, uniform errors, and session logging. */
export function defineTool<S extends z.ZodObject<z.ZodRawShape>>(
  server: MCPServer,
  cfg: ToolCfg<S>,
  handler: (args: z.infer<S>, agent: Agent | null) => Promise<Result>,
) {
  server.tool(
    {
      name: cfg.name,
      description: cfg.description,
      inputSchema: cfg.input,
      annotations: {
        readOnlyHint: cfg.readOnly ?? false,
        destructiveHint: cfg.destructive ?? false,
        idempotentHint: cfg.idempotent ?? cfg.readOnly ?? false,
        openWorldHint: false,
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (args: any, ctx: any) => {
      const t0 = Date.now();
      let agent: Agent | null = null;
      let outcome = "ok";
      try {
        if (cfg.auth !== false) {
          agent = await agentFromKey(keyFromCtx(ctx));
          if (cfg.role && !agent.roles.includes(cfg.role)) {
            throw new MarketError("wrong_role", `This tool is for ${cfg.role} agents; ${agent.handle} is ${agent.roles.join("/")}.`, `Use an account with the ${cfg.role} role.`);
          }
        }
        const r = await handler(args, agent);
        return ok(r.data, r.next);
      } catch (e) {
        outcome = e instanceof MarketError ? e.code : "internal_error";
        return failFrom(e);
      } finally {
        void db.from("tool_sessions").insert({
          agent_id: agent?.id ?? null,
          client: ctx?.client?.info?.()?.name ?? null,
          tool: cfg.name,
          args_summary: Object.keys(args ?? {}).join(","),
          outcome,
          latency_ms: Date.now() - t0,
        });
      }
    },
  );
}
