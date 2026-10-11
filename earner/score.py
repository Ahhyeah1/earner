"""Rule-based scoring. Higher = better expected payout per unit of effort.

Two tracks are ranked separately because they are not comparable:
  - "work":     bounties with a defined deliverable (Superteam, GitHub). EV ~ reward / competitors.
  - "longshot": open-ended bug-bounty programs (Immunefi). Huge ceilings, low hit rate.
"""
import math
import os
from datetime import datetime, timezone

MIN_DAYS_LEFT = 2          # less than this is not enough time to do real work
ASSUMED_COMPETITION = 5    # when a source does not expose submission counts
MIN_REWARD_USD = 50
# Regional chapters you are eligible for, lowercase (e.g. "superteam sweden"). Others are penalized.
HOME_REGIONS = {r.strip().lower() for r in os.environ.get("EARNER_REGIONS", "").split(",") if r.strip()}


def _days_left(deadline, now):
    if not deadline:
        return None
    try:
        d = datetime.fromisoformat(deadline.replace("Z", "+00:00"))
    except ValueError:
        return None
    return (d - now).total_seconds() / 86400


def _days_since(datestr, now):
    try:
        d = datetime.fromisoformat(datestr + "T00:00:00+00:00")
    except (ValueError, TypeError):
        return None
    return (now - d).total_seconds() / 86400


def score(opp, now=None):
    """Return (track, score, reasons). score None = excluded."""
    now = now or datetime.now(timezone.utc)
    reasons = []
    if opp["source"] == "immunefi":
        return _score_longshot(opp, now, reasons)

    reward = opp.get("reward_usd")
    if not reward:
        return "work", None, [f"reward not in USD/stablecoin ({opp.get('reward_token')})"]
    left = _days_left(opp.get("deadline"), now)
    if left is not None and left < MIN_DAYS_LEFT:
        return "work", None, [f"only {left:.1f} days left"]

    if reward < MIN_REWARD_USD:
        return "work", None, [f"reward ${reward:,.0f} below ${MIN_REWARD_USD}"]

    comp = opp.get("competition")
    comp = ASSUMED_COMPETITION if comp is None else comp
    ev = reward / (comp + 2)
    s = 20 * math.log10(1 + ev)
    reasons.append(f"${reward:,.0f} vs {comp} competitors -> EV≈${ev:,.0f}")
    if opp.get("agent_allowed"):
        s *= 1.3
        reasons.append("agents allowed: can be drafted end-to-end")
    else:
        reasons.append("human-only: agent assists, you submit")
    region = opp.get("region")
    if region and region.lower() not in HOME_REGIONS:
        s *= 0.4
        reasons.append(f"likely restricted to {region}")
    if left is not None:
        reasons.append(f"{left:.0f} days left")
    return "work", round(s, 1), reasons


def _score_longshot(opp, now, reasons):
    reward = opp.get("reward_usd") or 0
    if reward <= 0:
        return "longshot", None, ["no max bounty"]
    left = _days_left(opp.get("deadline"), now)
    if left is not None and left < MIN_DAYS_LEFT:
        return "longshot", None, ["program ended" if left < 0 else f"only {left:.1f} days left"]
    notes = dict(p.split("=", 1) for p in opp["notes"].split("; ") if "=" in p)
    s = 10 * math.log10(1 + reward)
    reasons.append(f"max ${reward:,.0f}")
    age = _days_since(notes.get("launched"), now)
    if age is not None and age < 60:
        s *= 1.5
        reasons.append(f"launched {age:.0f}d ago (less picked-over)")
    try:
        assets = int(notes.get("assets", "0"))
    except ValueError:
        assets = 0
    if 0 < assets <= 5:
        s *= 1.2
        reasons.append(f"small scope ({assets} assets)")
    if opp.get("kyc"):
        reasons.append("KYC on payout")
    return "longshot", round(s, 1), reasons
