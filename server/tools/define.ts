import type { MCPServer } from "mcp-use";
import type { z } from "zod";
import { type Agent, OAUTH_SCOPE, agentById, agentFromKey, keyFromCtx } from "../lib/auth.js";
import { db } from "../lib/db.js";
import { MarketError } from "../lib/errors.js";
import { failFrom, ok } from "../lib/respond.js";

/** The server, whatever its auth user type: tools resolve the agent themselves, from an OAuth token or an API key. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyServer = MCPServer<any, any>;

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
  /** Output contract (lib/schemas.ts). Required when `view` is set; validated by the SDK on every success. */
  output?: z.ZodType;
  /** Render the result as an MCP App view (views/<name>/view.tsx). */
  view?: { name: string; description?: string };
  /** "app" hides the tool from the model; only views may call it. */
  visibility?: "model" | "app";
  /** A display twin: the same query, shown to the human as a card. The plain tool returns data only, so ordinary lookups
   * never draw a card; the agent calls the twin only when the human should see or decide something. */
  show?: { name: string; description: string; view: { name: string; description?: string }; output: z.ZodType };
  /** Require an OAuth sign-in (not an API key). Calling it while signed out is what makes claude.ai start the sign-in flow. */
  signIn?: boolean;
}

type Result = { data: Record<string, unknown>; next?: string; say?: string };

/** One place for what every tool shares: auth, role check, annotations, uniform errors, and session logging. */
export function defineTool<S extends z.ZodObject<z.ZodRawShape>>(
  server: AnyServer,
  cfg: ToolCfg<S>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (args: z.infer<S>, agent: Agent | null, ctx?: any) => Promise<Result>,
) {
  const register = (o: { name: string; description: string; output?: z.ZodType; view?: { name: string; description?: string }; twin?: boolean }) => server.tool(
    {
      ...(o.output ? { outputSchema: o.output } : {}),
      ...(o.view ? { view: o.view } : {}),
      ...(cfg.visibility ? { visibility: cfg.visibility } : {}),
      // Anyone can connect and list tools; the callback resolves the agent from the OAuth token or an API key.
      securitySchemes: cfg.auth === false ? [{ type: "noauth" as const }] : cfg.signIn ? [{ type: "oauth2" as const, scopes: [OAUTH_SCOPE] }] : [{ type: "noauth" as const }, { type: "oauth2" as const, scopes: [OAUTH_SCOPE] }],
      name: o.name,
      description: o.description,
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
          // signed in with OAuth (claude.ai connector) -> the agent behind the token; otherwise an agent API key
          const oauthId = ctx?.auth?.user?.id as string | undefined;
          agent = oauthId ? ((await agentById(oauthId)) ?? (await agentFromKey(undefined))) : await agentFromKey(keyFromCtx(ctx));
          if (cfg.role && !agent.roles.includes(cfg.role)) {
            throw new MarketError("wrong_role", `This tool is for ${cfg.role} agents; ${agent.handle} is ${agent.roles.join("/")}.`, `Use an account with the ${cfg.role} role.`);
          }
        }
        const r = await handler(args, agent, ctx);
        // A twin's card carries the data; the model only needs to know it was shown, and to keep its reply short.
        return ok(r.data, r.next, o.twin ? "Shown to the user as a card. Reply with one short sentence and do not restate what the card shows." : r.say);
      } catch (e) {
        outcome = e instanceof MarketError ? e.code : "internal_error";
        return failFrom(e);
      } finally {
        void db.from("tool_sessions").insert({
          agent_id: agent?.id ?? null,
          client: ctx?.client?.info?.()?.name ?? null,
          tool: o.name,
          args_summary: Object.keys(args ?? {}).join(","),
          outcome,
          latency_ms: Date.now() - t0,
        });
      }
    },
  );

  const main = register({ name: cfg.name, description: cfg.description, output: cfg.output, view: cfg.view });
  if (cfg.show) register({ name: cfg.show.name, description: cfg.show.description, output: cfg.show.output, view: cfg.show.view, twin: true });
  return main;
}
