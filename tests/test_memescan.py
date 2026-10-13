import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from earner import memescan as ms
from earner.store import Store

TS = "2026-10-11T12:00:00+00:00"
NOW_MS = int(datetime.fromisoformat(TS).timestamp() * 1000)
SAFE = {"risks": [], "score_normalised": 1, "lpLockedPct": 100}


def pair(mint, price=0.001, liq=80_000, vol=300_000, age_h=48, buys=500, sells=300, h1=5, h6=40, fdv=None):
    return {"baseToken": {"address": mint, "symbol": mint.upper()}, "priceUsd": str(price),
            "liquidity": {"usd": liq}, "volume": {"h24": vol}, "pairCreatedAt": NOW_MS - int(age_h * 3.6e6),
            "fdv": fdv if fdv is not None else liq * 5, "txns": {"h24": {"buys": buys, "sells": sells}},
            "priceChange": {"h1": h1, "h6": h6}, "url": f"https://dexscreener.com/solana/{mint}"}


class Filters(unittest.TestCase):
    def test_market_filters(self):
        self.assertTrue(ms.passes(pair("a"), NOW_MS)[0])
        for bad in (pair("a", liq=1000), pair("a", vol=10), pair("a", age_h=1), pair("a", age_h=24 * 60),
                    pair("a", buys=10), pair("a", h1=-50), pair("a", fdv=80_000 * 100)):
            self.assertFalse(ms.passes(bad, NOW_MS)[0])

    def test_rugcheck_filters(self):
        p = pair("a")
        self.assertTrue(ms.passes(p, NOW_MS, SAFE)[0])
        danger = {"risks": [{"level": "danger", "name": "Mint Authority still enabled"}], "score_normalised": 1,
                  "lpLockedPct": 100}
        self.assertFalse(ms.passes(p, NOW_MS, danger)[0])
        self.assertFalse(ms.passes(p, NOW_MS, {**SAFE, "lpLockedPct": 0})[0])
        self.assertFalse(ms.passes(p, NOW_MS, {**SAFE, "score_normalised": 70})[0])
        self.assertTrue(ms.passes(p, NOW_MS, {**SAFE, "risks": [{"level": "warn", "name": "Mutable metadata"}]})[0])


class PaperBook(unittest.TestCase):
    def setUp(self):
        d = tempfile.TemporaryDirectory()
        self.addCleanup(d.cleanup)
        self.st = Store(Path(d.name) / "t.db")
        self.addCleanup(self.st.db.close)

    def run_step(self, market, cands, rug=lambda m: SAFE):
        return ms.step(self.st, TS, fetch_pairs=lambda ms_, strict=False: {m: market[m] for m in ms_ if m in market},
                       fetch_candidates=lambda: cands, rugcheck=rug, log=lambda *_: None)

    def test_buys_ranked_safe_tokens_only(self):
        market = {"good": pair("good", h6=80), "ok": pair("ok", h6=10), "scam": pair("scam")}
        rug = lambda m: {**SAFE, "lpLockedPct": 0} if m == "scam" else SAFE  # noqa: E731
        st = self.run_step(market, ["good", "ok", "scam"], rug)
        self.assertEqual(set(ms.book(self.st)["open"]), {"good", "ok"})
        self.assertAlmostEqual(st["cash"], ms.START_CASH - 2 * ms.POSITION_USD)

    def test_no_safety_report_no_trade(self):
        self.run_step({"a": pair("a")}, ["a"], rug=lambda m: 1 / 0)
        self.assertEqual(ms.book(self.st)["open"], {})

    def test_exits_take_profit_stop_loss_and_rug(self):
        self.run_step({k: pair(k) for k in ("tp", "sl", "rug")}, ["tp", "sl", "rug"])
        later = {"tp": pair("tp", price=0.0025), "sl": pair("sl", price=0.0005), "rug": pair("rug", liq=100)}
        st = self.run_step(later, [])
        reasons = {t["mint"]: t["reason"] for t in ms.book(self.st)["closed"]}
        self.assertEqual(reasons, {"tp": "take profit", "sl": "stop loss", "rug": "rug / liquidity gone"})
        rug_trade = next(t for t in ms.book(self.st)["closed"] if t["mint"] == "rug")
        self.assertEqual(rug_trade["pnl"], -ms.POSITION_USD)          # a rug loses the whole stake
        self.assertEqual(st["trades_closed"], 3)
        self.assertEqual(st["open_positions"], 0)

    def test_failed_lookup_never_closes_positions(self):
        self.run_step({"a": pair("a")}, ["a"])
        def boom(mints, strict=False):
            if strict:
                raise ms.FetchFailed("api down")
            return {}
        ms.step(self.st, TS, fetch_pairs=boom, fetch_candidates=lambda: [], rugcheck=lambda m: SAFE,
                log=lambda *_: None)
        self.assertIn("a", ms.book(self.st)["open"])
        self.assertEqual(ms.book(self.st)["closed"], [])

    def test_missing_token_needs_consecutive_misses(self):
        self.run_step({"a": pair("a")}, ["a"])
        for i in range(ms.MISSING_LIMIT - 1):
            self.run_step({}, [])
            self.assertIn("a", ms.book(self.st)["open"])
        self.run_step({}, [])
        self.assertEqual(ms.book(self.st)["closed"][0]["reason"], "rug / liquidity gone")

    def test_respects_position_limits(self):
        market = {f"t{i}": pair(f"t{i}") for i in range(20)}
        self.run_step(market, list(market))
        self.assertEqual(len(ms.book(self.st)["open"]), ms.MAX_NEW_PER_CYCLE)


if __name__ == "__main__":
    unittest.main()
