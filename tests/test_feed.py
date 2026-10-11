import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

from earner import feed
from earner.sources import _opp
from earner.store import Store

NOW = datetime(2026, 10, 11, tzinfo=timezone.utc)


class Build(unittest.TestCase):
    def setUp(self):
        d = tempfile.TemporaryDirectory()
        self.addCleanup(d.cleanup)
        self.st = Store(Path(d.name) / "t.db")
        self.addCleanup(self.st.db.close)

    def add(self, ext, score, track="work", deadline="2026-12-01T00:00:00Z", **kw):
        o = _opp(source="superteam", ext_id=ext, title=f"t{ext}", url=f"https://x/{ext}", reward_usd=100.0,
                 deadline=deadline, notes="sponsor=secret-internal-note", **kw)
        self.st.upsert(o, track, score, ["why"], "2026-10-10T00:00:00")
        return o

    def test_ranked_open_items_only(self):
        self.add("a", 10)
        self.add("b", 30)
        self.add("expired", 99, deadline="2026-10-01T00:00:00Z")
        self.add("excluded", None)
        self.add("gone", 80)
        self.st.set_status("superteam:gone", "gone", "t")
        f = feed.build(self.st, NOW)
        self.assertEqual([o["title"] for o in f["opportunities"]], ["tb", "ta"])
        self.assertEqual(f["count"], 2)

    def test_excluded_sources_never_published(self):
        self.add("a", 10)
        o = _opp(source="opentask", ext_id="ot1", title="ot", url="https://opentask.ai/x", reward_usd=100.0,
                 deadline="2026-12-01T00:00:00Z")
        self.st.upsert(o, "work", 99, ["why"], "2026-10-10T00:00:00")
        self.assertEqual([x["source"] for x in feed.build(self.st, NOW)["opportunities"]], ["superteam"])

    def test_only_whitelisted_fields(self):
        self.add("a", 10)
        o = feed.build(self.st, NOW)["opportunities"][0]
        self.assertEqual(set(o), set(feed.FIELDS) | {"track", "score", "reasons"})
        self.assertNotIn("secret-internal-note", json.dumps(o))

    def test_track_limits(self):
        for i in range(feed.MAX_LONGSHOT + 5):
            self.add(f"l{i}", i, track="longshot")
        self.assertEqual(len(feed.build(self.st, NOW)["opportunities"]), feed.MAX_LONGSHOT)

    def test_configured_requires_all_three(self):
        with mock.patch.dict("os.environ", {"CF_ACCOUNT_ID": "a", "CF_API_TOKEN": "t"}, clear=True):
            self.assertFalse(feed.configured())
        with mock.patch.dict("os.environ", {"CF_ACCOUNT_ID": "a", "CF_API_TOKEN": "t", "CF_KV_NAMESPACE_ID": "n"},
                             clear=True):
            self.assertTrue(feed.configured())


if __name__ == "__main__":
    unittest.main()
