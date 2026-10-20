"""Two research-backed paper books, tracked every cycle next to the original daily book (which alone feeds the
live-trading gate, so its record isn't disturbed):

trend - hourly EMA(48) vs EMA(336) on SOL/BTC/ETH, long-only, equal weight across assets in an uptrend, 0.3% per
        side. The only family that survived out-of-sample + robustness tests in backtest.py (it lost less than
        holding in a bear year; not a profit guarantee).
carry - delta-neutral funding carry: hold BTC/ETH spot and short the same amount of perp on Hyperliquid; price
        moves cancel, the book earns (or pays) the actual hourly funding rate. Entry cost charged once.
"""
import json
import time
import urllib.request

from . import backtest as B

TREND_ASSETS = ("SOL", "BTC", "ETH")
CARRY_ASSETS = ("BTC", "ETH")            # SOL funding paid only ~0.8%/yr over the past year
START = 1000.0
COST = 0.003
CARRY_ENTRY_COST = 0.002                 # spot buy + perp short, once
FAST, SLOW = 48, 336


def _json(url, body=None):
    req = urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"User-Agent": "earner-paper", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())


def fetch_hourly(asset, hours=400):
    """Closed hourly candles, oldest first: [time, low, high, open, close, volume] (Coinbase)."""
    end = int(time.time()) // 3600 * 3600
    rows = {}
    t = end
    while t > end - hours * 3600:
        start = t - 300 * 3600
        s = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(start)); e = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(t))
        for r in _json(f"https://api.exchange.coinbase.com/products/{asset}-USD/candles?granularity=3600&start={s}&end={e}"):
            if int(r[0]) < end:                          # drop the still-forming hour
                rows[int(r[0])] = r
        t = start
    return [rows[k] for k in sorted(rows)]


def fetch_funding(coin, since_ms):
    out, start = [], since_ms
    while True:
        r = _json("https://api.hyperliquid.xyz/info", {"type": "fundingHistory", "coin": coin, "startTime": start})
        if not isinstance(r, list) or not r:
            return out
        out += r
        if len(r) < 500:
            return out
        start = r[-1]["time"] + 1


# ------------------------------------------------------------------ trend book
def trend_targets(candles_by_asset):
    holds = []
    for a, c in candles_by_asset.items():
        if len(c) > SLOW and B.s_ema_cross(c, fast=FAST, slow=SLOW)[-1] == 1:
            holds.append(a)
    return holds


def trend_step(state, candles_by_asset):
    prices = {a: c[-1][4] for a, c in candles_by_asset.items()}
    holds = trend_targets(candles_by_asset)
    eq = state["cash"] + sum(q * prices[a] for a, q in state["qty"].items())
    target = {a: (eq / len(holds) if a in holds else 0.0) for a in candles_by_asset}
    trades = []
    for a in candles_by_asset:                           # sells first
        cur = state["qty"].get(a, 0.0) * prices[a]
        if cur - target[a] > 5:
            usd = cur - target[a]
            state["qty"][a] = state["qty"].get(a, 0.0) - usd / prices[a]
            state["cash"] += usd * (1 - COST)
            trades.append(f"sell {a} ${usd:.0f}")
    for a in candles_by_asset:
        cur = state["qty"].get(a, 0.0) * prices[a]
        if target[a] - cur > 5:
            usd = min(target[a] - cur, state["cash"])
            state["qty"][a] = state["qty"].get(a, 0.0) + usd * (1 - COST) / prices[a]
            state["cash"] -= usd
            trades.append(f"buy {a} ${usd:.0f}")
    equity = state["cash"] + sum(q * prices[a] for a, q in state["qty"].items())
    return holds, trades, equity


# ------------------------------------------------------------------ carry book
def carry_step(state, funding_by_coin, now_ms):
    """funding_by_coin: {coin: [{"time": ms, "fundingRate": str}, ...]} since state['since_ms'].
    The short perp receives fundingRate x notional each hour (pays when negative)."""
    if not state.get("opened"):
        state["equity"] = START * (1 - CARRY_ENTRY_COST)
        state["opened"] = True
    per = state["equity"] / len(CARRY_ASSETS)
    earned = 0.0
    for coin in CARRY_ASSETS:
        for f in funding_by_coin.get(coin, []):
            if f["time"] > state["since_ms"]:
                earned += per * float(f["fundingRate"])
    state["equity"] += earned
    state["since_ms"] = now_ms
    return earned


def _stats(hist):
    if not hist:
        return {"return_pct": 0.0, "max_drawdown_pct": 0.0, "equity": START, "points": 0}
    peak, mdd = hist[0][1], 0.0
    for _, e in hist:
        peak = max(peak, e); mdd = max(mdd, (peak - e) / peak * 100)
    return {"return_pct": round((hist[-1][1] / START - 1) * 100, 2), "max_drawdown_pct": round(mdd, 2),
            "equity": round(hist[-1][1], 2), "points": len(hist)}


def step(store, ts, fetch_candles=fetch_hourly, fetch_fund=fetch_funding, log=print, now_ms=None):
    now_ms = now_ms or int(time.time() * 1000)
    books = store.kv_get("paper2") or {
        "trend": {"cash": START, "qty": {}, "history": []},
        "carry": {"equity": START, "opened": False, "since_ms": now_ms, "history": []}}
    t = books["trend"]
    try:
        holds, trades, eq = trend_step(t, {a: fetch_candles(a) for a in TREND_ASSETS})
        t["history"].append([ts, round(eq, 2)])
        t["history"] = t["history"][-2000:]
        log(f"  paper trend (EMA {FAST}/{SLOW}h): hold {holds or 'cash'}; {', '.join(trades) or 'no trades'}; equity ${eq:.2f}")
    except Exception as e:
        log(f"  paper trend: skipped ({e!r})")
    c = books["carry"]
    try:
        earned = carry_step(c, {coin: fetch_fund(coin, c["since_ms"]) for coin in CARRY_ASSETS}, now_ms)
        c["history"].append([ts, round(c["equity"], 4)])
        c["history"] = c["history"][-2000:]
        log(f"  paper carry (BTC/ETH funding): +${earned:.4f} this cycle; equity ${c['equity']:.2f}")
    except Exception as e:
        log(f"  paper carry: skipped ({e!r})")
    store.kv_set("paper2", books)
    store.commit()
    return {"trend": _stats(t["history"]), "carry": _stats(c["history"])}
