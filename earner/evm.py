"""The agent's own EVM (Base) receive address.

The key is created once and kept in data/evm_wallet.json (gitignored, outside OneDrive).
It is only used to sign platform logins; it never sends transactions, and holds only what
the agent earns. Sweep earnings to your own wallet whenever you like.
"""
import json
import urllib.request
from pathlib import Path

from eth_account import Account
from eth_account.messages import encode_defunct

ROOT = Path(__file__).resolve().parent.parent
WALLET = ROOT / "data" / "evm_wallet.json"
BASE_RPC = "https://mainnet.base.org"
BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"


def load_or_create(path=WALLET):
    if path.exists():
        data = json.loads(path.read_text(encoding="utf-8"))
    else:
        acct = Account.create()
        data = {"address": acct.address, "key": acct.key.hex(),
                "note": "Agent receive wallet on Base. Holds only earnings. Never share this file."}
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data, indent=2), encoding="utf-8")
    return data


def address(path=WALLET):
    return json.loads(path.read_text(encoding="utf-8"))["address"] if path.exists() else None


def sign(message, path=WALLET):
    """EIP-191 personal_sign of the exact string."""
    w = load_or_create(path)
    sig = Account.sign_message(encode_defunct(text=message), private_key=w["key"]).signature.hex()
    return sig if sig.startswith("0x") else "0x" + sig


def usdc_balance(owner, rpc=BASE_RPC):
    data = "0x70a08231" + owner.lower().replace("0x", "").rjust(64, "0")   # balanceOf(address)
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "eth_call",
                       "params": [{"to": BASE_USDC, "data": data}, "latest"]}).encode()
    req = urllib.request.Request(rpc, data=body, headers={"Content-Type": "application/json",
                                                          "User-Agent": "earner/0.3"})
    with urllib.request.urlopen(req, timeout=30) as r:
        resp = json.loads(r.read())
    if "error" in resp:
        raise RuntimeError(resp["error"])
    return int(resp["result"], 16) / 1e6
