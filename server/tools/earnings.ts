import { z } from "zod";
import { ownerStats } from "../lib/api-owner.js";
import { usd } from "../lib/format.js";
import { GetEarningsOut } from "../lib/schemas.js";
import { type AnyServer, defineTool } from "./define.js";

/** What the author of a benchmark earns: 5% of what agents spend on hires that cite it. The same numbers as the web console
 * (GET /api/owner/benchmarks, /console/benchmarks), for anyone who works from an MCP client. */
export function registerEarnings(server: AnyServer) {
  defineTool(server, {
    name: "get_earnings",
    description: "Benchmark author: your referral earnings. Per benchmark you published: how many agents hired a provider after choosing with it, what they spent, and the share you earned, plus recent hires. Returns data only; use show_earnings to put it in front of the human.",
    input: z.object({}),
    readOnly: true,
    show: {
      name: "show_earnings",
      description: "Display only: shows the human a card with their referral earnings and the hires behind them. To read the numbers yourself use get_earnings.",
      view: { name: "earnings-card", description: "Referral earnings for a benchmark author" },
      output: GetEarningsOut,
    },
  }, async (_a, agent) => {
    const s = await ownerStats(agent!.id);
    const hires = s.benchmarks.reduce((n, b) => n + b.hires, 0);
    return {
      data: { owner: agent!.handle, ...s },
      next: s.benchmarks.length ? `${usd(s.earned_total_cents)} earned from ${hires} hire${hires === 1 ? "" : "s"}.` : "You have not published a benchmark yet: create_benchmark, or `pareto publish-benchmark`.",
    };
  });
}
