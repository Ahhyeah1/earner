import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from earner import assist, notify
from earner.sources import _opp
from earner.store import Store

TS = "2026-10-14T10:00:00+00:00"
DET = {"agentAccess": "HUMAN_ONLY", "status": "OPEN", "region": "Global", "title": "Write a guide", "rewards": {"1": 500},
       "token": "USDC", "deadline": "2026-12-01T00:00:00Z", "description": "<p>Write a guide.</p>",
       "eligibility": [{"question": "Link to your guide"}], "skills": []}


class FakeLLM:
    def __init__(self, triage):
        self.triage, self.calls = triage, []

    def json(self, system, prompt, schema, note, max_tokens=0):
        self.calls.append(note)
        if note.startswith("assist triage"):
            return self.triage
        return {"summary": "A guide outline", "draft_markdown": "# Guide\n[OWNER: your experience]",
                "eligibility_answers": [{"question": "Link to your guide", "draft_answer": "[OWNER: link]"}],
                "owner_must_do": ["Write the intro in your own words"], "submission_steps": ["Open listing", "Submit"]}


def triage(**kw):
    t = {"doable": True, "owner_minutes": 20, "ai_policy": "limited", "ai_policy_evidence": "no fully AI content",
         "eligibility_risk": "none", "reason": "ok"}
    t.update(kw)
    return t


class Assist(unittest.TestCase):
    def setUp(self):
        d = tempfile.TemporaryDirectory()
        self.addCleanup(d.cleanup)
        self.st = Store(Path(d.name) / "t.db")
        self.addCleanup(self.st.db.close)
        p = mock.patch.object(assist, "OUT", Path(d.name) / "assist")
        p.start()
        self.addCleanup(p.stop)
        self.add("g1", "write-a-guide", competition=1)

    def add(self, ext, slug, region=None, competition=1, reward=500.0):
        o = _opp(source="superteam", ext_id=ext, title=f"Bounty {ext}", url=f"https://earn.superteam.fun/listing/{slug}",
                 reward_usd=reward, deadline="2026-12-01T00:00:00Z", competition=competition, region=region)
        self.st.upsert(o, "work", 50.0, [], TS)

    def run_prepare(self, llm, notify_fn=None):
        with mock.patch.object(assist, "_details", return_value=DET) as det:
            n = assist.prepare(self.st, llm, TS, 2, log=lambda *_: None, notify=notify_fn)
        return n, det

    def test_ready_pack_written_and_owner_notified(self):
        sent = []
        n, _ = self.run_prepare(FakeLLM(triage()), lambda *a, **k: sent.append(a))
        self.assertEqual(n, 1)
        row = self.st.db.execute("SELECT * FROM submissions WHERE listing_id='assist:superteam:g1'").fetchone()
        self.assertEqual(row["decision"], "ready")
        text = Path(json.loads(row["payload"])["path"]).read_text(encoding="utf-8")
        self.assertIn("You must personally", text)
        self.assertIn("[OWNER:", text)
        self.assertEqual(len(sent), 1)
        self.assertEqual(self.run_prepare(FakeLLM(triage()))[0], 0)        # never prepared twice

    def test_ai_forbidden_or_too_long_is_skipped(self):
        for t in (triage(ai_policy="forbidden"), triage(owner_minutes=180), triage(doable=False)):
            with self.subTest(t=t):
                self.st.db.execute("DELETE FROM submissions")
                n, _ = self.run_prepare(FakeLLM(t))
                self.assertEqual(n, 0)
                row = self.st.db.execute("SELECT decision FROM submissions").fetchone()
                self.assertEqual(row["decision"], "skipped")

    def test_regional_and_crowded_listings_never_fetched(self):
        self.st.db.execute("DELETE FROM opps")
        self.add("r1", "regional", region="Superteam Brazil")
        self.add("c1", "crowded", competition=99)
        self.add("s1", "small", reward=50.0)
        n, det = self.run_prepare(FakeLLM(triage()))
        self.assertEqual(n, 0)
        det.assert_not_called()


class Notify(unittest.TestCase):
    def setUp(self):
        d = tempfile.TemporaryDirectory()
        self.addCleanup(d.cleanup)
        self.st = Store(Path(d.name) / "t.db")
        self.addCleanup(self.st.db.close)
        for name in ("_ntfy", "_toast"):
            p = mock.patch.object(notify, name, return_value=True)
            setattr(self, name, p.start())
            self.addCleanup(p.stop)

    def test_once_per_key(self):
        self.assertTrue(notify.send(self.st, "k", "t", "m", ts=TS))
        self.assertFalse(notify.send(self.st, "k", "t", "m", ts=TS))
        self.assertEqual(self._ntfy.call_count, 1)

    def test_daily_keys_repeat_next_day(self):
        self.assertTrue(notify.send(self.st, "down", "t", "m", daily=True, ts=TS))
        self.assertFalse(notify.send(self.st, "down", "t", "m", daily=True, ts=TS))
        self.assertTrue(notify.send(self.st, "down", "t", "m", daily=True, ts="2026-10-15T09:00:00+00:00"))

    def test_income_alert_fires_once(self):
        from earner.autopilot import _notify_owner
        self.st.add_earning(TS, None, 25.0, "USDC", 25.0, "", "wallet inflow")
        _notify_owner(self.st, TS, [], None)
        _notify_owner(self.st, TS, [], None)
        titles = [c.args[0] for c in self._ntfy.call_args_list]
        self.assertEqual(titles, ["Money arrived: +$25.00"])


if __name__ == "__main__":
    unittest.main()
