import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from earner import memory
from earner.store import Store

TS = "2026-10-13T10:00:00+00:00"


def trade(sym, pnl, reason):
    return {"mint": sym, "symbol": sym, "opened": "2026-10-12T10:00:00+00:00", "closed": TS, "cost": 20.0,
            "proceeds": 20 + pnl, "pnl": pnl, "reason": reason, "url": ""}


class Base(unittest.TestCase):
    def setUp(self):
        d = tempfile.TemporaryDirectory()
        self.addCleanup(d.cleanup)
        self.st = Store(Path(d.name) / "t.db")
        self.addCleanup(self.st.db.close)


class Observe(Base):
    def test_each_outcome_once(self):
        self.st.log_submission(TS, "bb:j1", "Build x", "failed", "tests failed")
        self.st.log_submission(TS, "st1", "Write y", "pending", "waiting")
        self.st.kv_set("paper_meme", {"closed": [trade("A", -8, "stop loss")]})
        self.assertEqual(memory.observe(self.st, TS), 2)          # pending is not an outcome yet
        self.assertEqual(memory.observe(self.st, TS), 0)          # cursor: never repeated
        topics = sorted(r["topic"] for r in memory.recent(self.st, "observation"))
        self.assertEqual(topics, ["bountybook", "meme"])


class Health(Base):
    def test_pause_after_repeated_failures_and_resume(self):
        for i in range(memory.PAUSE_AFTER_FAILURES):
            self.st.log_submission(TS, f"bb:j{i}", "job", "failed", "rejected")
        self.assertEqual(memory.check_health(self.st, TS), ["bountybook"])
        self.assertIn("bountybook", memory.paused(self.st))
        self.assertEqual(memory.check_health(self.st, TS), [])     # no duplicate pause
        self.assertTrue(memory.resume(self.st, "bountybook", "2026-10-13T11:00:00+00:00"))
        # old failures no longer count after an owner resume
        self.assertEqual(memory.check_health(self.st, "2026-10-13T12:00:00+00:00"), [])

    def test_any_success_prevents_pause(self):
        for i in range(5):
            self.st.log_submission(TS, f"bb:j{i}", "job", "failed", "x")
        self.st.log_submission(TS, "bb:ok", "job", "submitted", "verified")
        self.assertEqual(memory.check_health(self.st, TS), [])


class Tuning(Base):
    def test_losing_streak_tightens_within_bounds(self):
        self.st.kv_set("paper_meme", {"closed": [trade(f"T{i}", -8, "stop loss") for i in range(6)]})
        changed = memory.tune_meme(self.st, TS)
        p = memory.params(self.st)
        self.assertIn("meme.min_liquidity", changed)
        self.assertGreater(p["meme.min_liquidity"], memory.BOUNDS["meme.min_liquidity"][2])
        self.assertGreater(p["meme.stop_loss"], memory.BOUNDS["meme.stop_loss"][2])   # cuts losers earlier
        self.assertEqual(memory.tune_meme(self.st, TS), [])                            # at most daily
        adjustments = memory.recent(self.st, "adjustment")
        self.assertTrue(all("->" in r["text"] for r in adjustments))

    def test_never_leaves_bounds(self):
        for day in range(1, 40):
            closed = [trade(f"T{day}-{i}", -8, "stop loss") for i in range(6)]
            book = self.st.kv_get("paper_meme") or {"closed": []}
            self.st.kv_set("paper_meme", {"closed": book["closed"] + closed})
            memory.tune_meme(self.st, f"2026-11-{day:02d}T10:00:00+00:00" if day <= 30 else f"2026-12-{day-30:02d}T10:00:00+00:00")
        for k, v in memory.params(self.st).items():
            lo, hi, _ = memory.BOUNDS[k]
            self.assertTrue(lo <= v <= hi, k)

    def test_reset(self):
        memory.set_param(self.st, TS, "meme.min_liquidity", 99_000, "test")
        memory.reset_tuning(self.st, TS)
        self.assertEqual(memory.params(self.st)["meme.min_liquidity"], memory.BOUNDS["meme.min_liquidity"][2])


class Reflect(Base):
    def test_lessons_replace_old_ones_and_are_recalled(self):
        self.st.log_submission(TS, "bb:j1", "Build x", "failed", "rejected")
        memory.observe(self.st, TS)
        memory.add(self.st, TS, "lesson", "bountybook", "old lesson")
        fake = SimpleNamespace(call=lambda *a, **k: SimpleNamespace(parsed={
            "lessons": [{"topic": "bountybook", "text": "Platform rejects locally-passing code; verify format."}],
            "summary": "s"}))
        memory.reflect(self.st, fake, TS)
        text = memory.recall(self.st, ("bountybook",))
        self.assertIn("verify format", text)
        self.assertNotIn("old lesson", text)
        self.assertFalse(memory.reflection_due(self.st))


if __name__ == "__main__":
    unittest.main()
