"""Meme-coin scanner with a PAPER portfolio. Never trades real money.

Each cycle: collect fresh Solana tokens from DexScreener (latest profiles, boosts, community
takeovers), drop obvious scams (RugCheck dangers, unlocked liquidity, thin liquidity, brand-new
or dumping pairs), rank survivors on momentum, and "buy" the best with virtual money. Open
positions are marked to market every cycle and closed on take-profit, stop-loss, time limit, or
when liquidity vanishes (treated as a rug).

Meme coins are closer to gambling than investing; this exists to MEASURE whether the agent would
have made money, honestly, including fees, slippage and rugs.
"""
import json
import time
import urllib.request
from datetime import datetime, timezone

DEX = "https://api.dexscreener.com"
RUG = "https://api.rugcheck.xyz/v1/tokens/{}/report/summary"
UA = {"User-Agent": "earner/0.5 (paper meme scanner)"}

START_CASH = 1000.0
POSITION_USD = 20.0            # 2% of the virtual book per trade
MAX_OPEN = 10
MAX_NEW_PER_CYCLE = 3
COST = 0.03                    # fees + slippage per side; meme pools are thin
TAKE_PROFIT, STOP_LOSS = 1.00, -0.40      # +100% / -40%
MAX_HOLD_DAYS = 7
RUG_LIQUIDITY_USD = 5000       # an open position whose pool falls below this is treated as rugged
MISSING_LIMIT = 3              # consecutive successful lookups without the token before it counts as gone

FILTER = {"min_liquidity": 50_000, "min_volume_24h": 100_000, "min_age_h": 6, "max_age_d": 30,
          "max_fdv_to_liq": 40, "min_buys_24h": 150, "min_h1_change": -20, "max_rug_norm": 20,
          "min_lp_locked": 80}


def _get(url, timeout=20):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r:
        return json.loads(r.read())


def candidates():
    mints = []
    for path in ("/token-profiles/latest/v1", "/token-boosts/latest/v1", "/token-boosts/top/v1",
                 "/community-takeovers/latest/v1"):
        try:
            for x in _get(DEX + path):
                if x.get("chainId") == "solana" and x.get("tokenAddress"):
                    mints.append(x["tokenAddress"])
        except Exception:
            continue
    return list(dict.fromkeys(mints))


class FetchFailed(Exception):
    pass


def pairs_for(mints, strict=False):
    """Best (deepest) pair per mint, in batches of 30. strict=True raises instead of silently
    returning a partial result - required when the result decides whether a position is closed."""
    best = {}
    for i in range(0, len(mints), 30):
        try:
            for p in _get(f"{DEX}/tokens/v1/solana/{','.join(mints[i:i + 30])}"):
                m = (p.get("baseToken") or {}).get("address")
                liq = (p.get("liquidity") or {}).get("usd") or 0
                if m and liq > ((best.get(m) or {}).get("liquidity") or {}).get("usd", -1):
                    best[m] = p
        except Exception as e:
            if strict:
                raise FetchFailed(repr(e)) from None
            continue
    return best


def passes(p, now_ms, rug=None, f=None):
    """(ok, reason). Market filters first (free); RugCheck is checked by the caller if these pass."""
    f = f or FILTER
    liq = (p.get("liquidity") or {}).get("usd") or 0
    vol = (p.get("volume") or {}).get("h24") or 0
    age_h = (now_ms - (p.get("pairCreatedAt") or now_ms)) / 3.6e6
    fdv = p.get("fdv") or 0
    buys = ((p.get("txns") or {}).get("h24") or {}).get("buys") or 0
    h1 = (p.get("priceChange") or {}).get("h1") or 0
    if liq < f["min_liquidity"]:
        return False, f"liquidity ${liq:,.0f}"
    if vol < f["min_volume_24h"]:
        return False, f"24h volume ${vol:,.0f}"
    if not f["min_age_h"] <= age_h <= f["max_age_d"] * 24:
        return False, f"age {age_h:.0f}h"
    if fdv > f["max_fdv_to_liq"] * liq:
        return False, "valuation far above liquidity"
    if buys < f["min_buys_24h"]:
        return False, f"only {buys} buys/24h"
    if h1 < f["min_h1_change"]:
        return False, f"dumping ({h1:+.0f}% 1h)"
    if rug is not None:
        dangers = [r.get("name") for r in rug.get("risks") or [] if r.get("level") == "danger"]
        if dangers:
            return False, "rugcheck: " + ", ".join(dangers[:2])
        if (rug.get("score_normalised") or 0) > f["max_rug_norm"]:
            return False, f"rugcheck score {rug.get('score_normalised')}"
        if (rug.get("lpLockedPct") or 0) < f["min_lp_locked"]:
            return False, f"only {rug.get('lpLockedPct') or 0:.0f}% liquidity locked"
    return True, "ok"


def momentum(p):
    pc = p.get("priceChange") or {}
    tx = (p.get("txns") or {}).get("h24") or {}
    liq = (p.get("liquidity") or {}).get("usd") or 1
    turnover = ((p.get("volume") or {}).get("h24") or 0) / liq
    buy_ratio = (tx.get("buys") or 0) / max(1, (tx.get("buys") or 0) + (tx.get("sells") or 0))
    return round(0.5 * min(pc.get("h6") or 0, 200) + 10 * min(turnover, 10) + 40 * (buy_ratio - 0.5), 1)


def _price(p):
    try:
        return float(p.get("priceUsd") or 0)
    except ValueError:
        return 0.0


def book(store):
    return store.kv_get("paper_meme") or {"cash": START_CASH, "open": {}, "closed": []}


def stats(b):
    closed = b["closed"]
    realized = sum(t["pnl"] for t in closed)
    open_value = sum(pos.get("value", pos["cost"]) for pos in b["open"].values())
    wins = sum(1 for t in closed if t["pnl"] > 0)
    return {"cash": round(b["cash"], 2), "open_positions": len(b["open"]), "open_value": round(open_value, 2),
            "equity": round(b["cash"] + open_value, 2), "realized_pnl": round(realized, 2),
            "trades_closed": len(closed), "win_rate": round(wins / len(closed), 2) if closed else None,
            "return_pct": round((b["cash"] + open_value - START_CASH) / START_CASH * 100, 2)}


def step(store, ts=None, fetch_pairs=pairs_for, fetch_candidates=candidates, rugcheck=None, log=print):
    ts = ts or datetime.now(timezone.utc).isoformat(timespec="seconds")
    now_ms = int(time.time() * 1000) if ts is None else int(datetime.fromisoformat(ts).timestamp() * 1000)
    rugcheck = rugcheck or (lambda m: _get(RUG.format(m)))
    b = book(store)
    from .memory import params           # self-tuned values, always within memory.BOUNDS
    P = params(store)
    f = {**FILTER, "min_liquidity": P["meme.min_liquidity"], "min_volume_24h": P["meme.min_volume_24h"],
         "min_buys_24h": P["meme.min_buys_24h"], "min_age_h": P["meme.min_age_h"]}
    take_profit, stop_loss, max_hold = P["meme.take_profit"], P["meme.stop_loss"], P["meme.max_hold_days"]

    # 1. mark open positions and apply exits. A failed lookup is NOT evidence of a rug: only an
    #    explicit pool reading below the threshold, or MISSING_LIMIT consecutive successful lookups
    #    that don't contain the token, closes a position as rugged. (2026-10-12: one API failure wrote
    #    off six healthy positions.)
    try:
        live = fetch_pairs(list(b["open"]), strict=True) if b["open"] else {}
    except FetchFailed as e:
        log(f"  meme paper: price lookup failed ({e}); positions left untouched this cycle")
        live = None
    for mint, pos in list(b["open"].items()):
        if live is None:
            continue
        p = live.get(mint)
        pos["missing"] = 0 if p else pos.get("missing", 0) + 1
        if not p and pos["missing"] < MISSING_LIMIT:
            continue
        liq = ((p or {}).get("liquidity") or {}).get("usd") or 0
        price = _price(p) if p else 0
        held_d = (now_ms - pos["opened_ms"]) / 8.64e7
        if not p or liq < RUG_LIQUIDITY_USD or price <= 0:
            reason, exit_value = "rug / liquidity gone", 0.0
        else:
            value = pos["qty"] * price * (1 - COST)
            ret = value / pos["cost"] - 1
            pos["value"], pos["last_price"] = round(value, 4), price
            reason = ("take profit" if ret >= take_profit else "stop loss" if ret <= stop_loss
                      else "time limit" if held_d >= max_hold else None)
            exit_value = value
        if reason:
            b["cash"] += exit_value
            b["closed"].append({"mint": mint, "symbol": pos["symbol"], "opened": pos["opened"], "closed": ts,
                                "cost": pos["cost"], "proceeds": round(exit_value, 4),
                                "pnl": round(exit_value - pos["cost"], 4), "reason": reason, "url": pos["url"]})
            del b["open"][mint]
            log(f"  meme paper: SELL {pos['symbol']} ({reason}) pnl ${exit_value - pos['cost']:+.2f}")

    # 2. scan for new entries
    seen = {t["mint"] for t in b["closed"]} | set(b["open"])
    mints = [m for m in fetch_candidates() if m not in seen]
    pairs = fetch_pairs(mints)
    ranked, rejected = [], {}
    for m, p in pairs.items():
        ok, why = passes(p, now_ms, f=f)
        if not ok:
            rejected[why.split(" ")[0]] = rejected.get(why.split(" ")[0], 0) + 1
            continue
        ranked.append((momentum(p), m, p))
    ranked.sort(key=lambda t: -t[0])
    bought = 0
    for score, m, p in ranked:
        if len(b["open"]) >= MAX_OPEN or bought >= MAX_NEW_PER_CYCLE or b["cash"] < POSITION_USD:
            break
        try:
            rug = rugcheck(m)
        except Exception:
            continue                                   # no safety report -> no trade
        ok, why = passes(p, now_ms, rug, f=f)
        if not ok:
            rejected["rugcheck"] = rejected.get("rugcheck", 0) + 1
            continue
        price = _price(p)
        if price <= 0:
            continue
        sym = (p.get("baseToken") or {}).get("symbol") or m[:6]
        b["cash"] -= POSITION_USD
        b["open"][m] = {"symbol": sym, "opened": ts, "opened_ms": now_ms, "entry_price": price,
                        "qty": POSITION_USD * (1 - COST) / price, "cost": POSITION_USD, "value": POSITION_USD * (1 - COST) * (1 - COST),
                        "score": score, "url": p.get("url")}
        bought += 1
        log(f"  meme paper: BUY {sym} at ${price:.8g} (momentum {score})")

    store.kv_set("paper_meme", b)
    store.kv_set("paper_meme_last_scan", {"time": ts, "candidates": len(mints), "with_pairs": len(pairs),
                                          "passed_market_filters": len(ranked), "rejected": rejected})
    st = stats(b)
    log(f"  meme paper: {len(pairs)} scanned, {len(ranked)} passed filters, equity ${st['equity']} "
        f"({st['return_pct']:+.2f}%), {st['open_positions']} open, {st['trades_closed']} closed")
    return st
