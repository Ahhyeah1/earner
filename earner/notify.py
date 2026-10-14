"""Tell the owner when (and only when) something needs them, or money arrives.

Channels:
  * phone push via ntfy.sh (free, no account): install the ntfy app and subscribe to the private topic in
    .env (EARNER_NTFY_TOPIC, generated automatically). Messages never contain keys or wallet secrets.
  * Windows desktop notification (built into Windows, no install).
Every notification has a key and is sent at most once (or once per day for recurring states).
"""
import base64
import os
import secrets
import subprocess
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NTFY = "https://ntfy.sh/"
DASHBOARD = "http://127.0.0.1:8765"


def ensure_topic(env_path=ROOT / ".env"):
    """Create a private, unguessable ntfy topic once and store it in .env."""
    topic = os.environ.get("EARNER_NTFY_TOPIC")
    if topic:
        return topic
    topic = "earner-" + secrets.token_urlsafe(18).replace("_", "x").replace("-", "y").lower()
    try:
        with open(env_path, "a", encoding="utf-8") as f:
            f.write("\n# Phone notifications: install the 'ntfy' app and subscribe to this topic (keep it private)\n"
                    f"EARNER_NTFY_TOPIC={topic}\n")
    except OSError:
        return None
    os.environ["EARNER_NTFY_TOPIC"] = topic
    return topic


def _ntfy(title, message, priority, tags, click):
    topic = os.environ.get("EARNER_NTFY_TOPIC")
    if not topic or os.environ.get("EARNER_NTFY_OFF"):
        return False
    headers = {"Title": title.encode("utf-8").decode("latin-1", "ignore"), "Priority": str(priority),
               "Tags": ",".join(tags), "User-Agent": "earner"}
    if click:
        headers["Click"] = click
    req = urllib.request.Request(NTFY + topic, data=message.encode("utf-8"), headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status == 200
    except Exception:
        return False


_TOAST = r"""
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$t = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{title}'))
$m = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{msg}'))
$x = New-Object Windows.Data.Xml.Dom.XmlDocument
$x.LoadXml("<toast activationType='protocol' launch='{url}'><visual><binding template='ToastGeneric'><text></text><text></text></binding></visual></toast>")
$n = $x.GetElementsByTagName('text'); $n.Item(0).InnerText = $t; $n.Item(1).InnerText = $m
$app = '{{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}}\WindowsPowerShell\v1.0\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($x))
"""


def _toast(title, message, click):
    if os.name != "nt" or os.environ.get("EARNER_TOAST_OFF"):
        return False
    b = lambda s: base64.b64encode(s.encode("utf-8")).decode()  # noqa: E731
    script = _TOAST.format(title=b(title[:120]), msg=b(message[:400]), url=(click or DASHBOARD).replace("'", ""))
    try:
        r = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
                           capture_output=True, timeout=20, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        return r.returncode == 0
    except Exception:
        return False


def send(store, key, title, message, priority=3, tags=("robot",), click=None, daily=False, ts=None):
    """Send once per key (or once per key per day when daily=True). Returns True if sent now."""
    from datetime import datetime, timezone
    day = (ts or datetime.now(timezone.utc).isoformat())[:10]
    k = f"{key}@{day}" if daily else key
    sent = store.kv_get("notified") or []
    if k in sent:
        return False
    ok_phone = _ntfy(title, message, priority, tags, click or DASHBOARD)
    ok_desk = _toast(title, message, click or DASHBOARD)
    store.kv_set("notified", (sent + [k])[-500:])
    store.kv_set("last_notification", {"key": k, "title": title, "message": message, "ts": ts or day,
                                       "phone": ok_phone, "desktop": ok_desk})
    return True
