"""earner CLI.

  python -m earner run                one full autonomous cycle (scheduled every 2h)
  python -m earner ui [port]          dashboard at http://127.0.0.1:8765
  python -m earner discover           research new ways to earn now (also runs weekly by itself)
  python -m earner ideas [status]     list discovered ideas
  python -m earner idea-approve <id>  approve -> work/ideas/<id>/BUILD_PLAN.md
  python -m earner idea-reject <id>
  python -m earner episode-pack [iso] citable source pack of the agent's records (YouTube series)
  python -m earner status             tier, budget, paper record, recent agent submissions
  python -m earner scout              fetch all sources, score, write reports/YYYY-MM-DD.md
  python -m earner list [status]      show opportunities (default: approved)
  python -m earner approve <id>       approve; creates work/<id>/BRIEF.md to work from
  python -m earner reject <id> [why]
  python -m earner submitted <id>     you submitted the work
  python -m earner won <id> <amount> <token> <usd> [tx]
  python -m earner lost <id>
  python -m earner ledger             earnings to date

Autopilot submits only to listings that explicitly allow AI agents, within policy.json limits.
It never signs transactions or holds keys.
"""
import json
import re
import sys
from pathlib import Path

from . import sources
from .score import score
from .store import Store

ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / "data" / "earner.db"
REPORTS = ROOT / "reports"
WORK = ROOT / "work"


def _ts():
    return sources.now().isoformat(timespec="seconds")


def cmd_scout(store, args):
    from .autopilot import scout
    ts = _ts()
    total, new = scout(store, ts)
    print(f"{total} live, {new} new -> {write_report(store, ts, new, total)}")


def cmd_run(store, args):
    """One full autonomous cycle (what the scheduler runs)."""
    from .autopilot import run
    run(store)


def cmd_discover(store, args):
    """Run strategy research now (costs ~$0.30-1 of Claude budget)."""
    from . import discovery, llm as L, policy
    from .autopilot import compute_budget
    from . import paper
    ts = _ts()
    b = compute_budget(store, policy.load(), ts[:10], paper.stats(store.kv_get("paper") or {}))
    llm = L.LLM(lambda usd, note: store.add_expense(ts, "llm", usd, note), b.llm_today_left_usd)
    print(f"{discovery.run(store, llm, ts, force=True)} new idea(s); cost ${llm.spent:.2f}")


def cmd_ideas(store, args):
    for r in store.ideas(args[0] if args else None):
        print(f"{r['score']:>5}  {r['status']:<9} {'API ok ' if r['probe_ok'] else 'no API '} {r['id']:<40} {r['url']}")


def decide_idea(store, idea_id, approve):
    from .discovery import build_plan
    row = store.db.execute("SELECT * FROM ideas WHERE id=?", (idea_id,)).fetchone()
    if row is None:
        return None
    store.set_idea_status(idea_id, "approved" if approve else "rejected")
    store.commit()
    return build_plan(row, WORK / "ideas" / idea_id) if approve else True


def cmd_idea_approve(store, args):
    print(decide_idea(store, args[0], True) or "no such idea")


def cmd_idea_reject(store, args):
    print("rejected" if decide_idea(store, args[0], False) else "no such idea")


def cmd_episode_pack(store, args):
    """Citable source pack of the agent's records for the YouTube series."""
    from .episode_pack import build
    from .evm import address
    until = args[0] if args else _ts()
    try:
        evm = address()
    except Exception:
        evm = None
    print(build(store, until, agent_evm=evm))


def cmd_ui(store, args):
    from .ui import serve
    store.db.close()
    serve(int(args[0]) if args else 8765)


def cmd_status(store, args):
    from .autopilot import STATUS
    print(STATUS.read_text(encoding="utf-8") if STATUS.exists() else "no cycle has run yet")
    for r in store.recent_submissions(10):
        print(f"{r['ts'][:16]}  {r['decision']:<9} {(r['slug'] or '')[:45]:<45} {(r['reason'] or '')[:60]}")


def _row_md(r, i):
    reasons = "; ".join(json.loads(r["reasons"] or "[]"))
    return f"{i}. **[{r['title']}]({r['url']})** — score {r['score']}  \n   `{r['id']}` — {reasons}"


def write_report(store, ts, new, total, status=None):
    REPORTS.mkdir(exist_ok=True)
    day = ts[:10]
    lines = [f"# Earner scout — {day}", "",
             f"{total} live opportunities, {new} new since last run. "
             "Approve with `python -m earner approve <id>`.", ""]
    if status:
        p = status["paper"]
        lines += ["## Autopilot", "",
                  f"- Tier **{status['tier']}** - profit ${status['profit_usd']} "
                  f"(income ${status['income_usd']}, expenses ${status['expenses_usd']})",
                  f"- LLM budget left ${status['llm_budget_left_usd']}; trading capital "
                  f"${status['trading_capital_usd']} (live: {status['live_trading']})",
                  f"- Paper: ${p['equity']} ({p['return_pct']:+}%, max DD {p['max_drawdown_pct']}%, "
                  f"{p['days']} days)"] + [f"- {n}" for n in status["notes"]] + [""]
        subs = store.recent_submissions(10)
        if subs:
            lines += ["### Agent bounty log", ""] + [
                f"- {r['ts'][:16]} **{r['decision']}** {r['slug']}: {r['reason']}" for r in subs] + [""]
    approved = store.by_status("approved") + store.by_status("submitted")
    if approved:
        lines += ["## In progress", ""] + [f"- [{r['status']}] [{r['title']}]({r['url']}) `{r['id']}`"
                                           for r in approved] + [""]
    lines += ["## Work bounties (defined deliverable)", ""]
    lines += [_row_md(r, i) for i, r in enumerate(store.ranked("work", limit=10), 1)] or ["_none_"]
    lines += ["", "## Long shots (bug bounties — local-fork testing only, never mainnet)", ""]
    lines += [_row_md(r, i) for i, r in enumerate(store.ranked("longshot", limit=5), 1)] or ["_none_"]
    earned = sum(r["usd"] or 0 for r in store.ledger())
    lines += ["", f"**Earned to date:** ${earned:,.2f}", ""]
    path = REPORTS / f"{day}.md"
    path.write_text("\n".join(lines), encoding="utf-8")
    return path


def _need(store, opp_id):
    r = store.get(opp_id)
    if r is None:
        sys.exit(f"no unique opportunity matching {opp_id!r}")
    return r


def cmd_approve(store, args):
    r = _need(store, args[0])
    store.set_status(r["id"], "approved", _ts())
    store.commit()
    o = json.loads(r["data"])
    folder = WORK / re.sub(r"[^\w.-]+", "_", r["id"])[:80]
    folder.mkdir(parents=True, exist_ok=True)
    rules = ("Agents are allowed on this listing: an AI may draft the full submission."
             if o.get("agent_allowed") else
             "HUMAN-ONLY listing: use the agent for research/drafting help, but the submission must be "
             "genuinely yours. Check the listing's rules before using AI output.")
    if o["source"] == "immunefi":
        rules = ("Bug bounty: read scope + prohibited activities first. Test ONLY on a local fork. "
                 "Never touch mainnet/testnet deployments. No public disclosure.")
    (folder / "BRIEF.md").write_text(
        f"# {o['title']}\n\n{o['url']}\n\n"
        f"- Reward: {o.get('reward_usd')} ({o.get('reward_token')})\n"
        f"- Deadline: {o.get('deadline')}\n- Competition: {o.get('competition')}\n"
        f"- Notes: {o.get('notes')}\n- Why it scored: {'; '.join(json.loads(r['reasons']))}\n\n"
        f"## Rules\n\n{rules}\n\n"
        "## Checklist\n\n- [ ] Read the full listing and judging criteria\n"
        "- [ ] Decide: realistic to win in time? If not, `python -m earner reject`\n"
        "- [ ] Do the work in this folder (open Claude Code here to help)\n"
        "- [ ] Submit yourself, then `python -m earner submitted <id>`\n"
        "- [ ] Paid? `python -m earner won <id> <amount> <token> <usd> <tx>`\n",
        encoding="utf-8")
    print(f"approved {r['id']} -> {folder / 'BRIEF.md'}")


def _status(new_status):
    def run(store, args):
        r = _need(store, args[0])
        store.set_status(r["id"], new_status, _ts(), " ".join(args[1:]))
        store.commit()
        print(f"{r['id']} -> {new_status}")
    return run


def cmd_won(store, args):
    if len(args) < 4:
        sys.exit("usage: won <id> <amount> <token> <usd> [tx]")
    r = _need(store, args[0])
    ts = _ts()
    store.add_earning(ts, r["id"], float(args[1]), args[2], float(args[3]),
                      args[4] if len(args) > 4 else "", r["title"])
    store.set_status(r["id"], "won", ts)
    store.commit()
    print(f"logged {args[1]} {args[2]} (${float(args[3]):,.2f}) for {r['id']}")


def cmd_list(store, args):
    for r in store.by_status(args[0] if args else "approved"):
        print(f"{r['score']!s:>6}  {r['id']:<50}  {r['title'][:70]}")


def cmd_ledger(store, args):
    total = 0.0
    for r in store.ledger():
        total += r["usd"] or 0
        print(f"{r['ts'][:10]}  {r['amount']:>10} {r['token']:<6} ${r['usd']:>9,.2f}  {r['note'][:50]}")
    print(f"total ${total:,.2f}")


COMMANDS = {
    "run": cmd_run, "ui": cmd_ui, "discover": cmd_discover, "episode-pack": cmd_episode_pack, "ideas": cmd_ideas,
    "idea-approve": cmd_idea_approve, "idea-reject": cmd_idea_reject, "status": cmd_status, "scout": cmd_scout, "approve": cmd_approve, "reject": _status("rejected"),
    "submitted": _status("submitted"), "lost": _status("lost"), "won": cmd_won,
    "list": cmd_list, "ledger": cmd_ledger,
}


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if not argv or argv[0] not in COMMANDS:
        print(__doc__)
        return 1
    COMMANDS[argv[0]](Store(DB), argv[1:])
    return 0
