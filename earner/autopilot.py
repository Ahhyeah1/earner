"""One autonomous cycle. Safe to run as often as you like (lock + once-per-day steps).

  scout -> treasury sync -> budget from policy -> paper trade -> bounty worker -> report/status
"""
import json
import os
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LOCK = ROOT / "data" / "autopilot.lock"
STATUS = ROOT / "data" / "status.json"
LOCK_STALE_SECONDS = 3 * 3600


def load_env(path=ROOT / ".env"):
    """KEY=VALUE lines; real environment variables win."""
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"'))


load_env()

from . import llm as llm_mod  # noqa: E402  (llm reads credentials from the env loaded above)
from . import discovery, evm, feed, paper, policy, sources, treasury  # noqa: E402
from .bb_worker import BBWorker  # noqa: E402
from .bountybook import BountyBook  # noqa: E402
from .score import score  # noqa: E402
from .superteam import Superteam  # noqa: E402
from .worker import Worker  # noqa: E402


def scout(store, ts, log=print):
    ok, opps = [], []
    for name, fn in sources.SOURCES.items():
        try:
            got = fn()
            ok.append(name)
            opps += got
            log(f"  {name}: {len(got)}")
        except Exception as e:
            log(f"  {name}: FAILED {e!r}")
    new = sum(store.upsert(o, *score(o), ts) for o in opps)
    if ok:
        store.mark_gone(sorted(ok), ts)
    store.commit()
    return len(opps), new


def _acquire_lock():
    LOCK.parent.mkdir(exist_ok=True)
    if LOCK.exists() and time.time() - LOCK.stat().st_mtime < LOCK_STALE_SECONDS:
        return False
    LOCK.write_text(str(os.getpid()))
    return True


def compute_budget(store, pol, today, paper_stats):
    return policy.compute(
        pol,
        income_usd=store.total("ledger"),
        expenses_usd=store.total("expenses"),
        llm_spent_total=store.total("expenses", category="llm"),
        llm_spent_today=store.total("expenses", since=today, category="llm"),
        submissions_today=store.submissions_since(today),
        paper_stats=paper_stats,
    )


def run(store, log=print):
    if not _acquire_lock():
        log("another cycle is running; exiting")
        return None
    try:
        return _cycle(store, log)
    finally:
        LOCK.unlink(missing_ok=True)


def _cycle(store, log):
    ts = sources.now().isoformat(timespec="seconds")
    today = ts[:10]
    pol = policy.load()
    notes = []
    log(f"[{ts}] cycle")

    total, new = scout(store, ts, log)
    last_action = f"scouted {total} opportunities ({new} new)"
    if feed.configured():
        try:
            log(f"  paid feed: published {feed.publish(feed.build(store))} items")
        except Exception as e:
            log(f"  paid feed publish failed: {e!r}")

    wallet = os.environ.get("EARNER_PAYOUT_WALLET")
    if wallet:
        try:
            treasury.sync_wallet(store, wallet, ts, log=log)
            store.commit()
        except Exception as e:
            log(f"  wallet sync failed: {e!r}")
    else:
        notes.append("EARNER_PAYOUT_WALLET not set: earnings are not detected automatically")
    agent_evm = evm.address()
    if agent_evm:
        try:
            treasury.sync_wallet(store, agent_evm, ts, balance_fn=evm.usdc_balance, log=log,
                                 baseline_key="evm_baseline", label="agent Base wallet")
            store.commit()
        except Exception as e:
            log(f"  Base wallet sync failed: {e!r}")

    pstats = paper.stats(store.kv_get("paper") or {})
    budget = compute_budget(store, pol, today, pstats)
    if budget.can("paper_trading"):
        try:
            pstats = paper.step(store, today, log=log)
            store.commit()
        except Exception as e:
            log(f"  paper step failed: {e!r}")
    budget = compute_budget(store, pol, today, pstats)
    log(f"  tier={budget.tier} profit=${budget.profit_usd} llm_today_left=${budget.llm_today_left_usd} "
        f"trading_capital=${budget.trading_capital_usd}")

    if not os.environ.get("ANTHROPIC_API_KEY"):
        notes.append("ANTHROPIC_API_KEY not set: bounty worker idle")
    elif budget.llm_today_left_usd < llm_mod.MAX_CALL_USD:
        notes.append("LLM budget for today/lifetime exhausted: worker idle until earnings raise it")
    else:
        llm = llm_mod.LLM(lambda usd, note: store.add_expense(ts, "llm", usd, note),
                          budget.llm_today_left_usd)
        st = Superteam(store)
        try:
            Worker(store, st, llm, budget, ts, pol.get("allow_auto_submit", False), log).run()
            last_action = "worked agent bounties"
        except Exception as e:
            log(f"  worker failed: {e!r}")
            notes.append(f"worker error: {e!r}"[:200])
        if st.registered and not store.kv_get("claimed"):
            notes.append(f"Claim payouts once at {st.claim_url}")
        store.commit()

        micro_left = (pol["hard_caps"].get("max_micro_jobs_per_day", 10)
                      - store.submissions_since(today, micro=True))
        if budget.can("agent_bounties") and pol.get("allow_auto_submit") and micro_left > 0:
            try:
                BBWorker(store, BountyBook(), llm, ts, micro_left, log).run()
                last_action = "worked agent bounties + BountyBook jobs"
            except Exception as e:
                log(f"  bountybook worker failed: {e!r}")
                notes.append(f"bountybook error: {e!r}"[:200])
            store.commit()

        # weekly: research new ways to earn (never spends the last of the work budget on it)
        if discovery.due(store) and budget.llm_budget_left_usd - llm.spent >= discovery.MIN_LIFETIME_BUDGET:
            try:
                n = discovery.run(store, llm, ts, log)
                if n:
                    notes.append(f"{n} new money-making idea(s) found - review them on the dashboard")
            except Exception as e:
                log(f"  discovery failed: {e!r}")
    pending = len(store.ideas("proposed"))
    if pending:
        notes.append(f"{pending} discovered idea(s) waiting for your approve/reject")

    if budget.live_trading:
        notes.append(f"LIVE TRADING UNLOCKED with ${budget.trading_capital_usd} - live executor is not "
                     "built yet; it gets built and reviewed when this first happens")
    notes += budget.blocked

    status = {
        "time": ts, "tier": budget.tier, "profit_usd": budget.profit_usd,
        "income_usd": round(store.total("ledger"), 2), "expenses_usd": round(store.total("expenses"), 4),
        "llm_budget_left_usd": budget.llm_budget_left_usd, "trading_capital_usd": budget.trading_capital_usd,
        "live_trading": budget.live_trading, "paper": pstats, "unlocks": budget.unlocks, "notes": notes,
    }
    STATUS.write_text(json.dumps(status, indent=2), encoding="utf-8")
    (ROOT / "data" / "heartbeat.json").write_text(json.dumps({
        "status": "degraded" if any("error" in n for n in notes) else "ok",
        "agentName": os.environ.get("EARNER_AGENT_NAME", "earner-agent"), "time": ts, "version": "0.2",
        "capabilities": budget.unlocks, "lastAction": last_action, "nextAction": "next scheduled cycle",
    }, indent=2), encoding="utf-8")
    from .cli import write_report
    write_report(store, ts, new, total, status)
    for n in notes:
        log(f"  note: {n}")
    return status
