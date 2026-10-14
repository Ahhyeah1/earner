# Distribution checklist: guard, rug radar, MCP, Apify

## 1. Group guard (2 min, once)
@BotFather → /mybots → Rug1CheckSolBot → Bot Settings → Group Privacy → **Turn off**.
Without this the bot only sees /commands in groups (unless it's admin), so the guard can't see posted addresses.
Then in any group: add the bot, an admin types `/guard on`.

## 2. Rug radar channel (3 min, once)
1. Telegram → New Channel → public, e.g. `@solrugradar` (name: "Solana Rug Radar").
2. Channel → Administrators → add @Rug1CheckSolBot (permission: post messages).
3. Tell Claude the @name: it goes into wrangler.jsonc as TG_CHANNEL and is deployed.
The bot posts a digest daily at 18:00 UTC, only on days something was flagged. Public log: https://earner-feed.earner-feed.workers.dev/rugs

## 3. MCP directories (free)
Endpoint: `https://earner-feed.earner-feed.workers.dev/mcp` (Streamable HTTP, tool `check_solana_token`, 30 free calls/IP/day).
- Official MCP Registry: `mcp-publisher login github` (as Ahhyeah1) then `mcp-publisher publish` in feed-worker/ (uses server.json).
- Smithery (smithery.ai → Add server → URL), Glama (glama.ai/mcp/servers → Add), mcp.so (Submit): paste the URL + the description below.
Description: "Free MCP tool that checks any Solana token for rug/honeypot settings from on-chain data: mint/freeze authority, permanent delegate, transfer hooks/fees, pausability, holder concentration. Score 0-100 with reasons."

## 4. Apify Store (earns per check)
1. Create a free account at apify.com; Settings → Integrations → copy the API token into C:\dev\earner\.env as `APIFY_TOKEN=`.
2. Claude runs: `apify login`, `apify secrets add earnerKey <EARNER_INTERNAL_KEY>`, `apify push` (from apify-actor/).
3. In Apify Console → the Actor → Publication: make it public, category "Developer tools"/"AI". Monetization → **Pay per event**, event `token-check`, suggested $0.005 per token. Payout details (needed to get paid) are yours to fill in.
