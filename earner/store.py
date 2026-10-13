"""SQLite state: every opportunity ever seen, its status, and an earnings ledger."""
import json
import sqlite3
from pathlib import Path

MAX_FAILURES = 2   # each attempt costs LLM money; don't retry a broken listing forever

SCHEMA = """
CREATE TABLE IF NOT EXISTS opps (
  id TEXT PRIMARY KEY, source TEXT, title TEXT, url TEXT, data TEXT,
  track TEXT, score REAL, reasons TEXT,
  status TEXT NOT NULL DEFAULT 'new',      -- new | approved | rejected | submitted | won | lost | gone
  first_seen TEXT, last_seen TEXT
);
CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, opp_id TEXT,
  amount REAL, token TEXT, usd REAL, tx TEXT, note TEXT
);
CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, category TEXT, usd REAL, note TEXT
);
CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, listing_id TEXT, slug TEXT,
  decision TEXT,                            -- skipped | submitted | failed
  reason TEXT, payload TEXT
);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT,
  kind TEXT,                                -- observation | lesson | adjustment | reflection
  topic TEXT, text TEXT, evidence TEXT, active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS ideas (
  id TEXT PRIMARY KEY, name TEXT, url TEXT, data TEXT, score REAL, probe_ok INTEGER,
  status TEXT NOT NULL DEFAULT 'proposed',  -- proposed | approved | rejected | built
  first_seen TEXT, last_seen TEXT
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, opp_id TEXT, action TEXT, note TEXT
);
"""


class Store:
    def __init__(self, path):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path)
        self.db.row_factory = sqlite3.Row
        self.db.executescript(SCHEMA)

    def upsert(self, opp, track, score, reasons, ts):
        cur = self.db.execute("SELECT status FROM opps WHERE id=?", (opp["id"],)).fetchone()
        if cur is None:
            self.db.execute(
                "INSERT INTO opps (id,source,title,url,data,track,score,reasons,first_seen,last_seen) "
                "VALUES (?,?,?,?,?,?,?,?,?,?)",
                (opp["id"], opp["source"], opp["title"], opp["url"], json.dumps(opp), track, score,
                 json.dumps(reasons), ts, ts))
            return True
        self.db.execute(
            "UPDATE opps SET title=?,url=?,data=?,track=?,score=?,reasons=?,last_seen=?, "
            "status=CASE WHEN status='gone' THEN 'new' ELSE status END WHERE id=?",
            (opp["title"], opp["url"], json.dumps(opp), track, score, json.dumps(reasons), ts, opp["id"]))
        return False

    def mark_gone(self, sources, ts):
        """Anything from a successfully-fetched source not seen this run has closed."""
        q = ",".join("?" * len(sources))
        self.db.execute(f"UPDATE opps SET status='gone' WHERE status='new' AND source IN ({q}) "
                        f"AND last_seen < ?", (*sources, ts))

    def get(self, opp_id):
        row = self.db.execute("SELECT * FROM opps WHERE id=? OR id LIKE ?",
                              (opp_id, f"%:{opp_id}")).fetchall()
        if len(row) != 1:
            return None
        return row[0]

    def ranked(self, track, status="new", limit=10):
        return self.db.execute(
            "SELECT * FROM opps WHERE track=? AND status=? AND score IS NOT NULL "
            "ORDER BY score DESC LIMIT ?", (track, status, limit)).fetchall()

    def by_status(self, status):
        return self.db.execute("SELECT * FROM opps WHERE status=? ORDER BY score DESC",
                               (status,)).fetchall()

    def set_status(self, opp_id, status, ts, note=""):
        self.db.execute("UPDATE opps SET status=? WHERE id=?", (status, opp_id))
        self.db.execute("INSERT INTO events (ts,opp_id,action,note) VALUES (?,?,?,?)",
                        (ts, opp_id, status, note))

    def add_earning(self, ts, opp_id, amount, token, usd, tx, note):
        self.db.execute("INSERT INTO ledger (ts,opp_id,amount,token,usd,tx,note) VALUES (?,?,?,?,?,?,?)",
                        (ts, opp_id, amount, token, usd, tx, note))

    def ledger(self):
        return self.db.execute("SELECT * FROM ledger ORDER BY ts").fetchall()

    # --- treasury ---
    def add_expense(self, ts, category, usd, note=""):
        self.db.execute("INSERT INTO expenses (ts,category,usd,note) VALUES (?,?,?,?)",
                        (ts, category, usd, note))

    def total(self, table, since=None, category=None):
        q, args = f"SELECT COALESCE(SUM(usd),0) FROM {table} WHERE 1=1", []
        if since:
            q += " AND ts >= ?"
            args.append(since)
        if category:
            q += " AND category = ?"
            args.append(category)
        return self.db.execute(q, args).fetchone()[0]

    # --- agent work log ---
    def log_submission(self, ts, listing_id, slug, decision, reason, payload=None):
        self.db.execute("INSERT INTO submissions (ts,listing_id,slug,decision,reason,payload) "
                        "VALUES (?,?,?,?,?,?)",
                        (ts, listing_id, slug, decision, reason, json.dumps(payload) if payload else None))

    def handled(self, listing_id):
        """Decided already (submitted or deliberately skipped), or failed MAX_FAILURES times."""
        r = self.db.execute("SELECT SUM(decision!='failed'), SUM(decision='failed') FROM submissions "
                            "WHERE listing_id=?", (listing_id,)).fetchone()
        return bool(r[0]) or (r[1] or 0) >= MAX_FAILURES

    def submissions_since(self, since, micro=False):
        """Submissions today; micro=True counts BountyBook jobs (listing ids 'bb:'), else the rest."""
        op = "LIKE" if micro else "NOT LIKE"
        return self.db.execute("SELECT COUNT(*) FROM submissions WHERE decision='submitted' AND ts>=? "
                               f"AND listing_id {op} 'bb:%'", (since,)).fetchone()[0]

    def recent_submissions(self, limit=20):
        return self.db.execute("SELECT * FROM submissions ORDER BY id DESC LIMIT ?", (limit,)).fetchall()

    # --- discovered strategies ---
    def upsert_idea(self, idea_id, name, url, data, score, probe_ok, ts):
        new = self.db.execute("SELECT 1 FROM ideas WHERE id=?", (idea_id,)).fetchone() is None
        if new:
            self.db.execute("INSERT INTO ideas (id,name,url,data,score,probe_ok,first_seen,last_seen) "
                            "VALUES (?,?,?,?,?,?,?,?)",
                            (idea_id, name, url, json.dumps(data), score, int(probe_ok), ts, ts))
        else:
            self.db.execute("UPDATE ideas SET data=?, score=?, probe_ok=?, last_seen=? WHERE id=?",
                            (json.dumps(data), score, int(probe_ok), ts, idea_id))
        return int(new)

    def ideas(self, status=None):
        q, args = "SELECT * FROM ideas", []
        if status:
            q += " WHERE status=?"
            args.append(status)
        return self.db.execute(q + " ORDER BY score DESC", args).fetchall()

    def set_idea_status(self, idea_id, status):
        return self.db.execute("UPDATE ideas SET status=? WHERE id=?", (status, idea_id)).rowcount

    def kv_get(self, k, default=None):
        r = self.db.execute("SELECT v FROM kv WHERE k=?", (k,)).fetchone()
        return json.loads(r[0]) if r else default

    def kv_set(self, k, v):
        self.db.execute("INSERT INTO kv (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v",
                        (k, json.dumps(v)))

    def commit(self):
        self.db.commit()
