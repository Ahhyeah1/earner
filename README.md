# earner

**An autonomous AI agent that tries to earn its own running costs, inside hard limits set by its owner.**

It started with $0 of its own money and a one-time $5 allowance for model usage. Every two hours it scouts paid work that AI agents are *explicitly allowed* to do, does the work it can verify, and submits only what passes. It also sells what it learns as a pay-per-call feed for other agents. It sets its own budget, but only as a formula over money it has actually earned. Trading stays locked until it has both profit and a paper-trading record.

It is also an honest experiment, and its results are on the dashboard, including the losses.

## What it does

| Loop | What happens | Safety rail |
|---|---|---|
| **Scout** | Ranks ~250 opportunities (Superteam Earn, BountyBook, OpenTask, Immunefi, GitHub) by expected payout per competitor | Read-only public APIs |
| **Superteam Earn** (Solana) | Uses the official [Agent API](https://superteam.fun/earn/agents/): triage → produce → independent review → submit | Agent-eligible listings only (enforced by the platform); review score ≥ 7/10; AI disclosure in every submission |
| **BountyBook** (Base) | Writes the solution, then runs the job's **own tests** in Anthropic's sandbox before claiming | Submits only if raw sandbox output shows the exact file hashes and exit 0; cost cap of 50% of the reward per job |
| **Paid feed** ([`feed-worker/`](feed-worker/), live at https://earner-feed.earner-feed.workers.dev) | Sells the ranked feed via [x402](https://x402.org), at $0.01 USDC per call on **Solana** or Base | The worker only names receiving addresses and never holds a key |
| **Telegram bot** ([@Rug1CheckSolBot](https://t.me/Rug1CheckSolBot)) | Paste a Solana mint, get the on-chain risk verdict; 5 free/day, packs via Telegram Stars | Webhook verified by secret token; failed checks are refunded |
| **Treasury** | Detects income from on-chain stablecoin balances (Solana + Base) | Existing funds never count as earnings |
| **Budget** | `operating budget = bootstrap + reinvest% × profit`, `trading capital = min(trading% × profit, cap)` | [`policy.json`](policy.json) is owner-written; the agent only reads it |
| **Paper trading** | Daily trend-following on SOL/BTC/ETH with a virtual $1,000 | Live trading needs profit ≥ $300, 30 paper days, no loss, < 15% drawdown, **and** the owner's switch |
| **Discovery** | Weekly web research for new legitimate ways to earn; its own code probes each idea's API | Proposes only: the owner approves, and the agent never rewrites its own code |
| **Dashboard** | Local web UI: money, tiers, activity, ideas, live log | Binds to 127.0.0.1 only |

## Quick start (Windows, Python 3.11)

```powershell
python -m venv .venv
.venv\Scripts\python -m pip install anthropic truststore eth-account
copy .env.example .env      # add ANTHROPIC_API_KEY and your payout wallet
.venv\Scripts\python -m earner run      # one autonomous cycle
.venv\Scripts\python -m earner ui       # dashboard at http://127.0.0.1:8765
.venv\Scripts\python -m unittest discover tests
```

`run_cycle.ps1` registers nothing by itself; its header shows the one `schtasks` line that runs the agent every two hours.

## Commands

```
run | ui | status | scout | discover | ideas | idea-approve <id> | idea-reject <id>
approve <id> | reject <id> | submitted <id> | won <id> <amount> <token> <usd> [tx] | lost <id>
ledger | episode-pack [iso-cutoff]
```

## Design rules (see [SAFETY.md](SAFETY.md))

1. **Only where agents are allowed.** No sybil or airdrop farming, spam, fake engagement or impersonation.
2. **Verify before you claim.** Never submit work that hasn't passed its own acceptance test.
3. **Earned money only.** Budgets grow from realized profit, never from the owner's funds.
4. **Owner keeps the keys to the rules.** Policy, approvals for new strategies, and the live-trading switch are human.
5. **Everything is logged.** Every cost, attempt and reason is in SQLite and on the dashboard.

## Status

Early. See the dashboard or `python -m earner episode-pack` for the current numbers. They are reported as they are, including negative profit.

## License

MIT, see [LICENSE](LICENSE).
