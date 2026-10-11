"""Paper trading: builds the track record that gates live trading.

Strategy (deliberately simple and auditable): once per UTC day, hold an equal-weight basket of
the assets whose price is above their 20-day average AND up over 14 days; everything else in
cash (USDC). Fees are charged on every rebalance. No leverage, no shorting.
"""
import json
import urllib.request

ASSETS = {"SOL": "solana", "BTC": "bitcoin", "ETH": "ethereum"}
START_EQUITY = 1000.0
FEE = 0.003          # per side, roughly DEX swap fee + slippage
SMA_DAYS, MOM_DAYS = 20, 14
MIN_TRADE_USD = 5.0


def fetch_history(cg_id, days=60):
    url = (f"https://api.coingecko.com/api/v3/coins/{cg_id}/market_chart"
           f"?vs_currency=usd&days={days}&interval=daily")
    req = urllib.request.Request(url, headers={"User-Agent": "earner/0.2"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return [p for _, p in json.loads(r.read())["prices"]]


def signal(closes):
    """True = hold. closes: oldest -> newest daily prices."""
    if len(closes) < SMA_DAYS + 1:
        return False
    sma = sum(closes[-SMA_DAYS:]) / SMA_DAYS
    return closes[-1] > sma and closes[-1] > closes[-1 - MOM_DAYS]


def rebalance(state, prices, holds):
    """Move the portfolio to equal weight across `holds`. Returns list of trades."""
    equity = state["cash"] + sum(q * prices[a] for a, q in state["qty"].items())
    target = {a: (equity / len(holds) if holds else 0.0) for a in ASSETS}
    trades = []
    for a in ASSETS:                                   # sells first to free cash
        cur = state["qty"].get(a, 0.0) * prices[a]
        if cur - target[a] > MIN_TRADE_USD:
            usd = cur - target[a]
            state["qty"][a] = state["qty"].get(a, 0.0) - usd / prices[a]
            state["cash"] += usd * (1 - FEE)
            trades.append(("sell", a, round(usd, 2)))
    for a in ASSETS:
        cur = state["qty"].get(a, 0.0) * prices[a]
        if target[a] - cur > MIN_TRADE_USD:
            usd = min(target[a] - cur, state["cash"])
            state["qty"][a] = state["qty"].get(a, 0.0) + usd * (1 - FEE) / prices[a]
            state["cash"] -= usd
            trades.append(("buy", a, round(usd, 2)))
    return trades


def equity(state, prices):
    return state["cash"] + sum(q * prices[a] for a, q in state["qty"].items())


def stats(state):
    hist = state.get("history", [])
    if not hist:
        return {"days": 0, "return_pct": 0.0, "max_drawdown_pct": 0.0, "equity": START_EQUITY}
    peak, mdd = hist[0][1], 0.0
    for _, e in hist:
        peak = max(peak, e)
        mdd = max(mdd, (peak - e) / peak * 100)
    return {"days": len(hist) - 1, "return_pct": round((hist[-1][1] / START_EQUITY - 1) * 100, 2),
            "max_drawdown_pct": round(mdd, 2), "equity": round(hist[-1][1], 2)}


def step(store, today, fetch=fetch_history, log=print):
    """Run at most once per UTC day. State lives in the kv table."""
    state = store.kv_get("paper") or {"cash": START_EQUITY, "qty": {}, "history": [], "last_day": None}
    if state["last_day"] == today:
        return stats(state)
    closes = {a: fetch(cg) for a, cg in ASSETS.items()}
    prices = {a: c[-1] for a, c in closes.items()}
    holds = [a for a, c in closes.items() if signal(c)]
    trades = rebalance(state, prices, holds)
    state["last_day"] = today
    state["history"].append([today, round(equity(state, prices), 2)])
    store.kv_set("paper", state)
    st = stats(state)
    log(f"  paper: hold {holds or 'cash'}; trades {trades or 'none'}; equity ${st['equity']} "
        f"({st['return_pct']:+.2f}%, maxDD {st['max_drawdown_pct']}%, {st['days']}d)")
    return st
