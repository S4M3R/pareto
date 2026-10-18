# MCP Server built with mcp-use

This is an MCP server project bootstrapped with [`create-mcp-use-app`](https://mcp-use.com/docs/typescript/getting-started/quickstart).

## Getting Started

First, run the development server:

```bash
npm install
npm run dev
```

Open [http://localhost:3000/mcp/inspector](http://localhost:3000/mcp/inspector) with your browser to test your server.

You can start building by editing the entry file. Add tools, resources, and prompts — the server auto-reloads as you edit.

Run `npm run typecheck` to refresh MCP view types and check the project with its local TypeScript compiler.

## Learn More

To learn more about mcp-use and MCP:

- [mcp-use Documentation](https://mcp-use.com/docs/typescript/getting-started/quickstart) — guides, API reference, and tutorials

## Deploy on Manufact Cloud

```bash
npm run deploy
```

## Views (MCP Apps)

Tools render as interactive views inside Claude, ChatGPT or the Inspector. **Cards are shown only when the human needs
them.** Ordinary tools (`whoami`, `search_benchmarks`, `find_providers`, `get_agreement`, ...) return data and draw
nothing, so an agent can do its work without a card per query. A card has its own display tool, which the agent calls
when the human asks to see something or must decide. In code: `defineTool` takes `show: { name, view, output }` and
registers that twin next to the plain tool, sharing one handler. Output schemas live in `lib/schemas.ts` and are
validated on every success; the matching React component is `views/<name>/view.tsx`.

| Card (view) | Display tool |
|---|---|
| `wallet-strip` | `show_wallet` |
| `fund-wallet` | `show_topup_card`; also shown in place of the error when `fund_escrow` fails with `insufficient_funds` (its button calls `topup_wallet`, which is app-only: hidden from the model) |
| `benchmark-card` | `show_benchmarks` |
| `pareto-chart` | `compare_providers`: quality vs price with the Pareto frontier, plus quality, price, speed and value bars and a table |
| `provider-profile` | `show_provider` |
| `agreement-card` | `show_agreement` |
| `spend-meter` | `show_spend` |
| `ledger-table` | `show_ledger` |
| `dispute-status` | `show_dispute` |
| `proposal-inbox` | `show_inbox` (approve or reject from the card) |
| `agreement-funded` | `fund_escrow` draws it itself: a money moment |
| `settlement` | `close_task` draws it itself (leave a review from the card) |
| `dispute-verdict` | `file_dispute` draws it itself |

Shared code is in `views/_ui/` (it must live under `views/`: the dev server only serves that path to the browser).
Styling reads the host's tokens (`--color-*`, `--font-*`) with fallbacks, so every view works in light and dark hosts.
Chart colors are the first three slots of a validated categorical palette; a fourth provider folds into grey.

**Preview a view against real data** without a chat client (dev only, not part of the product):

```bash
pnpm dev                                   # MCP server, prints its port
node dev/host-server.mjs http://localhost:3000 4173
# http://localhost:4173/view-host.html?tool=compare_providers&args={"benchmark_id":"<id>"}&key=<agent key>&theme=dark
```

The host speaks the MCP Apps `postMessage` protocol, passes Claude's color tokens, proxies tool calls from the view
(top-up, review, approve) back to the server, and accepts `fixture=<json>` to preview a write action without running it.


## Adding funds: the human always approves

Agents never move money. `topup_wallet` is app-only (hidden from the model); it runs only when a person clicks.
There are three ways for that person to see an approval UI, in order of preference:

1. **The card in the chat.** `show_topup_card`, or a failed `fund_escrow` (`insufficient_funds`), renders the add-funds
   card in hosts that draw MCP Apps (Claude Desktop chat, the Inspector).
2. **The approval page.** Every card result also carries `approval_url` (`/approve/topup/<token>`): a standalone page
   that works in any client, including agent modes (Claude Desktop's local agent mode, Claude Code) that cannot draw a card.
   The agent hands the link to the human; they open it and click. Links are single-use, expire after 30 minutes, are held
   in memory (a restart just means asking for a new one), and cap a top-up at $50. Test mode only.
3. Never: an agent calling `topup_wallet` itself.

`PUBLIC_BASE_URL` must be the origin the human's browser can reach (`http://localhost:3100` locally).

## Deploying and connecting

**Manufact Cloud** (managed upload, no GitHub needed):

```bash
pnpm mcp-use login                                   # once, in a browser
# put SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY, STRIPE_SECRET_KEY (test key) and
# OAUTH_SECRET (openssl rand -base64 36) in a gitignored file such as .env.production.local, then:
pnpm mcp-use deploy . --no-github --name pareto --env-file .env.production.local --yes
pnpm mcp-use servers get pareto                      # prints the MCP URL
pnpm mcp-use servers env set <server-id> PUBLIC_BASE_URL=https://<host>   # used in gateway and approval links
```

Platform-operated providers are served by this same server, so the gateway resolves their endpoint against its own origin.

**Signing in.** Two ways, same tools:

- *Agents and scripts*: `x-api-key: agk_...` (or `Authorization: Bearer agk_...`).
- *Claude Desktop and claude.ai connectors*, which can only sign in with OAuth: the server is its own authorization server
  (`lib/oauth.ts`). "Signing in" means choosing the agent to act as: paste its API key or create a new agent. Everything is
  stateless (client ids carry their redirect URIs; codes and tokens are HS256 JWTs signed with `OAUTH_SECRET`), so it works
  on any number of instances. Access tokens last 1 hour, refresh tokens 30 days, and rotating an agent's key signs out every
  connection to it. Authorization codes are short-lived (5 min) and PKCE-bound but not single-use. Production path: swap the
  sign-in step for GitHub or Google with mcp-use's `oauthProxy`.

`scripts/oauth-check.ts` plays the part of a connector end to end (`BASE=https://<host> pnpm tsx scripts/oauth-check.ts`).
Against a remote server run the golden path with `CHECK_WINDOW_S=45`.

## Listings, benchmarks and the demo providers

**Creating a listing** (provider): MCP `register_listing`, or `POST /api/listings` with the agent's API key. Both go through
`lib/listings.ts`, which checks the capability is one the platform can meter and check, and that the endpoint is a public
https URL (private ranges, cloud metadata addresses and plain http are refused: the platform calls it on someone's behalf).
Hostnames are checked, not resolved, so production still needs network egress rules.

**Benchmarks**: `create_benchmark` / `POST /api/benchmarks` take 24 to 400 labelled images (https URLs or base64), normalise
them to 256px JPEGs, publish a few as dev examples and keep the rest as a hidden test set in a table anonymous clients cannot
read, fingerprinted. `run_benchmark` / `POST /api/listings/{id}/runs` (owner only) sends every hidden image to the listing's
endpoint, compares the answers with the reference labels, and records a verified result: accuracy, Wilson 95% interval, n,
latency p50 and p95. `find_providers` ranks on the latest result. Known limit: the provider being scored sees the hidden
images one at a time, so a dishonest one could keep them; production needs rotating or private test sets. Only
image-classification benchmarks can be created through the API today.

**Capabilities** (`lib/capabilities.ts`) are what keep the gateway, the evals and disputes from being tied to one task: each
says how to prepare an input, where the answer is in a response, and how to check it against a reference. Today:
`profile-extraction` and `image-classification`.

**The demo providers** (`demo/listing-server.ts`, not part of the product). Six hot-dog classifiers, each a real HTTP service
behind a real listing, a real account and a real benchmark run, but with a simulated "model": answers come from an answer key
with a fixed accuracy, latency and billing habit, deterministic per image. FrankFinder Pro (most accurate, 8c), BunVision (5c),
Dogspotter (3c), WienerNet (3c, dominated by Dogspotter), FastFrank (2c, bills twice 12% of the time and has slow outliers) and
SeeFood Lite (1c, least accurate). Their accuracy parameters are calibrated so the 100-image hidden set scores at each
persona's designed accuracy. They are flagged platform-operated, `GET /demo/listings` lists them, and responses carry
`x-demo-provider: mock`. Re-create everything with `pnpm tsx scripts/seed-image-classification.ts [--run <MCP_URL>]`.

Image data: Hugging Face `antareepdey/Hotdog-or-not-a-hotdog` (220 labelled photos, declared Apache-2.0 by its uploader; the
dataset card does not say where the photos came from, so confirm rights before showing it beyond a demo). Split 100 hidden, 8
dev, 112 live pool (`data/images`, `data/live-images.json`). `data/answer-key.json` is the demo providers' cheat sheet.

`scripts/image-path.ts` exercises all of it end to end (discovery, the listing API and its refusals, a hire with refunds and
settlement); it removes the listings it creates.

## Demo accounts and keys

The seed scripts create a demo buyer and platform-operated demo providers. Their API keys are derived from
`DEMO_KEY_SECRET` (set it in the repo-root `.env`, 24+ characters, never commit it), so a deployed database does not have
guessable accounts. Without the secret you get fixed, public keys: fine for a throwaway local database, never for a shared or
hosted one.

```bash
pnpm tsx scripts/demo-keys.ts            # print the keys
pnpm tsx scripts/rotate-demo-keys.ts     # make the database accept exactly these keys (old keys and their OAuth sign-ins end)
```
