import tempfile
import unittest
from pathlib import Path

from earner import paper, policy, treasury
from earner.store import Store
from earner.worker import Worker, _questions

POL = policy.load()


def budget(**kw):
    args = dict(income_usd=0, expenses_usd=0, llm_spent_total=0, llm_spent_today=0,
                submissions_today=0, paper_stats=None)
    args.update(kw)
    return policy.compute(POL, **args)


class Policy(unittest.TestCase):
    def test_bootstrap(self):
        b = budget()
        self.assertEqual(b.tier, "bootstrap")
        self.assertEqual(b.llm_budget_left_usd, POL["bootstrap_llm_usd"])
        self.assertFalse(b.live_trading)
        self.assertEqual(b.trading_capital_usd, 0)

    def test_budget_grows_only_from_profit(self):
        self.assertEqual(budget(income_usd=100).tier, "self-funded")
        self.assertGreater(budget(income_usd=100).llm_budget_left_usd, budget().llm_budget_left_usd)
        # spending counts against profit
        self.assertEqual(budget(income_usd=100, expenses_usd=60).tier, "bootstrap")

    def test_daily_llm_cap(self):
        b = budget(income_usd=10000, llm_spent_today=POL["hard_caps"]["max_llm_usd_per_day"])
        self.assertEqual(b.llm_today_left_usd, 0)

    def test_live_trading_needs_every_gate(self):
        good = {"days": 40, "return_pct": 5, "max_drawdown_pct": 5}
        pol = dict(POL, allow_live_trading=True)
        b = policy.compute(pol, 1000, 0, 0, 0, 0, good)
        self.assertTrue(b.live_trading)
        self.assertEqual(b.trading_capital_usd, 250)     # 25% of $1000 profit
        self.assertFalse(policy.compute(dict(POL, allow_live_trading=False), 1000, 0, 0, 0, 0, good).live_trading)
        self.assertFalse(policy.compute(pol, 1000, 0, 0, 0, 0, dict(good, days=5)).live_trading)
        self.assertFalse(policy.compute(pol, 1000, 0, 0, 0, 0, dict(good, return_pct=-1)).live_trading)
        self.assertFalse(policy.compute(pol, 100, 0, 0, 0, 0, good).live_trading)   # tier too low

    def test_trading_capital_hard_cap(self):
        pol = dict(POL, allow_live_trading=True)
        b = policy.compute(pol, 10**6, 0, 0, 0, 0, {"days": 99, "return_pct": 1, "max_drawdown_pct": 1})
        self.assertEqual(b.trading_capital_usd, POL["hard_caps"]["max_trading_capital_usd"])


class Paper(unittest.TestCase):
    def test_signal(self):
        self.assertTrue(paper.signal([float(i) for i in range(1, 40)]))
        self.assertFalse(paper.signal([float(i) for i in range(40, 1, -1)]))

    def test_step_once_per_day_and_stats(self):
        with tempfile.TemporaryDirectory() as d:
            st = Store(Path(d) / "t.db")
            up = lambda cg: [100.0 + i for i in range(40)]  # noqa: E731
            s1 = paper.step(st, "2026-10-10", fetch=up, log=lambda *_: None)
            self.assertEqual(s1["days"], 0)
            state = st.kv_get("paper")
            self.assertEqual(len(state["qty"]), 3)          # all trending up -> fully invested
            self.assertLess(state["cash"], 1)
            paper.step(st, "2026-10-10", fetch=lambda cg: 1 / 0, log=lambda *_: None)  # same day: no fetch
            down = lambda cg: [100.0 + i for i in range(39)] + [50.0]  # noqa: E731
            s2 = paper.step(st, "2026-10-11", fetch=down, log=lambda *_: None)
            self.assertEqual(s2["days"], 1)
            self.assertGreater(s2["max_drawdown_pct"], 40)
            st.db.close()


class Treasury(unittest.TestCase):
    def test_inflows_count_withdrawals_dont(self):
        with tempfile.TemporaryDirectory() as d:
            st = Store(Path(d) / "t.db")
            q = lambda: lambda owner: bals.pop(0)  # noqa: E731
            bals = [20.0, 120.0, 50.0, 80.0]
            for _ in range(4):
                treasury.sync_wallet(st, "x", "2026-10-10", balance_fn=q(), log=lambda *_: None)
            self.assertAlmostEqual(st.total("ledger"), 130.0)   # +100, then +30; pre-existing 20 ignored
            st.db.close()


class FakeST:
    registered = True
    claim_url = "u"

    def __init__(self, listings):
        self.listings, self.submitted = listings, []

    def live_listings(self):
        return self.listings

    def details(self, slug):
        return {"id": "L1", "compensationType": "fixed",
                "eligibility": [{"order": 1, "question": "Who are you?"}]}

    def submit(self, *a, **kw):
        self.submitted.append((a, kw))
        return {"ok": True}


class FakeLLM:
    def __init__(self, review_score):
        self.review_score = review_score

    def json(self, system, prompt, schema, note, max_tokens=0):
        if note.startswith("triage"):
            return {"feasible": True, "confidence": 0.9, "deliverable": "article", "reason": "ok"}
        if note.startswith("produce"):
            return {"title": "T", "content_markdown": "body", "submission_note": "n",
                    "eligibility_answers": [{"question": "Who are you?", "answer": "An AI agent"}],
                    "ask_usd": None}
        return {"score": self.review_score, "fatal": False, "issues": []}


LISTING = {"id": "L1", "slug": "write-a-guide", "title": "Write a guide", "rewardAmount": 500,
           "token": "USDC", "deadline": "2099-01-01T00:00:00Z", "_count": {"Submission": 2}}


class WorkerFlow(unittest.TestCase):
    def run_worker(self, review_score, allow_submit=True):
        d = tempfile.TemporaryDirectory()
        self.addCleanup(d.cleanup)
        st = Store(Path(d.name) / "t.db")
        self.addCleanup(st.db.close)
        fake = FakeST([LISTING])
        Worker(st, fake, FakeLLM(review_score), budget(), "2026-10-10T00:00:00", allow_submit,
               log=lambda *_: None).run()
        return st, fake

    def test_submits_good_work_once(self):
        st, fake = self.run_worker(9)
        self.assertEqual(len(fake.submitted), 1)
        self.assertTrue(st.handled("L1"))
        self.assertIn("AI agent", fake.submitted[0][0][2])

    def test_holds_back_weak_work(self):
        st, fake = self.run_worker(4)
        self.assertEqual(fake.submitted, [])
        self.assertTrue(st.handled("L1"))       # decided; not retried every cycle

    def test_auto_submit_off(self):
        st, fake = self.run_worker(9, allow_submit=False)
        self.assertEqual(fake.submitted, [])
        self.assertTrue(st.handled("L1"))       # not redone (and re-paid) every cycle

    def test_failures_retry_limited(self):
        with tempfile.TemporaryDirectory() as d:
            st = Store(Path(d) / "t.db")
            st.log_submission("t", "L9", "s", "failed", "boom")
            self.assertFalse(st.handled("L9"))
            st.log_submission("t", "L9", "s", "failed", "boom")
            self.assertTrue(st.handled("L9"))
            st.db.close()

    def test_questions_extracted(self):
        self.assertEqual(_questions({"eligibility": [{"question": "A?"}, {"question": "A?"}]}), ["A?"])


if __name__ == "__main__":
    unittest.main()
