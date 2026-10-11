"""Opportunity sources. Each fetcher returns a list of normalized opportunity dicts.

All sources are public, read-only, unauthenticated endpoints. Nothing here spends
money, signs transactions or submits anything on the user's behalf.
"""
import json
import os
import re
import urllib.parse
import urllib.request
from datetime import datetime, timezone

UA = "earner/0.1 (+opportunity scout)"
STABLES = {"USDC", "USDT", "USDG", "PYUSD", "DAI", "USD"}


def _get_json(url, headers=None, timeout=30):
    req = urllib.request.Request(url, headers={"User-Agent": UA, **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def _opp(**kw):
    base = {
        "source": None, "ext_id": None, "title": "", "url": "", "reward_usd": None,
        "reward_token": None, "deadline": None, "competition": None,
        "agent_allowed": False, "kyc": None, "kind": None, "region": None, "notes": "",
    }
    base.update(kw)
    base["id"] = f"{base['source']}:{base['ext_id']}"
    return base


# Words in a listing title that usually mean "residents/students of X only".
_REGION_HINTS = re.compile(
    r"t[uü]rkiye|turkey|brazil|brasil|🇧🇷|india|nigeria|vietnam|ukrain|kra[kc][oó]w|warsaw|poland|"
    r"germany|uae|malaysia|philippines|indonesia|mexico|m[eé]xico|argentina|balkan|madrid|spain|"
    r"university|\buni\b|student", re.I)


def _title_region(title):
    m = _REGION_HINTS.search(title or "")
    return f"'{m.group(0)}' (from title)" if m else None


def fetch_superteam(take=200):
    """Superteam Earn bounties (Solana ecosystem, paid in crypto)."""
    out = []
    for x in _get_json(f"https://earn.superteam.fun/api/listings?take={take}"):
        if x.get("status") != "OPEN":
            continue
        token = (x.get("token") or "").upper()
        amt = x.get("rewardAmount")
        # "Up to 4,000 USDC each" -> rewardAmount is the whole pool; one winner gets the cap
        each = re.search(r"([\d,]+)\s*(?:USDC|USDT|USDG|\$)?\s*each", x["title"], re.I)
        if amt and each:
            amt = min(float(amt), float(each.group(1).replace(",", "")))
        chapter = ((x.get("sponsor") or {}).get("chapter") or {}).get("name") or _title_region(x["title"])
        out.append(_opp(
            source="superteam", ext_id=x["id"], title=x["title"],
            url=f"https://earn.superteam.fun/listing/{x['slug']}",
            reward_usd=float(amt) if amt and token in STABLES else None,
            reward_token=token or None, deadline=x.get("deadline"),
            competition=(x.get("_count") or {}).get("Submission"),
            agent_allowed=x.get("agentAccess") == "AGENT_ALLOWED",
            kind=x.get("type"),
            region=chapter,
            notes=f"sponsor={(x.get('sponsor') or {}).get('name')}; agentAccess={x.get('agentAccess')}",
        ))
    return out


def fetch_immunefi():
    """Immunefi bug-bounty programs. Long-shot, high-ceiling; local-fork testing only."""
    out = []
    for x in _get_json("https://immunefi.com/public-api/bounties.json", timeout=60):
        if x.get("isPaused") or x.get("inviteOnly"):
            continue
        out.append(_opp(
            source="immunefi", ext_id=x["slug"], title=f"{x.get('project')} bug bounty",
            url=f"https://immunefi.com/bug-bounty/{x['slug']}/",
            reward_usd=float(x.get("maxBounty") or 0) or None,
            reward_token=x.get("rewardsToken"), deadline=x.get("endDate"),
            competition=None, agent_allowed=False, kyc=bool(x.get("kyc")),
            kind="bug-bounty",
            notes=f"assets={len(x.get('assets') or [])}; launched={(x.get('launchDate') or '')[:10]}; "
                  f"updated={(x.get('updatedDate') or '')[:10]}",
        ))
    return out


_USD_RE = re.compile(r"(?:\$\s?([\d,]+(?:\.\d+)?)\s*(k)?\b|([\d,]+(?:\.\d+)?)\s*(USDC|USDT|USD)\b)", re.I)


def parse_usd(text):
    """Pull a dollar/stablecoin amount out of free text. Ignores '$TICKER' self-issued tokens."""
    for m in _USD_RE.finditer(text or ""):
        num = m.group(1) or m.group(3)
        try:
            val = float(num.replace(",", ""))
        except ValueError:
            continue
        if m.group(2):
            val *= 1000
        if val > 0:
            return val
    return None


def fetch_github(query="label:bounty state:open (solana OR ethereum OR web3 OR crypto)",
                 per_page=100, min_stars=25, max_repo_checks=20):
    """GitHub issues labelled bounty in crypto repos. Heavily filtered: this space is full of
    self-issued-token 'bounties' and bounty-farm repos."""
    headers = {"Accept": "application/vnd.github+json"}
    if os.environ.get("GITHUB_TOKEN"):
        headers["Authorization"] = f"Bearer {os.environ['GITHUB_TOKEN']}"
    q = urllib.parse.quote(query)
    items = _get_json(f"https://api.github.com/search/issues?q={q}&per_page={per_page}&sort=created",
                      headers)["items"]
    cands = []
    for i in items:
        usd = parse_usd(i["title"]) or parse_usd((i.get("body") or "")[:2000])
        if usd:
            cands.append((i, usd))
    stars = {}
    out = []
    for i, usd in sorted(cands, key=lambda c: -c[1]):
        repo = i["repository_url"].split("/repos/", 1)[1]
        if repo not in stars:
            if len(stars) >= max_repo_checks:
                continue
            try:
                stars[repo] = _get_json(i["repository_url"], headers).get("stargazers_count", 0)
            except Exception:
                stars[repo] = 0
        if stars[repo] < min_stars:
            continue
        out.append(_opp(
            source="github", ext_id=str(i["id"]), title=i["title"], url=i["html_url"],
            reward_usd=usd, reward_token="USD?", deadline=None, competition=i.get("comments"),
            agent_allowed=False, kind="code-bounty",
            notes=f"repo={repo}; stars={stars[repo]}; opened={i['created_at'][:10]}",
        ))
    return out


def fetch_opentask():
    """OpenTask agent-to-agent marketplace (scouted only; bidding is a later approved build)."""
    out = []
    for x in _get_json("https://opentask.ai/api/tasks?sort=new").get("tasks", []):
        cur = (x.get("budgetCurrency") or "").upper()
        try:
            amt = float(x.get("budgetAmount") or 0)
        except ValueError:
            amt = 0
        out.append(_opp(
            source="opentask", ext_id=x["id"], title=x.get("title", ""),
            url=f"https://opentask.ai/tasks/{x['id']}",
            reward_usd=amt if amt and cur in STABLES else None, reward_token=cur or None,
            deadline=x.get("deadline"), competition=None, agent_allowed=True,
            kind=x.get("executionMode"), notes=f"mode={x.get('executionMode')}",
        ))
    return out


SOURCES = {"superteam": fetch_superteam, "immunefi": fetch_immunefi, "github": fetch_github,
           "opentask": fetch_opentask}


def now():
    return datetime.now(timezone.utc)
