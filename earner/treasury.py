"""Income detection from a dedicated payout wallet (read-only: needs only the public address).

Any increase in the wallet's stablecoin balance is booked as income; decreases (you
withdrawing) just lower the baseline. So the wallet must be used for agent earnings only.
"""
import json
import urllib.request

RPC = "https://api.mainnet-beta.solana.com"
STABLE_MINTS = {
    "USDC": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "USDT": "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    "USDG": "2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH",
}


def _rpc(method, params, rpc=RPC):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    req = urllib.request.Request(rpc, data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        resp = json.loads(r.read())
    if "error" in resp:
        raise RuntimeError(resp["error"])
    return resp["result"]


def stable_balance(owner, rpc=RPC):
    total = 0.0
    for mint in STABLE_MINTS.values():
        res = _rpc("getTokenAccountsByOwner", [owner, {"mint": mint}, {"encoding": "jsonParsed"}], rpc)
        for acc in res["value"]:
            total += float(acc["account"]["data"]["parsed"]["info"]["tokenAmount"]["uiAmountString"])
    return total


def sync_wallet(store, owner, ts, balance_fn=stable_balance, log=print, baseline_key="wallet_baseline",
                label="wallet"):
    """Book balance increases as income. Returns current balance."""
    bal = balance_fn(owner)
    last = store.kv_get(baseline_key)
    if last is None:
        log(f"  {label}: baseline ${bal:,.2f} (existing funds are not counted as earnings)")
    elif bal > last + 0.01:
        gain = bal - last
        store.add_earning(ts, None, gain, "USD-stable", gain, "", f"{label} inflow")
        log(f"  {label}: +${gain:,.2f} income detected")
    store.kv_set(baseline_key, bal)
    return bal
