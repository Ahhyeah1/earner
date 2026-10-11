"""Publishes the agent's ranked opportunities to the paid feed (Cloudflare Workers KV).

Only listing metadata and links go out (title, link, reward, deadline, our score and reasons):
never descriptions, submissions, wallet details or anything from .env.
"""
import json
import os
import urllib.request
from datetime import datetime, timezone

MAX_WORK, MAX_LONGSHOT = 50, 10
# Sources whose terms forbid redistributing their listings. OpenTask Terms §10: API access must not be
# used to "bulk extract marketplace data". The agent still scouts them for its own use (§5 allows it).
EXCLUDED_SOURCES = {"opentask"}
FIELDS = ("source", "title", "url", "reward_usd", "reward_token", "deadline", "competition", "agent_allowed")


def _open(deadline, now):
    if not deadline:
        return True
    try:
        return datetime.fromisoformat(deadline.replace("Z", "+00:00")) > now
    except ValueError:
        return True


def build(store, now=None):
    now = now or datetime.now(timezone.utc)
    items = []
    for track, limit in (("work", MAX_WORK), ("longshot", MAX_LONGSHOT)):
        rows = store.db.execute(
            "SELECT * FROM opps WHERE track=? AND score IS NOT NULL AND status NOT IN ('gone','rejected') "
            "ORDER BY score DESC", (track,)).fetchall()
        n = 0
        for r in rows:
            d = json.loads(r["data"])
            if d.get("source") in EXCLUDED_SOURCES or not _open(d.get("deadline"), now):
                continue
            items.append({**{k: d.get(k) for k in FIELDS}, "track": track, "score": r["score"],
                          "reasons": json.loads(r["reasons"] or "[]")})
            n += 1
            if n >= limit:
                break
    return {"generated_at": now.isoformat(timespec="seconds"), "count": len(items), "opportunities": items}


def configured():
    return all(os.environ.get(k) for k in ("CF_ACCOUNT_ID", "CF_API_TOKEN", "CF_KV_NAMESPACE_ID"))


def publish(feed):
    url = (f"https://api.cloudflare.com/client/v4/accounts/{os.environ['CF_ACCOUNT_ID']}/storage/kv/"
           f"namespaces/{os.environ['CF_KV_NAMESPACE_ID']}/values/feed")
    req = urllib.request.Request(url, data=json.dumps(feed).encode(), method="PUT", headers={
        "Authorization": f"Bearer {os.environ['CF_API_TOKEN']}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        resp = json.loads(r.read())
    if not resp.get("success"):
        raise RuntimeError(f"KV write failed: {resp.get('errors')}")
    return feed["count"]
