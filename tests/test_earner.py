import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from earner.score import score
from earner.sources import _opp, parse_usd
from earner.store import Store

NOW = datetime(2026, 10, 10, tzinfo=timezone.utc)


def work(**kw):
    base = dict(source="superteam", ext_id="x", title="t", reward_usd=1000.0,
                deadline="2026-10-20T00:00:00Z", competition=3)
    base.update(kw)
    return _opp(**base)


class ParseUsd(unittest.TestCase):
    def test_amounts(self):
        self.assertEqual(parse_usd("Fix bug [$500]"), 500)
        self.assertEqual(parse_usd("Reward: 1,200 USDC"), 1200)
        self.assertEqual(parse_usd("$2k bounty"), 2000)

    def test_ignores_self_issued_tokens(self):
        self.assertIsNone(parse_usd("Bounty: 50,000 $ROBIN_MCP"))
        self.assertIsNone(parse_usd("no money here"))


class Regions(unittest.TestCase):
    def test_title_hints(self):
        from earner.sources import _title_region
        self.assertIn("Türkiye", _title_region("Arf × Superteam Türkiye — University Track"))
        self.assertIn("UNI", _title_region("Pitch for KUBG UNI Vibeathon"))
        self.assertIsNone(_title_region("Write a thread about Solana"))
        self.assertIsNone(_title_region("Grow the community unit"))


class Scoring(unittest.TestCase):
    def test_expired_and_non_stable_excluded(self):
        self.assertIsNone(score(work(deadline="2026-10-11T00:00:00Z"), NOW)[1])
        self.assertIsNone(score(work(reward_usd=None, reward_token="SKR"), NOW)[1])
        self.assertIsNone(score(work(reward_usd=10.0), NOW)[1])

    def test_competition_and_agent_access(self):
        crowded = score(work(competition=100), NOW)[1]
        quiet = score(work(competition=0), NOW)[1]
        self.assertGreater(quiet, crowded)
        self.assertGreater(score(work(agent_allowed=True), NOW)[1], score(work(), NOW)[1])

    def test_region_penalty(self):
        self.assertLess(score(work(region="Superteam Brazil"), NOW)[1], score(work(), NOW)[1])

    def test_longshot_track(self):
        o = _opp(source="immunefi", ext_id="p", reward_usd=100000.0,
                 notes="assets=2; launched=2026-09-20; updated=2026-10-01")
        track, s, reasons = score(o, NOW)
        self.assertEqual(track, "longshot")
        self.assertTrue(any("launched" in r for r in reasons))
        o["deadline"] = "2026-09-14T11:00:00.000Z"
        self.assertIsNone(score(o, NOW)[1])


class StoreFlow(unittest.TestCase):
    def test_lifecycle(self):
        with tempfile.TemporaryDirectory() as d:
            st = Store(Path(d) / "t.db")
            o = work(ext_id="abc")
            self.assertTrue(st.upsert(o, "work", 50, [], "2026-10-10T00:00:00"))
            self.assertFalse(st.upsert(o, "work", 55, [], "2026-10-11T00:00:00"))
            st.mark_gone(["superteam"], "2026-10-12T00:00:00")
            self.assertEqual(st.get("abc")["status"], "gone")
            st.upsert(o, "work", 55, [], "2026-10-12T00:00:00")   # reappeared
            self.assertEqual(st.get("abc")["status"], "new")
            st.set_status(o["id"], "approved", "2026-10-12T00:00:00")
            st.mark_gone(["superteam"], "2026-10-13T00:00:00")     # approved work is never auto-closed
            self.assertEqual(st.get("abc")["status"], "approved")
            st.add_earning("2026-10-20", o["id"], 500, "USDC", 500, "0xtx", "t")
            self.assertEqual(sum(r["usd"] for r in st.ledger()), 500)
            st.db.close()


if __name__ == "__main__":
    unittest.main()
