import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

from earner import funding
from earner.store import Store


class Funding(unittest.TestCase):
    def test_not_ready_then_ready_writes_pack_once_a_week(self):
        st = Store(":memory:")
        sent = []
        young = {"age_days": 7, "revenue_usd": 0, "github_stars": 3, "github_forks": 0, "bot_users": 12}
        with mock.patch.object(funding, "metrics", return_value=young), tempfile.TemporaryDirectory() as d:
            funding.cycle(st, "2026-10-17T00:00:00+00:00", notify=lambda *a, **k: sent.append(a), log=lambda *_: None, out_root=d)
            self.assertEqual(sent, [])
            self.assertFalse(any(Path(d).iterdir()))
        grown = {**young, "age_days": 150, "github_stars": 160}
        with mock.patch.object(funding, "metrics", return_value=grown), tempfile.TemporaryDirectory() as d:
            self.assertIsNone(funding.cycle(st, "2026-10-20T00:00:00+00:00", log=lambda *_: None, out_root=d))   # weekly cadence
            funding.cycle(st, "2026-10-25T00:00:00+00:00", notify=lambda *a, **k: sent.append(a), log=lambda *_: None, out_root=d)
            self.assertEqual(len(sent), 1)
            pack = Path(d) / "floss-fund"
            self.assertIn("dir.floss.fund/submit", (pack / "APPLICATION.md").read_text(encoding="utf-8"))
            fj = json.loads((pack / "funding.json").read_text(encoding="utf-8"))
            self.assertEqual(fj["projects"][0]["licenses"], ["spdx:MIT"])

    def test_age_alone_is_not_enough(self):
        p = funding.PROGRAMS[0]
        self.assertFalse(funding.ready(p, {"age_days": 400, "github_stars": 5, "bot_users": 30}))
        self.assertTrue(funding.ready(p, {"age_days": 400, "github_stars": 5, "bot_users": 5000}))


if __name__ == "__main__":
    unittest.main()
