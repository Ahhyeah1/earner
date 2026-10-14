import os
import unittest
from unittest import mock

from earner import gemini, llm

SCHEMA = {"type": "object", "properties": {"ok": {"type": "boolean"}}, "required": ["ok"]}


class Outage(Exception):
    pass


class Broken(Exception):
    pass


def make_llm():
    charges = []
    return llm.LLM(lambda usd, note: charges.append((usd, note)), 3.0), charges


ENV = {"ANTHROPIC_API_KEY": "x", "GEMINI_API_KEY": "y", "EARNER_GEMINI_TIER": "free"}


@mock.patch.dict(os.environ, ENV, clear=False)
class Failover(unittest.TestCase):
    def setUp(self):
        # Treat our fake exception classes as "anthropic API errors"
        p = mock.patch.object(llm.anthropic, "APIError", Exception)
        p.start()
        self.addCleanup(p.stop)
        q = mock.patch.object(llm, "claude_outage", lambda e: isinstance(e, Outage))
        q.start()
        self.addCleanup(q.stop)

    def gem(self, **kw):
        r = {"text": '{"ok": true}', "parsed": {"ok": True}, "model": "gemini-3.8-flash", "input_tokens": 10,
             "output_tokens": 5, "usd": 0.0, "finish": "STOP", "blocked": None}
        r.update(kw)
        return mock.patch.object(gemini, "generate", return_value=r)

    def test_claude_outage_fails_over_to_gemini(self):
        L, charges = make_llm()
        with mock.patch.object(L, "_claude_call", side_effect=Outage("credit balance is too low")), self.gem():
            self.assertEqual(L.json("s", "p", SCHEMA, "triage x"), {"ok": True})
        self.assertIn("claude", L.down)
        self.assertEqual(L.used, {"gemini"})
        self.assertIn("gemini-3.8-flash fallback", charges[-1][1])

    def test_claude_stays_down_for_the_cycle(self):
        L, _ = make_llm()
        claude = mock.Mock(side_effect=Outage("overloaded"))
        with mock.patch.object(L, "_claude_call", claude), self.gem():
            L.json("s", "p", SCHEMA, "a")
            L.json("s", "p", SCHEMA, "b")
        self.assertEqual(claude.call_count, 1)                 # not retried every call

    def test_real_request_errors_do_not_fail_over(self):
        L, _ = make_llm()
        with mock.patch.object(L, "_claude_call", side_effect=Broken("bad schema")), self.gem() as g:
            with self.assertRaises(Broken):
                L.json("s", "p", SCHEMA, "x")
            g.assert_not_called()

    def test_sandbox_work_never_goes_to_gemini(self):
        L, _ = make_llm()
        with mock.patch.object(L, "_claude_call", side_effect=Outage("credit")), self.gem() as g:
            with self.assertRaises(llm.NoProvider):
                L.call("s", "p", "bb verify", tools=[{"type": "code_execution_20260521", "name": "code_execution"}])
            g.assert_not_called()

    def test_gemini_safety_block_is_a_refusal(self):
        L, _ = make_llm()
        with mock.patch.object(L, "_claude_call", side_effect=Outage("credit")), self.gem(finish="SAFETY", parsed=None):
            with self.assertRaises(llm.Refused):
                L.json("s", "p", SCHEMA, "x")

    def test_budget_still_enforced(self):
        L, _ = make_llm()
        L.spent = 2.9
        with self.assertRaises(llm.BudgetExceeded):
            L.json("s", "p", SCHEMA, "x")

    def test_gemini_only_setup(self):
        with mock.patch.dict(os.environ, {"ANTHROPIC_API_KEY": ""}):
            L, _ = make_llm()
            with self.gem():
                self.assertEqual(L.json("s", "p", SCHEMA, "x"), {"ok": True})
            self.assertEqual(L.used, {"gemini"})


@mock.patch.dict(os.environ, ENV, clear=False)
class GeminiClient(unittest.TestCase):
    def test_json_fences_and_prose(self):
        self.assertEqual(gemini._strip_json('```json\n{"a": 1}\n```'), {"a": 1})
        self.assertEqual(gemini._strip_json('Here you go: {"a": 2} hope it helps'), {"a": 2})

    def test_degrades_when_options_are_rejected(self):
        ok = {"candidates": [{"finishReason": "STOP", "content": {"parts": [
            {"text": "thinking...", "thought": True}, {"text": '{"ok": true}'}]}}],
              "usageMetadata": {"promptTokenCount": 100, "candidatesTokenCount": 20, "thoughtsTokenCount": 30}}
        calls = []

        def post(model, body, timeout=300):
            calls.append(body)
            if "thinkingConfig" in body["generationConfig"]:
                raise gemini.GeminiError(400, "Unknown name thinkingConfig")
            return ok
        with mock.patch.object(gemini, "_post", side_effect=post):
            r = gemini.generate("s", "p", schema=SCHEMA)
        self.assertEqual(r["parsed"], {"ok": True})            # thought parts ignored
        self.assertEqual(r["output_tokens"], 50)                # thinking counts as output
        self.assertEqual(r["usd"], 0.0)                         # free tier
        self.assertEqual(len(calls), 2)

    def test_paid_tier_is_charged(self):
        ok = {"candidates": [{"finishReason": "STOP", "content": {"parts": [{"text": '{"ok": true}'}]}}],
              "usageMetadata": {"promptTokenCount": 1_000_000, "candidatesTokenCount": 0}}
        with mock.patch.dict(os.environ, {"EARNER_GEMINI_TIER": "paid"}), \
                mock.patch.object(gemini, "_post", return_value=ok):
            self.assertAlmostEqual(gemini.generate("s", "p", schema=SCHEMA)["usd"], 0.75)


if __name__ == "__main__":
    unittest.main()
