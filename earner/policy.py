"""Turns the user's policy.json + the treasury's real numbers into what the agent may do.

The agent "sets its own budget" only here, and only as a function of realized profit:
  operating budget = bootstrap allowance + reinvest_pct * profit
  trading capital  = min(trading_pct * profit, hard cap)   (and only if every gate passes)
"""
import json
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
POLICY = ROOT / "policy.json"


def load(path=POLICY):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


@dataclass
class Budget:
    tier: str
    profit_usd: float
    unlocks: list
    llm_budget_left_usd: float          # lifetime operating budget minus lifetime LLM spend
    llm_today_left_usd: float
    submissions_today_left: int
    trading_capital_usd: float
    live_trading: bool
    blocked: list = field(default_factory=list)   # human-readable reasons something stays locked

    def can(self, unlock):
        return unlock in self.unlocks


def compute(policy, income_usd, expenses_usd, llm_spent_total, llm_spent_today,
            submissions_today, paper_stats=None):
    profit = income_usd - expenses_usd
    tier = policy["tiers"][0]
    for t in policy["tiers"]:
        if profit >= t["min_profit_usd"]:
            tier = t
    caps = policy["hard_caps"]
    blocked = []

    operating = policy.get("bootstrap_llm_usd", 0) + tier["reinvest_pct"] * max(profit, 0)
    llm_left = max(0.0, operating - llm_spent_total)
    llm_today = max(0.0, min(caps["max_llm_usd_per_day"] - llm_spent_today, llm_left))
    if llm_left <= 0:
        blocked.append(f"LLM budget exhausted (${operating:.2f} allowed, ${llm_spent_total:.2f} spent)")

    trading = 0.0
    live = False
    if "live_trading" in tier["unlocks"]:
        trading = min(tier["trading_pct"] * max(profit, 0), caps["max_trading_capital_usd"])
        gate = policy["live_trading_gate"]
        ps = paper_stats or {}
        if not policy.get("allow_live_trading"):
            blocked.append("live trading tier reached but allow_live_trading=false in policy.json")
        elif ps.get("days", 0) < gate["min_paper_days"]:
            blocked.append(f"paper record {ps.get('days', 0)}/{gate['min_paper_days']} days")
        elif ps.get("return_pct", -1e9) < gate["min_paper_return_pct"]:
            blocked.append(f"paper return {ps.get('return_pct'):.1f}% below gate")
        elif ps.get("max_drawdown_pct", 1e9) > gate["max_paper_drawdown_pct"]:
            blocked.append(f"paper drawdown {ps.get('max_drawdown_pct'):.1f}% above gate")
        else:
            live = trading > 0
    else:
        nxt = next((t for t in policy["tiers"] if "live_trading" in t["unlocks"]), None)
        if nxt:
            blocked.append(f"live trading unlocks at ${nxt['min_profit_usd']} profit (now ${profit:.2f})")

    return Budget(
        tier=tier["name"], profit_usd=round(profit, 2), unlocks=list(tier["unlocks"]),
        llm_budget_left_usd=round(llm_left, 4), llm_today_left_usd=round(llm_today, 4),
        submissions_today_left=max(0, caps["max_submissions_per_day"] - submissions_today),
        trading_capital_usd=round(trading if live else 0.0, 2), live_trading=live, blocked=blocked,
    )
