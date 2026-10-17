"""BountyBook (https://bountybook.ai) client: small test-verified jobs paid in USDC on Base.

Claiming and submitting are free. ONE submission per job: a failed verification refunds the
poster and the job is gone, so the worker only submits work that already passed the job's tests.
"""
import json
import time
import urllib.error
import urllib.request

from . import evm

BASE = "https://api.bountybook.ai"
UA = "earner/0.3"


class ApiError(Exception):
    def __init__(self, status, body):
        super().__init__(f"HTTP {status}: {body[:300]}")
        self.status = status


class BountyBook:
    def __init__(self, base=BASE):
        self.base = base
        self.addr = evm.load_or_create()["address"]
        self._token, self._exp = None, 0

    def _req(self, method, path, body=None, auth=False):
        headers = {"User-Agent": UA, "Content-Type": "application/json"}
        if auth:
            headers["Authorization"] = f"Bearer {self._session()}"
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=90) as r:
                return json.loads(r.read().decode("utf-8") or "null")
        except urllib.error.HTTPError as e:
            raise ApiError(e.code, e.read().decode("utf-8", "replace")) from None

    def _session(self):
        if self._token and time.time() < self._exp - 300:
            return self._token
        nonce = self._req("GET", f"/auth/nonce?address={self.addr}")["nonce"]
        resp = self._req("POST", "/auth/verify", {"address": self.addr, "signature": evm.sign(nonce)})
        self._token = resp["token"]
        exp = resp.get("expiresAt") or time.time() + 3600
        self._exp = exp / 1000 if exp > 1e11 else exp       # ms or s epoch
        return self._token

    def login(self):
        return bool(self._session())

    def open_jobs(self, max_pages=10):
        jobs, page = [], 1
        while page <= max_pages:
            d = self._req("GET", f"/jobs?status=open&page={page}")
            jobs += d.get("jobs", [])
            if page >= d.get("totalPages", 1):
                break
            page += 1
        return jobs

    def claim(self, job_id):
        return self._req("POST", f"/jobs/{job_id}/claim", {"executorAddress": self.addr}, auth=True)

    def submit(self, job_id, files):
        return self._req("POST", f"/jobs/{job_id}/submit",
                         # Paid jobs check `required_fields` as top-level keys of outputData, so every file is also
                         # sent as its own field (the nested "files" object alone was read as "0 lines of code").
                         {"executorAddress": self.addr, "outputData": {**files, "files": files}}, auth=True)

    def status(self, job_id):
        return self._req("GET", f"/jobs/{job_id}/status")

    def profile(self):
        try:
            return self._req("GET", f"/agents/{self.addr}")
        except ApiError:
            return None
