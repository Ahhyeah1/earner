// Rug radar: a public log of tokens the bot flagged (high/critical verdicts, group-guard hits, Watchtower
// alerts). Feeds the daily channel digest and the /rugs page, and is the start of a rug-outcome dataset.
// Stored per UTC day in one KV key; no user ids, only public on-chain facts.
import type { Assessment } from "./risk";

export type RugEvent = { at: string; mint: string; level: string; score: number; flags: string[]; src: "check" | "guard" | "watch"; alerts?: string[] };

const MAX_PER_DAY = 300;
const key = (d: string) => `ev:${d}`;
export const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export const FLAG_LABEL: Record<string, string> = {
  mint_authority: "can mint more", freeze_authority: "can freeze wallets", permanent_delegate: "permanent delegate",
  transfer_hook: "transfer hook", transfer_fee: "transfer fee", non_transferable: "can't be sold", default_frozen: "accounts start frozen",
  pausable: "pausable", mint_close_authority: "mint closable", mutable_metadata: "mutable metadata", zero_supply: "zero supply",
  top_holder: "one wallet >50%", top10_holders: "top 10 >80%",
};

export const flagged = (a: Assessment) => a.level === "high" || a.level === "critical";

export async function day(kv: KVNamespace, d: string): Promise<RugEvent[]> {
  return (await kv.get<RugEvent[]>(key(d), "json")) ?? [];
}

/** Log a flagged token. One entry per mint per source per day (repeat checks don't cost KV writes). */
export async function record(kv: KVNamespace, a: Assessment, src: RugEvent["src"], alerts?: string[], now = Date.now()) {
  if (src !== "watch" && !flagged(a)) return false;
  if (a.known) return false;                       // disclosed issuer controls (USDC etc.) aren't rugs
  const d = dayOf(now), list = await day(kv, d);
  if (list.length >= MAX_PER_DAY || list.some((e) => e.mint === a.mint && e.src === src && src !== "watch")) return false;
  list.push({ at: new Date(now).toISOString(), mint: a.mint, level: a.level, score: a.score,
              flags: a.checks.filter((c) => !c.ok && c.id !== "mutable_metadata").map((c) => c.id), src, ...(alerts ? { alerts } : {}) });
  await kv.put(key(d), JSON.stringify(list), { expirationTtl: 400 * 86_400 });
  return true;
}

export async function recent(kv: KVNamespace, hours: number, now = Date.now()): Promise<RugEvent[]> {
  const days = Math.ceil(hours / 24) + 1, since = now - hours * 3_600_000, out: RugEvent[] = [];
  for (let i = 0; i < days; i++) out.push(...(await day(kv, dayOf(now - i * 86_400_000))));
  return out.filter((e) => Date.parse(e.at) > since).sort((a, b) => b.at.localeCompare(a.at));
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const short = (m: string) => `${m.slice(0, 4)}…${m.slice(-4)}`;

/** Token name/symbol via Helius DAS getAsset (best effort; names are attacker-controlled, so escaped and trimmed). */
export async function names(rpc: string, mints: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  await Promise.all(mints.map(async (m) => {
    try {
      const r: any = await (await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAsset", params: { id: m } }) })).json();
      const md = r?.result?.content?.metadata, sym = String(md?.symbol || "").trim().slice(0, 12), nm = String(md?.name || "").trim().slice(0, 32);
      if (nm || sym) out[m] = esc(sym ? `${nm} ($${sym})` : nm);
    } catch { /* fall back to the short address */ }
  }));
  return out;
}

/** Daily channel post (Telegram HTML). Null when there's nothing worth posting. */
export function digest(evs: RugEvent[], nm: Record<string, string>, bot: string): string | null {
  if (!evs.length) return null;
  const tokens = new Map<string, RugEvent>();
  for (const e of evs) { const p = tokens.get(e.mint); if (!p || e.score > p.score) tokens.set(e.mint, e); }
  const crit = [...tokens.values()].filter((e) => e.level === "critical").length;
  const alerts = evs.filter((e) => e.src === "watch");
  const top = [...tokens.values()].sort((a, b) => b.score - a.score).slice(0, 10);
  const lines = [
    `🛡 <b>Solana rug radar</b> · last 24h`,
    `${tokens.size} token(s) flagged high/critical by on-chain checks (${crit} critical)` + (alerts.length ? ` · ${alerts.length} Watchtower alert(s)` : ""),
    "",
    ...top.map((e) => `${e.level === "critical" ? "🔴" : "🟠"} <a href="https://solscan.io/token/${e.mint}">${nm[e.mint] || short(e.mint)}</a> · ${e.score}/100`
      + (e.flags.length ? ` · ${e.flags.map((f) => FLAG_LABEL[f] || f).join(", ")}` : "")),
    "",
    `<i>Automated contract-level readings of public on-chain data, not accusations or financial advice.</i>`,
    `Check any token free: @${bot} · full log: earner-feed.earner-feed.workers.dev/rugs`,
  ];
  return lines.join("\n");
}

export function page(evs: RugEvent[], bot: string): string {
  const rows = evs.map((e) => `<tr><td>${e.at.slice(0, 16).replace("T", " ")}</td><td class="${e.level}">${e.level}</td><td>${e.score}</td>`
    + `<td><a href="https://solscan.io/token/${e.mint}" rel="nofollow">${short(e.mint)}</a></td><td>${esc(e.flags.map((f) => FLAG_LABEL[f] || f).join(", "))}`
    + `${e.alerts ? "<br><small>" + esc(e.alerts.join(" ")) + "</small>" : ""}</td><td>${e.src}</td></tr>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Solana rug radar</title><meta name="description" content="Live log of Solana tokens flagged by on-chain rug checks: mint and freeze authority, permanent delegates, transfer hooks, holder concentration.">
<style>:root{--bg:#fff;--fg:#1a1a1a;--mut:#666;--line:#e5e5e5}@media (prefers-color-scheme:dark){:root{--bg:#121212;--fg:#eee;--mut:#999;--line:#333}}
body{background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif;max-width:960px;margin:0 auto;padding:16px}a{color:#4a8cff}
table{width:100%;border-collapse:collapse;font-size:14px}td,th{padding:6px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
.critical{color:#e5484d;font-weight:600}.high{color:#f76b15;font-weight:600}small,p.m{color:var(--mut)}.wrap{overflow-x:auto}</style></head><body>
<h1>🛡 Solana rug radar</h1><p>Tokens flagged <b>high</b> or <b>critical</b> by <a href="https://t.me/${bot}">@${bot}</a> in the last 7 days: from user checks, group guard and Watchtower alerts.</p>
<p class="m">Automated contract-level readings of public Solana data. A flag is not an accusation and nothing here is financial advice. Liquidity and team behaviour are not assessed.</p>
<div class="wrap"><table><thead><tr><th>UTC</th><th>Risk</th><th>Score</th><th>Token</th><th>Why</th><th>Source</th></tr></thead><tbody>
${rows || '<tr><td colspan="6">Nothing flagged yet.</td></tr>'}</tbody></table></div>
<p class="m">JSON: <a href="/rugs.json">/rugs.json</a> · Paid API: <a href="/">x402 token-risk</a></p></body></html>`;
}
