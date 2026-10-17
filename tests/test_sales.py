import unittest

from earner import grantsvc, sales
from earner.store import Store


class Sales(unittest.TestCase):
    def test_books_stars_and_sol_reports_once(self):
        kv = {"tg:charge:c1": {"uid": 1, "stars": 25, "pack": "30 rug checks"},
              "tg:charge:c2": {"uid": 2, "stars": 750, "pack": "loss report"},
              "loss:paid:aa": {"how": "sol:SIG1"}, "loss:paid:bb": {"how": "stars:c2"}}

        def fake_cf(path, method="GET"):
            if path.startswith("keys?prefix="):
                pre = path.split("=", 1)[1].replace("%3A", ":")
                return {"result": [{"name": k} for k in kv if k.startswith(pre)], "result_info": {}}
            key = path.split("/", 1)[1].replace("%3A", ":")
            return kv[key]

        orig = grantsvc._cf
        grantsvc._cf = fake_cf
        try:
            store = Store(":memory:")
            booked = sales.check_sales(store, "2026-10-17T00:00:00", log=lambda *_: None)
            self.assertEqual(len(booked), 3)
            rows = store.ledger()
            self.assertEqual(sorted(r["opp_id"] for r in rows), ["loss-report", "telegram-bot", "telegram-bot"])
            self.assertAlmostEqual(sum(r["usd"] for r in rows), 0.33 + 9.75 + 19, places=2)
            self.assertEqual(sales.check_sales(store, "2026-10-17T02:00:00", log=lambda *_: None), [])
        finally:
            grantsvc._cf = orig


if __name__ == "__main__":
    unittest.main()
