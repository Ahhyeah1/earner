// Watchtower: users /watch a token; a cron re-checks every 15 minutes and alerts on dangerous changes.
// All watches live in ONE KV key (one read per run, one write only when something changed) to stay far
// inside the free KV limits.
import { assessMint, type Assessment } from "./risk";
import { record } from "./events";

export type Snapshot = {
  mint_authority: string | null; freeze_authority: string | null; extensions: string[];
  flags: string[]; top1: number | null; top10: number | null; level: string;
};
export type Watch = { uid: number; chat: number; mint: string; until: number; paid: boolean; snap?: Snapshot };
export type Store = { watches: Watch[] };

// One free watch at a time (3 days); each paid watch credit = one token watched for 30 days.
export const FREE_DAYS = 3, PAID_DAYS = 30, MAX_PER_USER = 25;
const KEY = "tg:watches";

export async function load(kv: KVNamespace): Promise<Store> {
  return (await kv.get<Store>(KEY, "json")) ?? { watches: [] };
}
export async function save(kv: KVNamespace, s: Store) { await kv.put(KEY, JSON.stringify(s)); }

export function snapshot(a: Assessment): Snapshot {
  const f: any = a.facts;
  return { mint_authority: f.mint_authority ?? null, freeze_authority: f.freeze_authority ?? null,
           extensions: [...(f.extensions || [])].sort(), flags: a.checks.filter((c) => !c.ok).map((c) => c.id).sort(),
           top1: f.top1_pct ?? null, top10: f.top10_pct ?? null, level: a.level };
}

/** Human-readable alerts for changes that matter to a holder. Empty = nothing worth waking anyone for. */
export function diff(prev: Snapshot, next: Snapshot): string[] {
  const out: string[] = [];
  if (!prev.mint_authority && next.mint_authority) out.push(`🔴 Mint authority was RE-ENABLED (${next.mint_authority}): new tokens can be printed.`);
  else if (prev.mint_authority && next.mint_authority && prev.mint_authority !== next.mint_authority) out.push(`🟠 Mint authority changed hands to ${next.mint_authority}.`);
  if (!prev.freeze_authority && next.freeze_authority) out.push(`🔴 Freeze authority was ADDED (${next.freeze_authority}): wallets can now be frozen.`);
  const added = next.extensions.filter((e) => !prev.extensions.includes(e));
  if (added.length) out.push(`🟠 New token extension(s): ${added.join(", ")}.`);
  const newFlags = next.flags.filter((f) => !prev.flags.includes(f) && f !== "mutable_metadata");
  if (newFlags.length) out.push(`🟠 New red flag(s): ${newFlags.join(", ")}.`);
  if (prev.top1 != null && next.top1 != null) {
    if (next.top1 - prev.top1 >= 10) out.push(`🟠 Largest holder jumped from ${prev.top1}% to ${next.top1}% of supply.`);
    if (prev.top1 >= 10 && next.top1 <= prev.top1 / 2) out.push(`🟡 Largest holder dropped from ${prev.top1}% to ${next.top1}% (big sell or LP change?).`);
  }
  if (prev.top10 != null && next.top10 != null && next.top10 - prev.top10 >= 10) out.push(`🟠 Top-10 concentration rose from ${prev.top10}% to ${next.top10}%.`);
  const order = ["low", "medium", "high", "critical"];
  if (order.indexOf(next.level) > order.indexOf(prev.level) && order.indexOf(next.level) >= 2) out.push(`⚠️ Overall risk rose from ${prev.level} to ${next.level}.`);
  return out;
}

export type AddResult = { ok: true; until: number; paid: boolean } | { ok: false; reason: "duplicate" | "limit" | "no_credit" };

/** Free watch if the user has none active, otherwise needs a paid credit (caller deducts it when paid=true). */
export function add(s: Store, uid: number, chat: number, mint: string, credits: number, now = Date.now()): AddResult {
  const mine = s.watches.filter((w) => w.uid === uid && w.until > now);
  if (mine.some((w) => w.mint === mint)) return { ok: false, reason: "duplicate" };
  if (mine.length >= MAX_PER_USER) return { ok: false, reason: "limit" };
  const paid = mine.some((w) => !w.paid);
  if (paid && credits < 1) return { ok: false, reason: "no_credit" };
  const until = now + (paid ? PAID_DAYS : FREE_DAYS) * 86_400_000;
  s.watches.push({ uid, chat, mint, until, paid });
  return { ok: true, until, paid };
}

export function mine(s: Store, uid: number, now = Date.now()): Watch[] {
  return s.watches.filter((w) => w.uid === uid && w.until > now);
}

export function remove(s: Store, uid: number, mint: string): boolean {
  const n = s.watches.length;
  s.watches = s.watches.filter((w) => !(w.uid === uid && w.mint === mint));
  return s.watches.length < n;
}

type Send = (chat: number, text: string) => Promise<unknown>;

// Free Workers plan: 50 outbound requests per invocation; one check is ~2-3 RPC calls (+ any alerts),
// so each run re-checks at most this many tokens and rotates through the rest on later runs.
export const TOKENS_PER_RUN = 12;
const RUN_MS = 15 * 60_000;

/** Cron body: re-check watched tokens (once per token, shared across users), alert on changes, drop expired. */
export async function run(kv: KVNamespace, rpc: string, send: Send, now = Date.now(), assess = assessMint) {
  const s = await load(kv);
  let changed = false;
  const live = s.watches.filter((w) => w.until > now);
  for (const w of s.watches.filter((w) => w.until <= now)) {
    await send(w.chat, `⏰ Your watch on <code>${w.mint}</code> has ended. /watch it again to keep monitoring.`);
    changed = true;
  }
  const byMint = new Map<string, Watch[]>();
  for (const w of live) byMint.set(w.mint, [...(byMint.get(w.mint) || []), w]);
  const mints = [...byMint.keys()].sort();
  const start = mints.length > TOKENS_PER_RUN ? (Math.floor(now / RUN_MS) * TOKENS_PER_RUN) % mints.length : 0;
  const batch = [...mints, ...mints].slice(start, start + Math.min(TOKENS_PER_RUN, mints.length));
  for (const mint of batch) {
    let a: Assessment;
    try { a = await assess(mint, rpc); } catch { continue; }          // transient failure: try next run
    const fresh = snapshot(a);
    let logged = false;
    for (const w of byMint.get(mint)!) {
      // First sight: just record the baseline.
      if (!w.snap) { w.snap = fresh; changed = true; continue; }
      // A holder lookup that failed this time isn't a change: keep the last known holder numbers.
      // (Contract changes still alert through their own flags/authorities.)
      const snap = w.snap.top1 != null && fresh.top1 == null ? { ...fresh, top1: w.snap.top1, top10: w.snap.top10,
        flags: [...new Set([...fresh.flags, ...w.snap.flags.filter((f) => f.startsWith("top"))])].sort(), level: w.snap.level } : fresh;
      // The baseline only moves after an alert, so slow drift still adds up to an alert and quiet runs cost no KV writes.
      const alerts = diff(w.snap, snap);
      if (alerts.length) {
        await send(w.chat, `🚨 <b>Watch alert</b> for <code>${mint}</code>\n\n${alerts.join("\n")}\n\n<i>Not financial advice.</i>`);
        if (!logged) { logged = true; await record(kv, a, "watch", alerts, now).catch(() => {}); }
        w.snap = snap; changed = true;
      }
    }
  }
  if (changed) {
    // Re-read so watches users added during this run aren't overwritten.
    const latest = await load(kv);
    const ours = new Map(live.map((w) => [`${w.uid}:${w.mint}`, w.snap]));
    latest.watches = latest.watches.filter((w) => w.until > now).map((w) => ({ ...w, snap: ours.get(`${w.uid}:${w.mint}`) ?? w.snap }));
    await save(kv, latest);
  }
  return { watched: live.length, tokens: mints.length, checked: batch.length, saved: changed };
}
