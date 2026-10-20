"""Strategy research: honest backtests for the agent's trading.

Rules that keep results honest:
- Signals use only closed candles; positions change at the NEXT candle's open (no look-ahead).
- Every position change pays `cost` per side (fees + slippage; on-chain swaps ~0.3%).
- Walk-forward: parameters are chosen on an earlier "train" window, then judged only on later data the
  choice never saw. A strategy only counts if it beats buy-and-hold AND cash out-of-sample after costs.
Candles: [time, low, high, open, close, volume] (Coinbase order), hourly.
"""
import math

HOURS_PER_YEAR = 24 * 365


# ------------------------------------------------------------------ indicators (all causal)
def ema(xs, n):
    k, out, e = 2 / (n + 1), [], None
    for x in xs:
        e = x if e is None else e + k * (x - e)
        out.append(e)
    return out


def rsi(closes, n=14):
    out, gain, loss = [None] * len(closes), 0.0, 0.0
    for i in range(1, len(closes)):
        d = closes[i] - closes[i - 1]
        g, l_ = max(d, 0), max(-d, 0)
        if i <= n:
            gain += g / n; loss += l_ / n
            if i == n:
                out[i] = 100 - 100 / (1 + gain / loss) if loss else 100
        else:
            gain = (gain * (n - 1) + g) / n; loss = (loss * (n - 1) + l_) / n
            out[i] = 100 - 100 / (1 + gain / loss) if loss else 100
    return out


def rolling(xs, n, fn):
    return [fn(xs[i - n + 1:i + 1]) if i >= n - 1 else None for i in range(len(xs))]


# ------------------------------------------------------------------ strategies -> target position per candle (0/1)
def s_hold(c, **_):
    return [1] * len(c)


def s_ema_cross(c, fast=12, slow=48, **_):
    cl = [x[4] for x in c]
    f, s = ema(cl, fast), ema(cl, slow)
    return [1 if i >= slow and f[i] > s[i] else 0 for i in range(len(c))]


def s_donchian(c, entry=48, exit=24, **_):
    hi = rolling([x[2] for x in c], entry, max)
    lo = rolling([x[1] for x in c], exit, min)
    pos, out = 0, []
    for i, x in enumerate(c):
        if i > entry:
            if pos == 0 and x[4] > hi[i - 1]:
                pos = 1
            elif pos == 1 and x[4] < lo[i - 1]:
                pos = 0
        out.append(pos)
    return out


def s_tsmom(c, lookback=168, **_):
    cl = [x[4] for x in c]
    return [1 if i >= lookback and cl[i] > cl[i - lookback] else 0 for i in range(len(c))]


def s_rsi_revert(c, n=14, buy=25, sell=55, max_hold=48, **_):
    r = rsi([x[4] for x in c], n)
    pos, held, out = 0, 0, []
    for i in range(len(c)):
        if r[i] is not None:
            if pos == 0 and r[i] < buy:
                pos, held = 1, 0
            elif pos == 1:
                held += 1
                if r[i] > sell or held >= max_hold:
                    pos = 0
        out.append(pos)
    return out


def s_trend_dip(c, trend=200, n=14, buy=35, sell=60, **_):
    """Buy oversold dips only while the long trend is up."""
    cl = [x[4] for x in c]
    t, r = ema(cl, trend), rsi(cl, n)
    pos, out = 0, []
    for i in range(len(c)):
        up = i >= trend and cl[i] > t[i]
        if r[i] is not None:
            if pos == 0 and up and r[i] < buy:
                pos = 1
            elif pos == 1 and (r[i] > sell or not up):
                pos = 0
        out.append(pos)
    return out


def s_hour_window(c, start=0, hold=8, **_):
    """Time-of-day effect: long from UTC hour `start` for `hold` hours."""
    out = []
    for x in c:
        h = (int(x[0]) // 3600) % 24
        out.append(1 if (h - start) % 24 < hold else 0)
    return out


STRATEGIES = {
    "buy_and_hold": (s_hold, [{}]),
    "ema_cross": (s_ema_cross, [{"fast": f, "slow": s} for f in (6, 12, 24, 48) for s in (48, 96, 168, 336) if f < s]),
    "donchian": (s_donchian, [{"entry": e, "exit": x} for e in (24, 48, 96, 168) for x in (12, 24, 48, 96) if x <= e]),
    "ts_momentum": (s_tsmom, [{"lookback": l} for l in (24, 48, 96, 168, 336, 720)]),
    "rsi_revert": (s_rsi_revert, [{"n": n, "buy": b, "sell": s, "max_hold": h} for n in (7, 14) for b in (20, 25, 30)
                                  for s in (50, 60) for h in (24, 72)]),
    "trend_dip": (s_trend_dip, [{"trend": t, "buy": b, "sell": s} for t in (100, 200, 400) for b in (30, 35, 40) for s in (55, 65)]),
    "hour_window": (s_hour_window, [{"start": h, "hold": k} for h in range(0, 24, 3) for k in (4, 8, 12)]),
}


# ------------------------------------------------------------------ simulation
def simulate(c, pos, cost=0.003):
    """Equity curve: position decided at candle i applies from candle i+1 open to close (open->close + gap)."""
    eq, cur, trades, exposure = [1.0], 0, 0, 0
    for i in range(1, len(c)):
        target = pos[i - 1]
        e = eq[-1]
        if target != cur:
            e *= 1 - cost
            trades += 1
            cur = target
        if cur:
            e *= c[i][4] / c[i - 1][4]
            exposure += 1
        eq.append(e)
    return eq, trades, exposure / max(1, len(c) - 1)


def stats(eq, trades=0, exposure=0.0):
    rets = [eq[i] / eq[i - 1] - 1 for i in range(1, len(eq))]
    mu = sum(rets) / len(rets) if rets else 0
    sd = math.sqrt(sum((r - mu) ** 2 for r in rets) / len(rets)) if rets else 0
    peak, mdd = eq[0], 0.0
    for v in eq:
        peak = max(peak, v); mdd = max(mdd, 1 - v / peak)
    return {"return": eq[-1] / eq[0] - 1, "sharpe": (mu / sd * math.sqrt(HOURS_PER_YEAR)) if sd else 0.0,
            "max_dd": mdd, "trades": trades, "exposure": exposure}


def run(c, fn, params, cost):
    eq, n, ex = simulate(c, fn(c, **params), cost)
    return stats(eq, n, ex)


def walk_forward(c, name, cost=0.003, train_frac=0.6, warmup=720):
    """Pick the best params by train Sharpe (min 3 trades), report the same params on the unseen test part.
    The test window is simulated with `warmup` candles of history before it so indicators are warmed up,
    but only test-period returns count."""
    fn, grid = STRATEGIES[name]
    cut = int(len(c) * train_frac)
    train = c[:cut]
    best, best_s = None, None
    for p in grid:
        s = run(train, fn, p, cost)
        if name != "buy_and_hold" and s["trades"] < 3:
            continue
        if best_s is None or s["sharpe"] > best_s["sharpe"]:
            best, best_s = p, s
    if best is None:
        return None
    full = c[max(0, cut - warmup):]
    pos = fn(full, **best)
    off = cut - max(0, cut - warmup)
    test_c, test_pos = full[off:], pos[off:]
    eq, n, ex = simulate(test_c, test_pos, cost)
    return {"strategy": name, "params": best, "train": best_s, "test": stats(eq, n, ex)}
