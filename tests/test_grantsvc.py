import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from earner import grantsvc as gs
from earner.store import Store

TS = "2026-10-15T10:00:00+00:00"
INTAKE = {"project": "SolTool", "contact": "@soltool", "url": "https://soltool.dev", "what": "A dev tool",
          "stage": "devnet", "country": "Germany", "ask": "$10k", "program": "", "deadline": ""}


def client_out(fit="good"):
    return {"fit": fit, "recommended_programs": [{"name": "Solana Foundation Germany Grants", "url": "https://x",
                                                   "why": "German team", "eligibility_risk": "low"}],
            "application_markdown": "# App\n[ASK CLIENT: users]", "questions_for_client": ["How many users?"],
            "reply_to_client": "Hi! Germany grants fit. Pay here: {PAY_LINK}"}


class FakeLLM:
    def __init__(self, out):
        self.out = out

    def json(self, *a, **k):
        return self.out


class Base(unittest.TestCase):
    def setUp(self):
        d = tempfile.TemporaryDirectory()
        self.addCleanup(d.cleanup)
        self.st = Store(Path(d.name) / "t.db")
        self.addCleanup(self.st.db.close)
        p = mock.patch.object(gs, "OUT", Path(d.name) / "grants")
        p.start()
        self.addCleanup(p.stop)
        e = mock.patch.dict(os.environ, {"EARNER_PAYOUT_WALLET": "4px5eCg2hVXzFY4jguRQmQ4YUyJ5pXPPLJGPnHba6GLg",
                                         "CF_ACCOUNT_ID": "a", "CF_API_TOKEN": "t", "CF_KV_NAMESPACE_ID": "n"})
        e.start()
        self.addCleanup(e.stop)
        q = mock.patch.object(gs, "open_programs", return_value=[{"title": "Solana Foundation Germany Grants"}])
        q.start()
        self.addCleanup(q.stop)


class Helpers(unittest.TestCase):
    def test_b58_known_vectors(self):
        self.assertEqual(gs.b58(b"\x00\x00\x01"), "112")
        self.assertEqual(gs.b58(bytes(32)), "1" * 32)
        self.assertEqual(gs.b58(b"hello world"), "StV1DL6CwTryKyV")

    def test_pay_link_is_solana_pay_usdc(self):
        link = gs.pay_link("Wallet111", 149, "Ref111", "earner grants", "Grant: X")
        self.assertTrue(link.startswith("solana:Wallet111?"))
        self.assertIn("amount=149", link)
        self.assertIn("spl-token=" + gs.USDC, link)
        self.assertIn("reference=Ref111", link)


class Clients(Base):
    def pull(self):
        def cf(path, method="GET"):
            if path.startswith("keys"):
                return {"result": [{"name": "intake:1:abc"}]}
            return "" if method == "DELETE" else json.dumps(INTAKE)
        with mock.patch.object(gs, "_cf", side_effect=cf) as m:
            gs.pull_intakes(self.st, TS, log=lambda *_: None)
        return m

    def test_intake_to_ready_draft_with_pay_link(self):
        m = self.pull()
        self.assertTrue(any(c.kwargs.get("method") == "DELETE" for c in m.call_args_list))   # removed from KV
        sent = []
        gs.draft_clients(self.st, FakeLLM(client_out()), TS, lambda *a, **k: sent.append(a), log=lambda *_: None)
        row = self.st.db.execute("SELECT * FROM submissions WHERE listing_id='client:1:abc'").fetchone()
        self.assertEqual(row["decision"], "ready")
        p = json.loads(row["payload"])
        text = Path(p["path"]).read_text(encoding="utf-8")
        self.assertIn(p["pay_link"], text)                      # placeholder replaced by the real link
        self.assertNotIn("{PAY_LINK}", text)
        self.assertEqual(len(sent), 1)

    def test_no_fit_is_not_offered(self):
        self.pull()
        sent = []
        gs.draft_clients(self.st, FakeLLM(client_out("no")), TS, lambda *a, **k: sent.append(a), log=lambda *_: None)
        row = self.st.db.execute("SELECT decision FROM submissions").fetchone()
        self.assertEqual(row["decision"], "owner_skipped")
        self.assertEqual(sent, [])

    def test_payment_detected_once(self):
        self.pull()
        gs.draft_clients(self.st, FakeLLM(client_out()), TS, None, log=lambda *_: None)
        resp = io.BytesIO(json.dumps({"result": [{"signature": "sig1", "err": None}]}).encode())
        sent = []
        with mock.patch.object(gs.urllib.request, "urlopen", return_value=mock.MagicMock(
                __enter__=lambda s: resp, __exit__=lambda *a: False)):
            gs.check_payments(self.st, "https://rpc", lambda *a, **k: sent.append(a), log=lambda *_: None)
        p = json.loads(self.st.db.execute("SELECT payload FROM submissions").fetchone()[0])
        self.assertTrue(p["paid"])
        self.assertEqual(p["paid_tx"], "sig1")
        self.assertEqual(len(sent), 1)


class Leads(Base):
    def test_only_contactable_projects_become_leads(self):
        repos = {"items": [
            {"full_name": "a/good", "owner": {"url": "u1"}, "description": "x", "stargazers_count": 9,
             "created_at": "2026-09-01T00:00:00Z", "homepage": "https://good.dev", "html_url": "https://github.com/a/good"},
            {"full_name": "b/hidden", "owner": {"url": "u2"}, "description": "y", "stargazers_count": 5,
             "created_at": "2026-09-01T00:00:00Z", "homepage": None, "html_url": "https://github.com/b/hidden"}]}
        users = {"u1": {"type": "Organization", "twitter_username": "gooddev"}, "u2": {"type": "User"}}
        get = lambda url, headers=None, timeout=30: repos if "search" in url else users[url]  # noqa: E731
        llm = FakeLLM({"worth_contacting": True, "suggested_program": "SF grants", "why": "fits", "message": "Hi"})
        with mock.patch.object(gs, "_get", side_effect=get):
            made = gs.find_leads(self.st, llm, TS, n=3, log=lambda *_: None)
        self.assertEqual(made, 1)
        rows = {r["listing_id"]: r["decision"] for r in self.st.db.execute("SELECT * FROM submissions")}
        self.assertEqual(rows, {"lead:a/good": "ready", "lead:b/hidden": "skipped"})


if __name__ == "__main__":
    unittest.main()
