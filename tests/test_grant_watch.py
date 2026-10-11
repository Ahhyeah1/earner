import tempfile
import unittest
from pathlib import Path

from earner.autopilot import watch_grant
from earner.store import Store


class GrantWatch(unittest.TestCase):
    def setUp(self):
        d = tempfile.TemporaryDirectory()
        self.addCleanup(d.cleanup)
        self.st = Store(Path(d.name) / "t.db")
        self.addCleanup(self.st.db.close)

    def test_alerts_only_when_accepting(self):
        self.assertIsNone(watch_grant(self.st, lambda: {"status": "OPEN", "isActive": True, "isPaused": True}))
        self.assertIn("GRANT OPEN", watch_grant(self.st, lambda: {"status": "OPEN", "isActive": True, "isPaused": False}))

    def test_silent_after_submission_and_on_errors(self):
        self.assertIsNone(watch_grant(self.st, lambda: 1 / 0))
        self.st.kv_set("grant_submitted", True)
        self.assertIsNone(watch_grant(self.st, lambda: {"status": "OPEN", "isActive": True, "isPaused": False}))


if __name__ == "__main__":
    unittest.main()
