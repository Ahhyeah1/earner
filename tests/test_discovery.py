import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from earner import discovery
from earner.cli import decide_idea
from earner.store import Store


def idea(**kw):
    base = dict(name="Good Board", url="https://good.example", category="bounty-board",
                how_agent_earns="solves tasks", payment="USDC on Base", entry_cost_usd=0, needs=["none"],
                agents_explicitly_allowed=True, api_probe_url="https://good.example/api/tasks",
                evidence_urls=["https://good.example/docs"], est_monthly_usd=200, risks="r", why="w")
    base.update(kw)
    return base


class FakeLLM:
    def __init__(self, ideas):
        self.ideas, self.spent, self.calls = ideas, 0.0, 0

    def call(self, *a, **kw):
        self.calls += 1
        return SimpleNamespace(parsed={"ideas": self.ideas}, content=[])


class Scoring(unittest.TestCase):
    def test_rules(self):
        self.assertEqual(discovery.score(idea(agents_explicitly_allowed=False), True), 0)
        live = discovery.score(idea(), True)
        self.assertGreater(live, discovery.score(idea(), False))            # live API matters
        self.assertGreater(live, discovery.score(idea(needs=["stake", "social_account"]), True))
        self.assertGreater(live, discovery.score(idea(entry_cost_usd=50), True))

    def test_probe_rejects_non_https(self):
        self.assertFalse(discovery.probe("http://x.example/api")[0])


class Run(unittest.TestCase):
    def setUp(self):
        d = tempfile.TemporaryDirectory()
        self.addCleanup(d.cleanup)
        self.dir = Path(d.name)
        self.st = Store(self.dir / "t.db")
        self.addCleanup(self.st.db.close)

    def test_run_stores_ideas_with_our_own_probe_result(self):
        llm = FakeLLM([idea(), idea(name="Dead Board", api_probe_url="https://dead.example/api")])
        probes = {"https://good.example/api/tasks": (True, "live"), "https://dead.example/api": (False, "404")}
        with mock.patch.object(discovery, "probe", side_effect=lambda u: probes[u]):
            n = discovery.run(self.st, llm, "2026-10-10T00:00:00+00:00", log=lambda *_: None)
        self.assertEqual(n, 2)
        rows = {r["id"]: r for r in self.st.ideas()}
        self.assertEqual(rows["good-board"]["probe_ok"], 1)
        self.assertEqual(rows["dead-board"]["probe_ok"], 0)
        self.assertGreater(rows["good-board"]["score"], rows["dead-board"]["score"])

    def test_weekly_cadence(self):
        llm = FakeLLM([])
        now = datetime(2026, 10, 10, tzinfo=timezone.utc)
        discovery.run(self.st, llm, now.isoformat(), log=lambda *_: None)
        self.assertFalse(discovery.due(self.st, now + timedelta(days=3)))
        self.assertTrue(discovery.due(self.st, now + timedelta(days=7)))
        self.assertEqual(discovery.run(self.st, llm, now.isoformat(), log=lambda *_: None), 0)
        self.assertEqual(llm.calls, 1)                                    # not due -> no spend

    def test_approve_writes_plan_reject_doesnt(self):
        with mock.patch.object(discovery, "probe", return_value=(True, "live")):
            discovery.run(self.st, FakeLLM([idea(), idea(name="Other")]), "2026-10-10T00:00:00+00:00",
                          log=lambda *_: None)
        with mock.patch("earner.cli.WORK", self.dir / "work"):
            plan = decide_idea(self.st, "good-board", True)
            self.assertTrue(Path(plan).exists())
            self.assertIn("Build plan: Good Board", Path(plan).read_text(encoding="utf-8"))
            self.assertTrue(decide_idea(self.st, "other", False))
            self.assertIsNone(decide_idea(self.st, "nope", True))
        self.assertEqual(self.st.ideas("approved")[0]["id"], "good-board")
        self.assertEqual(self.st.ideas("rejected")[0]["id"], "other")


if __name__ == "__main__":
    unittest.main()
