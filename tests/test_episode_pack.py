import json
import tempfile
import unittest
from pathlib import Path

from earner.episode_pack import build
from earner.store import Store


class Pack(unittest.TestCase):
    def setUp(self):
        d = tempfile.TemporaryDirectory()
        self.addCleanup(d.cleanup)
        self.dir = Path(d.name)
        st = Store(self.dir / "t.db")
        self.addCleanup(st.db.close)
        st.add_expense("2026-10-10T10:00:00", "llm", 1.25, "bb solve x")
        st.add_expense("2026-10-12T10:00:00", "llm", 0.75, "after cut-off")
        st.add_earning("2026-10-11T09:00:00", None, 4.0, "USD-stable", 4.0, "0xabc", "agent Base wallet inflow")
        st.log_submission("2026-10-10T11:00:00", "bb:j1", "Build flatten.py", "submitted", "VERIFIED")
        st.kv_set("superteam_agent", {"apiKey": "sk_SECRET", "claimCode": "CLAIMSECRET"})
        st.commit()
        self.st = st

    def test_facts_respect_cutoff_and_are_deterministic(self):
        a = build(self.st, "2026-10-11T23:59:59", out_root=self.dir / "a", agent_evm="0xAGENT")
        b = build(self.st, "2026-10-11T23:59:59", out_root=self.dir / "b", agent_evm="0xAGENT")
        self.assertEqual((a / "source.md").read_bytes(), (b / "source.md").read_bytes())
        text = (a / "source.md").read_text(encoding="utf-8")
        self.assertIn("spent $1.25", text)                  # 0.75 after cut-off excluded
        self.assertIn("earned $4.00", text)
        self.assertIn("profit was $2.75", text)
        self.assertIn("https://basescan.org/tx/0xabc", text)
        facts = json.loads((a / "facts.json").read_text(encoding="utf-8"))["facts"]
        self.assertEqual([f["id"] for f in facts], [f"F-{i:03d}" for i in range(1, len(facts) + 1)])

    def test_never_leaks_secrets(self):
        out = build(self.st, "2026-10-11T23:59:59", out_root=self.dir / "c")
        for p in out.iterdir():
            body = p.read_text(encoding="utf-8")
            self.assertNotIn("sk_SECRET", body)
            self.assertNotIn("CLAIMSECRET", body)

    def test_negative_profit_reads_naturally(self):
        out = build(self.st, "2026-10-10T23:59:59", out_root=self.dir / "d")
        self.assertIn("profit was -$1.25", (out / "source.md").read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
