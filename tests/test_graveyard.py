import unittest

from earner import graveyard
from earner.store import Store


def tx(pre, post, err=None, wallet=graveyard.FEE_WALLET):
    return {"meta": {"err": err, "preBalances": [10, pre], "postBalances": [5, post]},
            "transaction": {"message": {"accountKeys": [{"pubkey": "Owner"}, {"pubkey": wallet}]}}}


class FakeRpc:
    def __init__(self, sigs, txs):
        self.sigs, self.txs = sigs, txs

    def __call__(self, url, method, params):
        return self.sigs if method == "getSignaturesForAddress" else self.txs[params[0]]


class GraveyardIncome(unittest.TestCase):
    def test_fee_received(self):
        self.assertEqual(graveyard.fee_received(tx(0, 3_000_000)), 3_000_000)
        self.assertEqual(graveyard.fee_received(tx(0, 3_000_000, err={"x": 1})), 0)
        self.assertEqual(graveyard.fee_received(tx(0, 3_000_000, wallet="Other")), 0)

    def test_books_each_fee_once(self):
        store = Store(":memory:")
        orig = graveyard._rpc
        graveyard._rpc = FakeRpc([{"signature": "s2"}, {"signature": "s1"}, {"signature": "bad", "err": {"x": 1}}],
                                 {"s1": tx(0, 2_000_000), "s2": tx(2_000_000, 5_000_000)})
        try:
            sent = []
            n, lam = graveyard.check_income(store, "2026-10-15T10:00:00", rpc="x", notify=lambda *a, **k: sent.append(a),
                                            log=lambda *_: None, price=lambda: 200.0)
            self.assertEqual((n, lam), (2, 5_000_000))
            rows = store.ledger()
            self.assertEqual([r["tx"] for r in rows], ["s1", "s2"])
            self.assertAlmostEqual(rows[1]["usd"], 0.6)
            self.assertEqual(len(sent), 1)
            self.assertEqual(graveyard.check_income(store, "2026-10-15T12:00:00", rpc="x", log=lambda *_: None, price=lambda: 200.0), (0, 0))
        finally:
            graveyard._rpc = orig


if __name__ == "__main__":
    unittest.main()
