"""Rug Graveyard income: the worker's reclaim transactions pay a 10% fee to the owner's Solana wallet and carry a
fixed read-only REFERENCE key. Each cycle we list new transactions touching that key and book the fee wallet's
actual SOL increase as earnings (only confirmed, successful transactions)."""
import json
import os
import urllib.request

REFERENCE = "G6UU9Hjv2XaQcHuDbMyfgNFGgc3aaettcRhgJrpkbCfm"      # must match feed-worker/src/graveyard.ts
FEE_WALLET = "4px5eCg2hVXzFY4jguRQmQ4YUyJ5pXPPLJGPnHba6GLg"      # PAY_TO_SOLANA in feed-worker/wrangler.jsonc
KV_SEEN = "graveyard_seen"


def _rpc_url():
    k = os.environ.get("HELIUS_API_KEY")
    return f"https://mainnet.helius-rpc.com/?api-key={k}" if k else "https://api.mainnet-beta.solana.com"


def _rpc(url, method, params):
    req = urllib.request.Request(url, data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        body = json.loads(r.read())
    if body.get("error"):
        raise RuntimeError(body["error"].get("message"))
    return body.get("result")


def sol_usd():
    try:
        with urllib.request.urlopen("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd", timeout=20) as r:
            return float(json.loads(r.read())["solana"]["usd"])
    except Exception:
        return None


def fee_received(tx, fee_wallet=FEE_WALLET):
    """Lamports the fee wallet gained in this transaction (0 if it failed or wasn't involved)."""
    meta = (tx or {}).get("meta") or {}
    if meta.get("err") is not None:
        return 0
    keys = [k["pubkey"] if isinstance(k, dict) else k for k in tx["transaction"]["message"]["accountKeys"]]
    if fee_wallet not in keys:
        return 0
    i = keys.index(fee_wallet)
    return max(0, meta["postBalances"][i] - meta["preBalances"][i])


def check_income(store, ts, rpc=None, notify=None, log=print, price=sol_usd):
    url = rpc or _rpc_url()
    seen = set(store.kv_get(KV_SEEN, []))
    sigs = _rpc(url, "getSignaturesForAddress", [REFERENCE, {"limit": 100, "commitment": "finalized"}]) or []
    new = [s for s in sigs if s["signature"] not in seen and not s.get("err")]
    total, n, usd_px = 0, 0, None
    for s in reversed(new):
        tx = _rpc(url, "getTransaction", [s["signature"], {"encoding": "jsonParsed", "maxSupportedTransactionVersion": 0,
                                                           "commitment": "finalized"}])
        lam = fee_received(tx)
        seen.add(s["signature"])
        if not lam:
            continue
        if usd_px is None:
            usd_px = price() or 0.0
        sol = lam / 1e9
        store.add_earning(ts, "graveyard", sol, "SOL", round(sol * usd_px, 4), s["signature"], "Rug Graveyard reclaim fee")
        total += lam; n += 1
    store.kv_set(KV_SEEN, sorted(seen)[-2000:])
    store.commit()
    if n:
        log(f"  graveyard: {n} reclaim fee(s), {total / 1e9:.4f} SOL")
        if notify:
            notify(f"graveyard-{ts[:13]}", "Rug Graveyard income", f"{n} reclaim(s) paid {total / 1e9:.4f} SOL in fees.",
                   priority=3, tags=("moneybag", "headstone"))
    return n, total
