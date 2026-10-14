# Solana Token Rug Check

Check any Solana token for rug-pull and honeypot settings **before** you buy, list or recommend it. Paste mint addresses (or pump.fun / solscan links) and get a risk score from 0 to 100, a level (low / medium / high / critical) and the reasons, all read directly from the Solana blockchain.

## What it checks

| Check | Why it matters |
|---|---|
| Mint authority | Someone can print unlimited new tokens and dilute holders |
| Freeze authority | Someone can freeze your tokens (classic honeypot) |
| Permanent delegate (Token-2022) | Someone can move or burn tokens from **any** wallet |
| Transfer hook (Token-2022) | A custom program runs on every transfer and can block sells |
| Transfer fee (Token-2022) | A hidden tax on every transfer |
| Non-transferable / default-frozen accounts | Buyers may be unable to sell |
| Pausable | All transfers can be stopped |
| Mutable metadata | Name, symbol and image can still be changed |
| Holder concentration | How much the largest wallet and the top 10 wallets hold |

## Input

```json
{ "mints": ["EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm"], "onlyRisky": false }
```

- **mints**: up to 1,000 addresses per run. Links work too; the address is extracted.
- **onlyRisky**: keep only tokens rated high or critical.

## Output (one dataset item per token)

```json
{
  "mint": "EKpQ…zcjm", "level": "low", "score": 0,
  "redFlags": [], "top1Pct": 6.1, "top10Pct": 22.4, "coverage": "contract+holders",
  "checks": [ { "id": "mint_authority", "ok": true, "detail": "Mint authority revoked: supply is fixed." } ],
  "facts": { "token_program": "spl-token", "decimals": 6, "supply": 998843697 },
  "checkedAt": "2026-10-15T18:00:00.000Z"
}
```

## Use cases

- Screen new pump.fun / Raydium launches before a trading bot buys
- Add a safety column to token lists, alerts or dashboards
- Due diligence for listings, KOL promotions and community calls

## Pricing

Pay per checked token. Tokens that fail to load (bad address, RPC outage) are free.

## Limits and honesty

These are contract-level checks of public on-chain data. They don't assess liquidity locks, price action or what the team does next, so a low score is not a guarantee. If the holder data couldn't be read, `coverage` says `contract-only` and the level is never reported as low. Nothing here is financial advice.

Also available as a free Telegram bot ([@Rug1CheckSolBot](https://t.me/Rug1CheckSolBot)), an MCP server (`https://earner-feed.earner-feed.workers.dev/mcp`) and a pay-per-call x402 API. Open source: [github.com/Ahhyeah1/earner](https://github.com/Ahhyeah1/earner).
