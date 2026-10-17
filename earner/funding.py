"""Funding watcher: grant programs that pay open-source projects once they're established (FLOSS/fund rejects
"very new projects or projects with minimal usage"). Weekly, the agent measures its own traction (GitHub, bot users,
sales, age) against each program's bar. When a bar is met it writes an application pack to work/funding/<program>/
(with a draft funding.json manifest where needed) and notifies the owner, who reviews and submits. The agent never
submits applications itself: they need the owner's identity, bank and tax details."""
import json
import os
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from . import grantsvc

REPO = "Ahhyeah1/earner"
STARTED = "2026-10-10"
KV_LAST = "funding_last_check"
KV_USERS = "funding_bot_users"
INTERVAL_DAYS = 7

# Bars are our own conservative reading of each program's rules (they publish no hard numbers).
PROGRAMS = [
    {"id": "floss-fund", "name": "FLOSS/fund (Zerodha)", "url": "https://floss.fund", "apply": "https://dir.floss.fund/submit",
     "amount": "$10,000 to $100,000 per year", "review": "quarterly", "needs_funding_json": True,
     "bar": {"age_days": 120, "github_stars": 150, "bot_users": 1000},
     "rules": ["Write a funding.json manifest (fundingjson.org) and publish it in the repo or on the project website.",
               "Submit the manifest URL at dir.floss.fund/submit; the committee reviews at the end of every quarter.",
               "Needs a bank account and the tax documents for your country; individuals are eligible.",
               "Requests: minimum $10,000, then multiples of $25,000; focus on widely used, impactful projects."]},
]


def _json(url, headers=None):
    req = urllib.request.Request(url, headers={"User-Agent": "earner-agent", **(headers or {})})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())


def github_stats():
    j = _json(f"https://api.github.com/repos/{REPO}")
    return {"github_stars": j.get("stargazers_count", 0), "github_forks": j.get("forks_count", 0)}


def bot_users(store):
    """Cumulative unique Telegram users: free-check keys (tg:free:<uid>:<day>, kept 48h) seen so far + payers."""
    seen = set(store.kv_get(KV_USERS, []))
    try:
        for prefix in ("tg:free:", "tg:credits:"):
            for k in _list_keys(prefix):
                parts = k.split(":")
                if len(parts) >= 3 and parts[2].isdigit():
                    seen.add(parts[2])
    except Exception:
        pass                                            # KV unavailable: keep last known count
    store.kv_set(KV_USERS, sorted(seen))
    return len(seen)


def _list_keys(prefix):
    import urllib.parse
    keys, cursor = [], None
    while True:
        r = grantsvc._cf(f"keys?prefix={urllib.parse.quote(prefix)}" + (f"&cursor={cursor}" if cursor else ""))
        keys += [k["name"] for k in r.get("result", [])]
        cursor = (r.get("result_info") or {}).get("cursor")
        if not cursor:
            return keys


def metrics(store, now):
    m = {"age_days": (now.date() - datetime.fromisoformat(STARTED).date()).days,
         "revenue_usd": round(sum(r["usd"] or 0 for r in store.ledger()), 2)}
    try:
        m.update(github_stats())
    except Exception:
        m.update({"github_stars": None, "github_forks": None})
    m["bot_users"] = bot_users(store) if os.environ.get("CF_API_TOKEN") else None
    return m


def ready(program, m):
    """Met when the age bar and at least one traction bar (stars or users) are met."""
    bar = program["bar"]
    traction = any((m.get(k) or 0) >= bar[k] for k in ("github_stars", "bot_users"))
    return (m.get("age_days") or 0) >= bar["age_days"] and traction


def funding_json(m):
    """Draft manifest skeleton (fundingjson.org v1). The owner fills in entity/contact and checks every field."""
    return {"version": "v1.0.0",
            "entity": {"type": "individual", "role": "owner", "name": "<your name>", "email": "<your email>",
                       "description": "<who you are>", "webpageUrl": {"url": f"https://github.com/{REPO}"}},
            "projects": [{"guid": "earner", "name": "earner",
                          "description": "Open-source autonomous agent and public tools for Solana users: on-chain rug checks, "
                                         "Lost & Found (reclaim forgotten SOL), rug radar and loss reports.",
                          "webpageUrl": {"url": f"https://github.com/{REPO}"}, "repositoryUrl": {"url": f"https://github.com/{REPO}"},
                          "licenses": ["spdx:MIT"], "tags": ["solana", "security", "open-source", "ai-agent"]}],
            "funding": {"channels": [{"guid": "bank", "type": "bank", "address": "<fill in>", "description": "<fill in>"}],
                        "plans": [{"guid": "maintain", "status": "active", "name": "Maintenance and hosting", "description": "<fill in>",
                                   "amount": 10000, "currency": "USD", "frequency": "yearly", "channels": ["bank"]}],
                        "history": []}}


def write_pack(program, m, out_root="work/funding"):
    out = Path(out_root) / program["id"]
    out.mkdir(parents=True, exist_ok=True)
    lines = [f"# {program['name']}: application pack", "",
             f"Apply: {program['apply']} · amount {program['amount']} · review {program['review']}", "",
             "## Our numbers today", *[f"- {k.replace('_', ' ')}: {v}" for k, v in m.items()], "",
             "## Their rules (check the site for changes)", *[f"- {r}" for r in program["rules"]], "",
             "## You must personally",
             "- Review and complete funding.json (identity, bank channel, plan amounts), publish it in the repo, submit the URL.",
             "- Provide the bank account and tax documents they ask for.", ""]
    (out / "APPLICATION.md").write_text("\n".join(lines), encoding="utf-8")
    if program.get("needs_funding_json"):
        (out / "funding.json").write_text(json.dumps(funding_json(m), indent=2), encoding="utf-8")
    return out


def cycle(store, ts, notify=None, log=print, now=None, out_root="work/funding"):
    now = now or datetime.fromisoformat(ts)
    last = store.kv_get(KV_LAST)
    if last and (now - datetime.fromisoformat(last)).days < INTERVAL_DAYS:
        return None
    m = metrics(store, now)
    store.kv_set(KV_LAST, now.isoformat())
    store.kv_set("funding_metrics", m)
    for p in PROGRAMS:
        if ready(p, m):
            path = write_pack(p, m, out_root)
            log(f"  funding: {p['name']} bar met -> {path}")
            if notify:
                notify(f"funding-{p['id']}", f"Ready to apply: {p['name']}",
                       f"{p['amount']}. Pack in {path}. You review and submit.", priority=4, tags=("moneybag", "memo"))
        else:
            log(f"  funding: {p['name']} not yet (age {m['age_days']}d, stars {m.get('github_stars')}, bot users {m.get('bot_users')})")
    store.commit()
    return m
