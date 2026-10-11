"""Episode source pack: the agent's own records as a citable, hash-pinnable document.

For the "Why It Makes Money" series about this agent. Every line is a fact read from the
agent's database or policy file - no narrative, no estimates. Deterministic for a given cut-off,
so the YouTube Engine can pin it by hash and bind script claims to its spans.

Deliberately EXCLUDED: the owner's personal payout wallet, the Superteam claim code, API keys,
submission contents, and anything from .env.
"""
import csv
import hashlib
import json
from collections import defaultdict
from pathlib import Path

from . import policy

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "episodes"
BASESCAN = "https://basescan.org/tx/"


def _usd(v):
    return f"-${abs(v):,.2f}" if v < 0 else f"${v:,.2f}"


def build(store, until, out_root=OUT, agent_evm=None):
    """until: ISO timestamp (inclusive cut-off). Returns the output folder."""
    pol = policy.load()
    q = lambda sql, *a: store.db.execute(sql, a).fetchall()  # noqa: E731

    exp = q("SELECT id, ts, usd, note FROM expenses WHERE ts <= ? ORDER BY id", until)
    inc = q("SELECT id, ts, usd, token, tx, note FROM ledger WHERE ts <= ? ORDER BY id", until)
    subs = q("SELECT id, ts, listing_id, slug, decision, reason FROM submissions WHERE ts <= ? ORDER BY id",
             until)
    ideas = q("SELECT id, name, status, score, probe_ok, first_seen FROM ideas WHERE first_seen <= ? "
              "ORDER BY score DESC", until)
    paper = store.kv_get("paper") or {}
    hist = [h for h in paper.get("history", []) if h[0] <= until[:10]]

    first = min([r["ts"] for r in exp] + [r["ts"] for r in subs] + [until])
    spent = sum(r["usd"] for r in exp)
    earned = sum(r["usd"] for r in inc)

    def src(listing_id):
        return "BountyBook" if (listing_id or "").startswith("bb:") else "Superteam Earn"

    facts = []

    def fact(section, text, ref):
        facts.append({"id": f"F-{len(facts) + 1:03d}", "section": section, "text": text, "ref": ref})

    # --- rules the owner set
    fact("rules", f"The agent started with a budget of {_usd(0)} of its own money and a one-time allowance of "
         f"{_usd(pol['bootstrap_llm_usd'])} for AI model usage.", "policy.json:bootstrap_llm_usd")
    caps = pol["hard_caps"]
    fact("rules", f"It may spend at most {_usd(caps['max_llm_usd_per_day'])} per day on AI model usage.",
         "policy.json:hard_caps.max_llm_usd_per_day")
    t = next(t for t in pol["tiers"] if "live_trading" in t["unlocks"])
    fact("rules", f"Live trading stays locked until the agent has made {_usd(t['min_profit_usd'])} in profit "
         f"and passed {pol['live_trading_gate']['min_paper_days']} days of paper trading.",
         "policy.json:tiers,live_trading_gate")

    # --- totals
    fact("totals", f"Between {first[:10]} and {until[:10]}, the agent spent {_usd(spent)} on AI model usage.",
         f"expenses rows {exp[0]['id']}-{exp[-1]['id']}" if exp else "expenses: none")
    fact("totals", f"In the same period it earned {_usd(earned)}.",
         f"ledger rows {inc[0]['id']}-{inc[-1]['id']}" if inc else "ledger: none")
    fact("totals", f"Its profit was {_usd(earned - spent)}.", "ledger minus expenses")
    by = defaultdict(lambda: defaultdict(int))
    for r in subs:
        by[src(r["listing_id"])][r["decision"]] += 1
    for s, d in sorted(by.items()):
        parts = ", ".join(f"{n} {k}" for k, n in sorted(d.items()))
        fact("totals", f"On {s}, the agent's attempts ended as: {parts}.", f"submissions where source={s}")

    # --- every attempt, in order
    for r in subs:
        fact("attempts", f"On {r['ts'][:10]}, the agent's attempt at \"{r['slug']}\" on {src(r['listing_id'])} "
             f"ended as {r['decision']}: {r['reason']}", f"submissions row {r['id']}")

    # --- income, each with a public, checkable transaction where one exists
    for r in inc:
        tx = f" Transaction: {BASESCAN}{r['tx']}" if r["tx"] else ""
        fact("income", f"On {r['ts'][:10]}, {_usd(r['usd'])} arrived ({r['note']}).{tx}", f"ledger row {r['id']}")
    if agent_evm:
        fact("income", f"The agent's public receiving address on Base is {agent_evm}.", "data/evm_wallet.json:address")

    # --- paper trading
    if hist:
        fact("paper", f"Paper trading started on {hist[0][0]} with a virtual {_usd(1000)}; on {hist[-1][0]} the "
             f"virtual portfolio was worth {_usd(hist[-1][1])}.", "kv:paper.history")

    # --- ideas the agent found itself
    for r in ideas:
        fact("ideas", f"On {r['first_seen'][:10]}, the agent proposed a new way to earn: {r['name']} "
             f"(score {r['score']}, API {'answered' if r['probe_ok'] else 'not verified'}, status {r['status']}).",
             f"ideas row {r['id']}")

    out = out_root / until[:10]
    out.mkdir(parents=True, exist_ok=True)
    lines = [f"# Agent records up to {until} (UTC)", "",
             "Every line below is read from the agent's own database or policy file. Ids are stable.", ""]
    section = None
    for f in facts:
        if f["section"] != section:
            section = f["section"]
            lines += ["", f"## {section}", ""]
        lines.append(f"{f['id']}. {f['text']}  [{f['ref']}]")
    (out / "source.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    (out / "facts.json").write_text(json.dumps({"until": until, "facts": facts}, indent=2), encoding="utf-8")

    # chart data: cumulative spend and income per day
    days = defaultdict(lambda: [0.0, 0.0])
    for r in exp:
        days[r["ts"][:10]][0] += r["usd"]
    for r in inc:
        days[r["ts"][:10]][1] += r["usd"]
    with open(out / "chart_money.csv", "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["date", "cumulative_spent_usd", "cumulative_earned_usd", "cumulative_profit_usd"])
        cs = ce = 0.0
        for d in sorted(days):
            cs += days[d][0]
            ce += days[d][1]
            w.writerow([d, f"{cs:.4f}", f"{ce:.4f}", f"{ce - cs:.4f}"])
    with open(out / "chart_paper.csv", "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["date", "virtual_equity_usd"])
        w.writerows(hist)

    sums = [f"{hashlib.sha256((out / n).read_bytes()).hexdigest()}  {n}"
            for n in ("source.md", "facts.json", "chart_money.csv", "chart_paper.csv")]
    (out / "SHA256SUMS").write_text("\n".join(sums) + "\n", encoding="utf-8")
    return out
