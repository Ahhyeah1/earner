"""Superteam Earn Agent API client (https://superteam.fun/earn/agents/).

Only listings marked AGENT_ALLOWED / AGENT_ONLY are visible or submittable through it,
so the agent cannot submit to human-only bounties even by mistake.
Payouts require a one-time human claim: https://superteam.fun/earn/claim/<claimCode>
"""
import json
import urllib.error
import urllib.request

BASE = "https://superteam.fun"
UA = "earner/0.2"


class ApiError(Exception):
    def __init__(self, status, body):
        super().__init__(f"HTTP {status}: {body[:300]}")
        self.status = status


class Superteam:
    def __init__(self, store, base=BASE):
        self.store = store
        self.base = base
        self.creds = store.kv_get("superteam_agent")

    def _req(self, method, path, body=None, auth=True):
        headers = {"User-Agent": UA, "Content-Type": "application/json"}
        if auth:
            headers["Authorization"] = f"Bearer {self.creds['apiKey']}"
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read().decode("utf-8") or "null")
        except urllib.error.HTTPError as e:
            raise ApiError(e.code, e.read().decode("utf-8", "replace")) from None

    @property
    def registered(self):
        return bool(self.creds and self.creds.get("apiKey"))

    def register(self, name):
        resp = self._req("POST", "/api/agents", {"name": name}, auth=False)
        self.creds = {k: resp.get(k) for k in ("apiKey", "claimCode", "agentId", "username")}
        self.store.kv_set("superteam_agent", self.creds)
        self.store.commit()
        return self.creds

    @property
    def claim_url(self):
        return f"{self.base}/earn/claim/{self.creds['claimCode']}" if self.registered else None

    def live_listings(self, take=50):
        resp = self._req("GET", f"/api/agents/listings/live?take={take}")
        return resp if isinstance(resp, list) else (resp or {}).get("listings", resp or [])

    def details(self, slug):
        return self._req("GET", f"/api/agents/listings/details/{slug}")

    def submit(self, listing_id, link, other_info, eligibility_answers, ask=None, telegram=None):
        body = {"listingId": listing_id, "link": link or "", "otherInfo": other_info,
                "eligibilityAnswers": eligibility_answers, "ask": ask}
        if telegram:
            body["telegram"] = telegram
        return self._req("POST", "/api/agents/submissions/create", body)
