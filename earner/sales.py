"""Book the feed worker's sales into the ledger: Telegram Stars purchases (KV tg:charge:*) and paid Rug Loss
Reports (KV loss:paid:*; SOL payments carry the tx signature, Stars ones are already covered by tg:charge).
Each sale is booked once (seen keys kept in kv)."""
import json
import urllib.parse

from . import grantsvc

KV_SEEN = "sales_seen"
STAR_USD = 0.013          # what a developer receives per Star, roughly (Telegram's payout rate)
LOSS_REPORT_USD = 19


def _list(prefix):
    keys, cursor = [], None
    while True:
        q = f"keys?prefix={urllib.parse.quote(prefix)}" + (f"&cursor={cursor}" if cursor else "")
        r = grantsvc._cf(q)
        keys += [k["name"] for k in r.get("result", [])]
        cursor = (r.get("result_info") or {}).get("cursor")
        if not cursor:
            return keys


def _value(key):
    v = grantsvc._cf("values/" + urllib.parse.quote(key, safe=""))
    return v if isinstance(v, dict) else json.loads(v) if isinstance(v, str) and v.startswith("{") else {}


def check_sales(store, ts, notify=None, log=print):
    seen = set(store.kv_get(KV_SEEN, []))
    booked = []
    for key in _list("tg:charge:"):
        if key in seen:
            continue
        v = _value(key)
        stars = int(v.get("stars") or 0)
        store.add_earning(ts, "telegram-bot", stars, "XTR", round(stars * STAR_USD, 2), key.split(":", 2)[2],
                          f"Telegram Stars: {v.get('pack', 'purchase')}")
        seen.add(key); booked.append(f"{v.get('pack', 'purchase')} ({stars}⭐)")
    for key in _list("loss:paid:"):
        if key in seen:
            continue
        v = _value(key)
        how = str(v.get("how", ""))
        seen.add(key)
        if how.startswith("sol:"):           # Stars-paid reports are booked through their tg:charge entry
            store.add_earning(ts, "loss-report", LOSS_REPORT_USD, "USD", LOSS_REPORT_USD, how[4:], "Rug Loss Report (paid in SOL)")
            booked.append("loss report (SOL)")
    store.kv_set(KV_SEEN, sorted(seen)[-5000:])
    store.commit()
    if booked:
        log(f"  sales: booked {len(booked)}: {', '.join(booked)}")
        if notify:
            notify(f"sales-{ts[:13]}", "New sales", ", ".join(booked), priority=3, tags=("moneybag",))
    return booked
