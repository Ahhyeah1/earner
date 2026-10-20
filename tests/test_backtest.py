import random
import unittest

from earner import backtest as B
from earner import paper2
from earner.store import Store


def candles(prices, t0=1_700_000_000):
    return [[t0 + 3600 * i, p * 0.99, p * 1.01, p, p, 1.0] for i, p in enumerate(prices)]


class NoLookahead(unittest.TestCase):
    def test_signals_on_a_prefix_never_change_when_future_data_arrives(self):
        rnd = random.Random(7)
        p, prices = 100.0, []
        for _ in range(900):
            p *= 1 + rnd.uniform(-0.02, 0.02); prices.append(p)
        c = candles(prices)
        for name, (fn, grid) in B.STRATEGIES.items():
            params = grid[len(grid) // 2]
            full = fn(c, **params)
            for cut in (400, 600, 850):
                self.assertEqual(fn(c[:cut], **params), full[:cut], f"{name} looks ahead")

    def test_costs_are_charged_and_trades_execute_next_candle(self):
        c = candles([100, 100, 110, 110])
        eq, trades, _ = B.simulate(c, [1, 1, 1, 1], cost=0.01)
        self.assertEqual(trades, 1)
        self.assertAlmostEqual(eq[-1], 0.99 * 1.10, places=6)          # bought at the 100 close, rode to 110
        eq0, _, _ = B.simulate(c, [0, 0, 1, 1], cost=0.0)
        self.assertAlmostEqual(eq0[-1], 1.0, places=6)                  # signal at the 110 candle -> no gain after


class PaperBooks(unittest.TestCase):
    def test_carry_accrues_funding_once_and_charges_entry(self):
        st = {"equity": 1000.0, "opened": False, "since_ms": 1000}
        f = {"BTC": [{"time": 2000, "fundingRate": "0.0001"}, {"time": 900, "fundingRate": "0.5"}],
             "ETH": [{"time": 3000, "fundingRate": "-0.00005"}]}
        earned = paper2.carry_step(st, f, 5000)
        per = 1000 * (1 - paper2.CARRY_ENTRY_COST) / 2
        self.assertAlmostEqual(earned, per * 0.0001 - per * 0.00005, places=9)
        self.assertEqual(paper2.carry_step(st, f, 6000), 0.0)           # same records are not counted twice

    def test_trend_book_buys_uptrends_only(self):
        up = candles([100 * 1.001 ** i for i in range(400)])
        down = candles([100 * 0.999 ** i for i in range(400)])
        st = Store(":memory:")
        fake = lambda a: up if a == "SOL" else down
        out = paper2.step(st, "2026-10-21T00:00:00+00:00", fetch_candles=fake, fetch_fund=lambda c, s: [], log=lambda *_: None)
        book = st.kv_get("paper2")["trend"]
        self.assertEqual(list(book["qty"]), ["SOL"])
        self.assertLess(out["trend"]["equity"], 1000)                   # paid the entry cost


if __name__ == "__main__":
    unittest.main()
