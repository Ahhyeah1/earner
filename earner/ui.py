"""Local dashboard: python -m earner ui  ->  http://127.0.0.1:8765

Read-only view of everything the agent does, plus three controls (run now / pause / resume)
that only drive the Windows scheduled task. Binds to localhost only.
"""
import json
import os
import urllib.parse
import subprocess
import webbrowser
from collections import defaultdict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from . import memory, paper, policy
from .autopilot import ROOT, STATUS
from .store import Store


def evm_address():
    from .evm import address   # needs eth_account; dashboard still works without it
    try:
        return address()
    except Exception:
        return None

HTML = Path(__file__).with_name("dashboard.html")
LOG = ROOT / "logs" / "autopilot.log"
TASK = "earner-autopilot"
DB = ROOT / "data" / "earner.db"


def _task():
    try:
        out = subprocess.run(["schtasks", "/Query", "/TN", TASK, "/V", "/FO", "LIST"],
                             capture_output=True, text=True, timeout=15).stdout
    except Exception:
        return {"exists": False}
    info = {"exists": bool(out.strip())}
    for line in out.splitlines():
        k, _, v = line.partition(":")
        k, v = k.strip(), v.strip()
        if k in ("Status", "Next Run Time", "Last Run Time", "Last Result", "Scheduled Task State"):
            info[k] = v
    return info


def _rows(rows):
    return [dict(r) for r in rows]


def state():
    store = Store(DB)
    try:
        pol = policy.load()
        status = json.loads(STATUS.read_text(encoding="utf-8")) if STATUS.exists() else {}
        income, expenses = store.total("ledger"), store.total("expenses")
        profit = income - expenses

        # cumulative profit per day
        daily = defaultdict(float)
        for r in store.db.execute("SELECT substr(ts,1,10) d, SUM(usd) FROM ledger GROUP BY d"):
            daily[r[0]] += r[1] or 0
        for r in store.db.execute("SELECT substr(ts,1,10) d, SUM(usd) FROM expenses GROUP BY d"):
            daily[r[0]] -= r[1] or 0
        cum, series = 0.0, []
        for d in sorted(daily):
            cum += daily[d]
            series.append([d, round(cum, 4)])

        pstate = store.kv_get("paper") or {}
        agent = store.kv_get("superteam_agent") or {}
        subs = _rows(store.db.execute(
            "SELECT ts, listing_id, slug, decision, reason FROM submissions ORDER BY id DESC LIMIT 100"))
        counts = {k: v for k, v in store.db.execute(
            "SELECT decision, COUNT(*) FROM submissions GROUP BY decision")}

        def opps(track, n):
            out = []
            for r in store.ranked(track, limit=n):
                out.append({"id": r["id"], "title": r["title"], "url": r["url"], "score": r["score"],
                            "reasons": json.loads(r["reasons"] or "[]")})
            return out

        log = LOG.read_text(encoding="utf-8", errors="replace").splitlines()[-120:] if LOG.exists() else []
        return {
            "status": status,
            "treasury": {"income": round(income, 2), "expenses": round(expenses, 4),
                         "by_provider": {
                             "gemini": round(store.db.execute("SELECT COALESCE(SUM(usd),0) FROM expenses WHERE note LIKE '%gemini%'").fetchone()[0], 6),
                             "claude": round(store.db.execute("SELECT COALESCE(SUM(usd),0) FROM expenses WHERE note NOT LIKE '%gemini%'").fetchone()[0], 6)},
                         "profit": round(profit, 2), "series": series,
                         "ledger": _rows(store.db.execute("SELECT ts, usd, token, note FROM ledger ORDER BY id DESC LIMIT 50")),
                         "expenses_recent": _rows(store.db.execute(
                             "SELECT ts, category, usd, note FROM expenses ORDER BY id DESC LIMIT 50"))},
            "tiers": pol["tiers"], "caps": pol["hard_caps"], "gate": pol["live_trading_gate"],
            "flags": {"allow_auto_submit": pol.get("allow_auto_submit"),
                      "allow_live_trading": pol.get("allow_live_trading"),
                      "bootstrap_llm_usd": pol.get("bootstrap_llm_usd")},
            "paper": {"stats": paper.stats(pstate), "history": pstate.get("history", []),
                      "cash": pstate.get("cash"), "qty": pstate.get("qty", {}),
                      "start": paper.START_EQUITY},
            "agent": {"username": agent.get("username"), "claimed": bool(store.kv_get("claimed")),
                      "evm_address": evm_address(), "evm_balance": store.kv_get("evm_baseline"),
                      "claim_url": f"https://superteam.fun/earn/claim/{agent['claimCode']}"
                      if agent.get("claimCode") else None},
            "submissions": subs, "submission_counts": counts,
            "opportunities": {"work": opps("work", 10), "longshot": opps("longshot", 6)},
            "task": _task(), "log": log,
            "ideas": [{**{k: r[k] for k in ("id", "name", "url", "score", "probe_ok", "status", "first_seen")},
                       **{k: json.loads(r["data"]).get(k) for k in ("category", "how_agent_earns", "payment",
                                                                       "needs", "est_monthly_usd", "risks",
                                                                       "why", "probe")}}
                      for r in store.ideas()],
            "last_discovery": store.kv_get("last_discovery"),
            "assist": _rows(store.db.execute("SELECT id, ts, listing_id, slug, decision, reason, payload FROM submissions "
                                             "WHERE (listing_id LIKE 'assist:%' OR listing_id LIKE 'lead:%' OR listing_id LIKE 'client:%') "
                                             "AND decision IN ('ready','owner_submitted') "
                                             "ORDER BY id DESC LIMIT 20")),
            "notify": {"topic": os.environ.get("EARNER_NTFY_TOPIC"), "last": store.kv_get("last_notification")},
            "memory": {
                "lessons": _rows(store.db.execute("SELECT ts, topic, text FROM memories WHERE active=1 AND kind='lesson' ORDER BY id DESC LIMIT 20")),
                "adjustments": _rows(store.db.execute("SELECT ts, topic, text FROM memories WHERE kind='adjustment' ORDER BY id DESC LIMIT 20")),
                "observations": _rows(store.db.execute("SELECT ts, topic, text FROM memories WHERE kind='observation' ORDER BY id DESC LIMIT 40")),
                "reflection": (_rows(store.db.execute("SELECT ts, text FROM memories WHERE kind='reflection' ORDER BY id DESC LIMIT 1")) or [None])[0],
                "last_reflection": store.kv_get("last_reflection"),
                "params": memory.params(store),
                "bounds": {k: {"min": lo, "max": hi, "default": d} for k, (lo, hi, d) in memory.BOUNDS.items()},
                "paused": memory.paused(store),
            },
            "meme": {"book": store.kv_get("paper_meme") or {"open": {}, "closed": []},
                     "last_scan": store.kv_get("paper_meme_last_scan")},
        }
    finally:
        store.db.close()


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body, ctype="application/json"):
        data = body if isinstance(body, bytes) else json.dumps(body, default=str).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path in ("/", "/index.html"):
            self._send(200, HTML.read_bytes(), "text/html; charset=utf-8")
        elif self.path.startswith("/pack/"):
            return self._assist_page(urllib.parse.unquote(self.path.split("/", 2)[2]))
        elif self.path == "/api/state":
            try:
                self._send(200, state())
            except Exception as e:
                self._send(500, {"error": repr(e)})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        # Custom header = a cross-site page can't trigger these with a plain form post.
        if self.headers.get("X-Earner") != "1":
            return self._send(403, {"error": "forbidden"})
        if self.path.startswith("/api/pack/"):
            parts = self.path.split("/")              # /api/pack/<urlencoded listing id>/<done|skip>
            if len(parts) != 5 or parts[4] not in ("done", "skip"):
                return self._send(404, {"error": "not found"})
            st = Store(DB)
            try:
                n = st.db.execute("UPDATE submissions SET decision=? WHERE listing_id=? AND decision='ready'",
                                  ("owner_submitted" if parts[4] == "done" else "owner_skipped",
                                   urllib.parse.unquote(parts[3]))).rowcount
                st.commit()
            finally:
                st.db.close()
            return self._send(200 if n else 404, {"ok": bool(n)})
        if self.path == "/api/notify/test":
            st = Store(DB)
            try:
                from . import notify
                notify.ensure_topic()
                import time as _t
                notify.send(st, f"test-{_t.time()}", "Earner test notification",
                            "If you can read this, notifications work.", tags=("white_check_mark",))
                st.commit()
                last = st.kv_get("last_notification") or {}
            finally:
                st.db.close()
            return self._send(200, {"ok": True, "phone": last.get("phone"), "desktop": last.get("desktop")})
        if self.path.startswith("/api/strategy/") and self.path.endswith("/resume"):
            name = self.path.split("/")[3]
            st = Store(DB)
            try:
                ok = memory.resume(st, name)
                st.commit()
            finally:
                st.db.close()
            return self._send(200 if ok else 404, {"ok": ok})
        if self.path == "/api/tuning/reset":
            st = Store(DB)
            try:
                memory.reset_tuning(st)
                st.commit()
            finally:
                st.db.close()
            return self._send(200, {"ok": True})
        if self.path.startswith("/api/idea/"):
            parts = self.path.split("/")          # /api/idea/<id>/<approve|reject>
            if len(parts) != 5 or parts[4] not in ("approve", "reject"):
                return self._send(404, {"error": "not found"})
            from .cli import decide_idea
            st = Store(DB)
            try:
                res = decide_idea(st, parts[3], parts[4] == "approve")
            finally:
                st.db.close()
            return self._send(200 if res else 404, {"ok": bool(res), "plan": str(res) if res is not True else None})
        args = {"/api/run": ["/Run"], "/api/pause": ["/Change", "/DISABLE"],
                "/api/resume": ["/Change", "/ENABLE"]}.get(self.path)
        if not args:
            return self._send(404, {"error": "not found"})
        r = subprocess.run(["schtasks", *args[:1], "/TN", TASK, *args[1:]],
                           capture_output=True, text=True, timeout=30)
        self._send(200 if r.returncode == 0 else 500, {"ok": r.returncode == 0,
                                                       "output": (r.stdout + r.stderr).strip()})

    def _assist_page(self, aid):
        import html
        st = Store(DB)
        try:
            row = st.db.execute("SELECT payload FROM submissions WHERE listing_id=? ORDER BY id DESC LIMIT 1",
                                (aid,)).fetchone()
        finally:
            st.db.close()
        path = json.loads((row or {})["payload"] or "{}").get("path") if row else None
        if not path or not Path(path).exists() or ROOT / "work" not in Path(path).resolve().parents:
            return self._send(404, b"not found", "text/plain")
        body = html.escape(Path(path).read_text(encoding="utf-8"))
        page = ("<!doctype html><meta charset=utf-8><title>Submission pack</title>"
                "<body style='font:15px/1.6 system-ui;max-width:860px;margin:30px auto;padding:0 16px'>"
                "<button onclick=\"navigator.clipboard.writeText(document.querySelector('pre').innerText)\">Copy all</button>"
                f"<pre style='white-space:pre-wrap'>{body}</pre></body>")
        self._send(200, page.encode("utf-8"), "text/html; charset=utf-8")

    def log_message(self, *a):
        pass


def serve(port=8765, open_browser=True):
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    url = f"http://127.0.0.1:{port}"
    print(f"earner dashboard on {url}  (Ctrl+C to stop)")
    if open_browser:
        webbrowser.open(url)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
