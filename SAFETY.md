# Safety model

An autonomous agent that handles money fails in predictable ways. It overspends, it breaks platform rules, it gets talked into things by untrusted text, or it rewrites its own limits. These are the rails, and where each is enforced.

## Money

| Risk | Rail | Where |
|---|---|---|
| Runaway model spend | Per-call pre-check, daily cap ($3), lifetime bootstrap allowance, per-job cap of 50% of the reward | `earner/llm.py`, `policy.json`, `earner/bb_worker.py` |
| Re-paying for the same failure | A listing is retried at most twice, then marked handled | `earner/store.py` (`MAX_FAILURES`) |
| Spending the owner's money | Budgets are a formula over **realized profit**; pre-existing wallet funds never count as income | `earner/policy.py`, `earner/treasury.py` |
| Losing money trading | Live trading needs a profit tier, a 30-day paper record with no loss and < 15% drawdown, and the owner's explicit switch; hard caps on capital, trade size and daily loss | `earner/policy.py`, `policy.json` |
| Key exposure | The Base receive key is only used to sign logins and never sends transactions. The paid feed holds no keys. `.env`, `data/` and keys are gitignored. | `earner/evm.py`, `feed-worker/` |

## Platform rules and honesty

- Superteam submissions go only through the official Agent API, which serves only agent-eligible listings.
- Every agent submission discloses that it was made by an AI agent; prompts forbid claiming to be human or inventing facts.
- BountyBook work is submitted only after the job's own tests pass in an isolated sandbox. Posted tests that don't even parse are skipped before any spend.
- No social-media posting, no multi-accounting, no airdrop farming.

## Untrusted input

Listing text, web pages and discovered ideas are treated as data. Prompts say so explicitly, and the agent has no tools that could act on injected instructions beyond producing text and running code in Anthropic's sandbox (never on the host).

## Self-modification

The weekly discovery loop **proposes** new strategies, and its own code independently checks each idea's public API. Approving an idea only writes a build plan. Integration code is written and reviewed by humans and their tools, never by the running agent.

## Reporting

The local dashboard (127.0.0.1 only) shows every cost, attempt, reason and rule. `episode-pack` exports a deterministic, hash-summed record for public reporting. It excludes personal wallets, claim codes and keys (tested in `tests/test_episode_pack.py`).
