// Royalty Hunter: find pump.fun coins whose creator has walked away while a community keeps trading them and
// creator fees keep piling up. Publishes a public board + a factual evidence pack per coin that the community
// can use for pump.fun's official CTO (community takeover) creator-fee application. If the pack helps, the
// community may (voluntarily) include the agent's wallet in the coin's fee split - pump.fun's fee sharing then
// pays it on-chain automatically. No DMs, no outreach: communities find the board themselves.
import * as PF from "./pumpfees";
import * as ES from "./eventstudy";

export type Social = { type: string; url: string };
export type Rec = {
  mint: string; symbol: string; name: string; creator: string; graduated: boolean; pool?: string;
  shared: boolean; holderReward: boolean; creatorFeeBps: number;
  vaultLamports: number; unsweptLamports: number; devLamports: number; devHolds: boolean | null;
  lastActivityDays: number | null; lastSignedDays: number | null; recentChecked: number;
  volume24h: number; liquidityUsd: number; weeklyFeeLamports: number; socials: Social[]; ageDays: number | null;
  verdict: "abandoned" | "active" | "shared" | "skip"; reasons: string[]; analyzedAt: string;
};
type State = { queue: string[]; board: Record<string, Rec>; filledAt?: string; lastError?: string };

export const PER_RUN = 3, BOARD_MAX = 400, RECHECK_HOURS = 24, ABANDON_DAYS = 14, MIN_AGE_DAYS = 14, SIGS_CHECKED = 3;
// Standard creator fee when a coin has no custom rate: 0.30% on the bonding curve; on PumpSwap it falls with market
// cap (down to 0.05%), so graduated coins use the lowest tier to keep estimates conservative.
export const DEFAULT_CURVE_BPS = 30, DEFAULT_POOL_BPS = 5;
const KEY = "rh:state";
const LISTS = ["https://api.dexscreener.com/token-profiles/latest/v1", "https://api.dexscreener.com/token-boosts/latest/v1",
               "https://api.dexscreener.com/token-boosts/top/v1", "https://api.dexscreener.com/community-takeovers/latest/v1"];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function rpc(url: string, method: string, params: unknown[]) {
  for (let i = 0; ; i++) {                  // free RPC tier: back off on 429 instead of losing the coin
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    if (res.status === 429 && i < 2) { await sleep(800 * (i + 1)); continue; }
    const r: any = await res.json();
    if (r.error) throw new Error(`${method}: ${r.error.message}`);
    return r.result;
  }
}

/** Old-but-alive candidates: coins traded on PumpSwap right now (graduated, any age), from recent on-chain swaps. */
async function tradedNow(url: string, max: number): Promise<string[]> {
  const sigs: any[] = await rpc(url, "getSignaturesForAddress", [PF.PSWAP, { limit: 60, commitment: "confirmed" }]).catch(() => []);
  const out = new Set<string>();
  for (const sg of sigs.filter((x) => !x.err).filter((_, i) => i % 6 === 0).slice(0, max)) {
    const tx = await rpc(url, "getTransaction", [sg.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]).catch(() => null);
    for (const b of tx?.meta?.postTokenBalances || []) if (/pump$/.test(b.mint)) out.add(b.mint);
  }
  return [...out];
}

/** Pure: the verdict and the human-readable reasons, from measured facts. */
export function judge(r: Omit<Rec, "verdict" | "reasons">): Pick<Rec, "verdict" | "reasons"> {
  if (r.holderReward) return { verdict: "skip", reasons: ["Holder-rewards coin: creator fees already go to holders."] };
  if (r.shared) return { verdict: "shared", reasons: ["Creator fees already go through pump.fun fee sharing."] };
  const waiting = r.vaultLamports + r.unsweptLamports;
  // Gone = sold out AND no sign of life: no transaction signed by the creator for ABANDON_DAYS (or none at all in
  // its recent history while nothing has touched the wallet for that long). A burner wallet emptied yesterday on a
  // day-old coin is NOT abandonment, hence also the minimum coin age.
  const quiet = r.lastSignedDays != null ? r.lastSignedDays >= ABANDON_DAYS : (r.lastActivityDays ?? 0) >= ABANDON_DAYS;
  const old = (r.ageDays ?? 0) >= MIN_AGE_DAYS;
  const gone = r.devHolds === false && quiet && old;
  const worth = waiting >= 50_000_000 || r.weeklyFeeLamports >= 50_000_000;
  const alive = r.volume24h >= 5_000 || r.liquidityUsd >= 10_000;
  const reasons = [
    r.devHolds === false ? "Creator wallet holds none of the coin." : r.devHolds ? "Creator wallet still holds the coin." : "Creator holdings unknown.",
    r.devLamports < 10_000_000 ? `Creator wallet is nearly empty (${(r.devLamports / 1e9).toFixed(4)} SOL).` : `Creator wallet holds ${(r.devLamports / 1e9).toFixed(2)} SOL.`,
    r.lastSignedDays != null ? `Last transaction signed by the creator: ${r.lastSignedDays.toFixed(0)} days ago.`
      : r.lastActivityDays != null ? `None of the creator wallet's ${r.recentChecked} most recent transactions were signed by it (latest activity ${r.lastActivityDays.toFixed(0)} days ago).` : "No creator activity found.",
    `${(waiting / 1e9).toFixed(3)} SOL of creator fees waiting unclaimed; about ${(r.weeklyFeeLamports / 1e9).toFixed(3)} SOL/week at current volume.`,
    `Trading: $${Math.round(r.volume24h).toLocaleString("en-US")} in 24h, $${Math.round(r.liquidityUsd).toLocaleString("en-US")} liquidity`
      + (r.ageDays != null ? `; coin is ${r.ageDays.toFixed(0)} days old.` : "."),
  ];
  return { verdict: gone && worth && alive ? "abandoned" : "active", reasons };
}

export async function analyze(mint: string, url: string, now: number): Promise<Rec | null> {
  const got: any = await (await fetch(`https://api.dexscreener.com/token-pairs/v1/solana/${mint}`)).json().catch(() => []);
  const pairs: any[] = Array.isArray(got) ? got : [];
  const main = pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
  const ai = await rpc(url, "getAccountInfo", [await PF.bondingCurve(mint), { encoding: "base64", commitment: "confirmed" }]);
  const curve = ai?.value && PF.decodeCurve(PF.fromB64(ai.value.data[0]));
  if (!curve || curve.quoteMint !== PF.WSOL) return null;
  const shared = curve.creator === await PF.sharingConfig(mint);
  const pool = curve.complete ? pairs.find((p) => p.dexId === "pumpswap")?.pairAddress as string | undefined : undefined;
  let poolDec: PF.Pool | null = null;
  if (pool) { const pa = await rpc(url, "getAccountInfo", [pool, { encoding: "base64", commitment: "confirmed" }]); poolDec = pa?.value ? PF.decodePool(PF.fromB64(pa.value.data[0])) : null; }
  const creator = curve.creator;
  const base = { mint, symbol: String(main?.baseToken?.symbol || "?").slice(0, 16), name: String(main?.baseToken?.name || "").slice(0, 40), creator,
    graduated: curve.complete, pool, shared, holderReward: curve.holderReward || !!poolDec?.holderReward,
    creatorFeeBps: (poolDec?.creatorFeeBps || curve.creatorFeeBps) || 0, volume24h: Number(main?.volume?.h24 || 0), liquidityUsd: Number(main?.liquidity?.usd || 0),
    socials: [...(main?.info?.socials || []), ...(main?.info?.websites || []).map((w: any) => ({ type: "website", url: w.url }))].slice(0, 6)
      .map((s: any) => ({ type: String(s.type || s.label || "link"), url: String(s.url) })).filter((s: Social) => /^https:\/\//.test(s.url)),
    ageDays: pairs.length ? (now - Math.min(...pairs.map((p) => Number(p.pairCreatedAt) || now))) / 86_400_000 : null,
    analyzedAt: new Date(now).toISOString() };
  if (shared || base.holderReward) {
    const r = { ...base, vaultLamports: 0, unsweptLamports: 0, devLamports: 0, devHolds: null, lastActivityDays: null, lastSignedDays: null, recentChecked: 0, weeklyFeeLamports: 0 };  // fees don't reach the creator
    return { ...r, ...judge(r) };
  }
  const [devLamports, holdings, sigs, vaultBal, swapAmt] = await Promise.all([
    rpc(url, "getBalance", [creator, { commitment: "confirmed" }]).then((r) => Number(r.value)),
    rpc(url, "getTokenAccountsByOwner", [creator, { mint }, { encoding: "jsonParsed", commitment: "confirmed" }]).then((r) => r.value as any[]).catch(() => null),
    rpc(url, "getSignaturesForAddress", [creator, { limit: 20 }]).catch(() => []) as Promise<any[]>,
    rpc(url, "getBalance", [await PF.pumpCreatorVault(creator), { commitment: "confirmed" }]).then((r) => Math.max(0, Number(r.value) - 650_240)),
    PF.swapVaultAuthority(creator).then((a) => PF.ata(a, PF.WSOL)).then((v) => rpc(url, "getTokenAccountBalance", [v, { commitment: "confirmed" }]))
      .then((r) => Number(r?.value?.amount || 0)).catch(() => 0),
  ]);
  const devHolds = holdings === null ? null : holdings.some((h) => Number(h.account.data.parsed.info.tokenAmount.amount) > 0);
  const lastActivityDays = sigs[0]?.blockTime ? (now / 1000 - sigs[0].blockTime) / 86400 : null;
  let lastSignedDays: number | null = null, recentChecked = 0;
  for (const s of sigs.slice(0, SIGS_CHECKED)) {   // was the creator the signer? (a few most recent only: request limits)
    recentChecked++;
    const tx = await rpc(url, "getTransaction", [s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]).catch(() => null);
    if (tx?.transaction?.message?.accountKeys?.some((k: any) => k.signer && k.pubkey === creator)) { lastSignedDays = (now / 1000 - s.blockTime) / 86400; break; }
  }
  const solUsd = main?.priceUsd && main?.priceNative && main.quoteToken?.symbol === "SOL" ? Number(main.priceUsd) / Number(main.priceNative) : 0;
  const bps = base.creatorFeeBps || (curve.complete ? DEFAULT_POOL_BPS : DEFAULT_CURVE_BPS);
  const weeklyFeeLamports = solUsd > 0 ? Math.round(base.volume24h * (bps / 10_000) * 7 / solUsd * 1e9) : 0;
  const r = { ...base, vaultLamports: vaultBal + swapAmt, unsweptLamports: curve.creatorFee + (poolDec?.creatorFees || 0), devLamports, devHolds,
    lastActivityDays, lastSignedDays, recentChecked, weeklyFeeLamports };
  return { ...r, ...judge(r) };
}

/** Cron step: refill the queue from DexScreener lists when empty, analyze a few coins, save the board (one KV write). */
export async function run(kv: KVNamespace, url: string, notify?: (title: string, body: string) => Promise<unknown>, now = Date.now()) {
  const s: State = (await kv.get<State>(KEY, "json")) ?? { queue: [], board: {} };
  if (!s.queue.length) {                   // refill run: discovery only (keeps this invocation within request limits)
    const seen = new Set<string>(await tradedNow(url, 8));
    for (const u of LISTS) {
      try { for (const t of await (await fetch(u)).json() as any[]) if (t.chainId === "solana" && /pump$/.test(t.tokenAddress)) seen.add(t.tokenAddress); } catch { /* list down */ }
    }
    const fresh = (m: string) => !s.board[m] || now - Date.parse(s.board[m].analyzedAt) > RECHECK_HOURS * 3_600_000;
    s.queue = [...seen].filter(fresh); s.filledAt = new Date(now).toISOString();
    await kv.put(KEY, JSON.stringify(s));
    return { analyzed: 0, queue: s.queue.length, board: Object.keys(s.board).length, abandoned: Object.values(s.board).filter((r) => r.verdict === "abandoned").length };
  }
  const done: Rec[] = [];
  for (const m of s.queue.splice(0, PER_RUN)) {
    try {
      const r = await analyze(m, url, now);
      if (!r) continue;
      const wasAbandoned = s.board[m]?.verdict === "abandoned";
      s.board[m] = r; done.push(r);
      if (notify && r.verdict === "abandoned" && !wasAbandoned && (r.vaultLamports + r.unsweptLamports >= 1e9 || r.weeklyFeeLamports >= 5e8)) {
        await notify("Royalty Hunter: abandoned coin", `$${r.symbol}: ${((r.vaultLamports + r.unsweptLamports) / 1e9).toFixed(2)} SOL waiting, ~${(r.weeklyFeeLamports / 1e9).toFixed(2)} SOL/week. Evidence pack is on the board.`).catch(() => {});
      }
    } catch (e) { s.lastError = `${new Date(now).toISOString()} ${m}: ${String((e as Error)?.message || e).slice(0, 160)}`; }  // retried on a later refill
  }
  const keep = Object.values(s.board).sort((a, b) => b.analyzedAt.localeCompare(a.analyzedAt)).slice(0, BOARD_MAX);
  s.board = Object.fromEntries(keep.map((r) => [r.mint, r]));
  await kv.put(KEY, JSON.stringify(s));
  try {      // event study: dev sold out vs dev still holds (control), abandoned
    const items: { mint: string; sig: ES.Signal; extra: Record<string, number> }[] = [];
    for (const r of done.filter((x) => x.verdict !== "shared" && x.verdict !== "skip" && x.devHolds !== null)) {
      const extra = { ageDays: Math.round((r.ageDays ?? -1) * 10) / 10, vol24h: Math.round(r.volume24h) };
      items.push({ mint: r.mint, sig: r.devHolds ? "dev_holds" : "dev_sold_out", extra });
      if (r.verdict === "abandoned") items.push({ mint: r.mint, sig: "abandoned", extra });
    }
    await ES.log(kv, items, now);
    await ES.followUp(kv, now);
  } catch { /* research must never break the scanner */ }
  return { analyzed: done.length, queue: s.queue.length, board: keep.length, abandoned: keep.filter((r) => r.verdict === "abandoned").length };
}

export async function status(kv: KVNamespace) {
  const s = await kv.get<State>(KEY, "json");
  return { queue: s?.queue.length ?? 0, board: Object.keys(s?.board || {}).length, filledAt: s?.filledAt, lastError: s?.lastError };
}

export async function board(kv: KVNamespace): Promise<Rec[]> {
  const s = await kv.get<State>(KEY, "json");
  return Object.values(s?.board || {});
}

// ---------------------------------------------------------------- pages
const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const sol = (l: number, dp = 3) => (l / 1e9).toFixed(dp);
const AGENT_WALLET = "4px5eCg2hVXzFY4jguRQmQ4YUyJ5pXPPLJGPnHba6GLg";
const CTO_POST = "https://x.com/Pumpfun/status/1946290156455260281";

const STYLE = `:root{--bg:#f7f7fb;--card:#fff;--fg:#1b1b24;--mut:#6b6b7b;--line:#e4e4ee;--acc:#6c4cf5;--ok:#1a9b5a;--warn:#b26a00}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#111118;--card:#1a1a24;--fg:#ececf4;--mut:#9a9aae;--line:#2c2c3a;--acc:#9a82ff;--ok:#3ccf86;--warn:#f0a63a}}
:root[data-theme="dark"]{--bg:#111118;--card:#1a1a24;--fg:#ececf4;--mut:#9a9aae;--line:#2c2c3a;--acc:#9a82ff;--ok:#3ccf86;--warn:#f0a63a}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:980px;margin:0 auto;padding:28px 16px 64px}h1{font-size:28px;margin:0 0 6px}.mut{color:var(--mut);font-size:14px}a{color:var(--acc)}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px;margin:14px 0}.wrap{overflow-x:auto}
table{width:100%;border-collapse:collapse}td,th{padding:8px 6px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top;font-size:14px}
th{color:var(--mut);font-weight:600}.num{text-align:right;white-space:nowrap}.big{font-size:26px;font-weight:700;color:var(--ok)}
code,pre{font-family:ui-monospace,Consolas,monospace;font-size:13px}pre{white-space:pre-wrap;word-break:break-word;background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:12px}
button{padding:9px 14px;border-radius:9px;border:0;background:var(--acc);color:#fff;font:inherit;font-weight:600;cursor:pointer}ul{padding-left:20px}`;

const shell = (title: string, desc: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><meta name="description" content="${esc(desc)}">
<style>${STYLE}</style></head><body><main>${body}</main></body></html>`;

export function boardPage(recs: Rec[]): string {
  const ab = recs.filter((r) => r.verdict === "abandoned").sort((a, b) => (b.weeklyFeeLamports + b.vaultLamports + b.unsweptLamports) - (a.weeklyFeeLamports + a.vaultLamports + a.unsweptLamports));
  const rows = ab.map((r) => `<tr><td><a href="/royalties/${r.mint}"><b>$${esc(r.symbol)}</b></a><br><span class="mut">${esc(r.name)}</span></td>
<td class="num">${sol(r.vaultLamports + r.unsweptLamports)} SOL</td><td class="num">~${sol(r.weeklyFeeLamports)} SOL</td>
<td class="num">$${Math.round(r.volume24h).toLocaleString("en-US")}</td><td>${r.lastSignedDays != null ? `${r.lastSignedDays.toFixed(0)}d since creator signed` : "creator inactive"}</td></tr>`).join("");
  const checked = recs.length, shared = recs.filter((r) => r.verdict === "shared").length;
  return shell("Abandoned Creator Fees", "pump.fun coins whose creator left while the community keeps trading: on-chain evidence packs for pump.fun CTO creator-fee applications.", `
<h1>🏴 Abandoned creator fees</h1>
<p>pump.fun coins where the creator appears to have walked away, but a community still trades the coin and <b>creator fees keep flowing to the absent creator</b>. pump.fun lets communities that run such a coin <a href="${CTO_POST}" rel="nofollow">apply to receive those fees</a>. Each coin below has a free, factual evidence pack for that application.</p>
<p class="mut">Automated readings of public on-chain and market data, refreshed continuously. "Abandoned" is an inference from the facts shown, not an accusation. ${checked} coins checked recently · ${shared} already use pump.fun fee sharing.</p>
<div class="card wrap"><table><thead><tr><th>Coin</th><th class="num">Fees waiting</th><th class="num">Est. per week</th><th class="num">24h volume</th><th>Creator</th></tr></thead>
<tbody>${rows || '<tr><td colspan="5">Nothing qualifies right now. The scanner checks new coins every 15 minutes.</td></tr>'}</tbody></table></div>
<p class="mut">Fees already waiting usually stay with the original creator; a successful application redirects <b>future</b> fees. Also: <a href="/lostfound">Lost &amp; Found</a> (creators: claim your own fees) · <a href="https://t.me/Rug1CheckSolBot">rug checks</a> · <a href="https://github.com/Ahhyeah1/earner">open source</a></p>`);
}

export function evidence(r: Rec): string {
  const date = r.analyzedAt.slice(0, 16).replace("T", " ") + " UTC";
  return [
    `Community takeover: creator-fee application for $${r.symbol}${r.name ? ` (${r.name})` : ""}`,
    `Mint: ${r.mint}`,
    "",
    `On-chain evidence (as of ${date}; verify any line on solscan.io):`,
    ...r.reasons.map((x, i) => `${i + 1}. ${x}`),
    `${r.reasons.length + 1}. Creator wallet: ${r.creator}`,
    "",
    "The community keeps this coin alive while its creator fees accrue to a wallet that no longer takes part.",
    "We ask that the coin's creator fees be redirected to the community wallet(s) listed below.",
    "",
    "Community wallet(s) and share(s): <fill in>",
    "Community links: " + (r.socials.map((s) => s.url).join(", ") || "<fill in>"),
  ].join("\n");
}

export function evidencePage(r: Rec): string {
  const waiting = r.vaultLamports + r.unsweptLamports;
  const facts = [
    ["Coin", `<a href="https://solscan.io/token/${r.mint}" rel="nofollow"><code>${r.mint}</code></a>`],
    ["Creator wallet", `<a href="https://solscan.io/account/${r.creator}" rel="nofollow"><code>${r.creator}</code></a>`],
    ["Stage", r.graduated ? `Graduated to PumpSwap${r.pool ? ` (<a href="https://dexscreener.com/solana/${r.pool}" rel="nofollow">pool</a>)` : ""}` : "Bonding curve"],
    ["Creator fee rate", r.creatorFeeBps ? `${(r.creatorFeeBps / 100).toFixed(2)}% of volume` : `standard (estimate uses ${((r.graduated ? DEFAULT_POOL_BPS : DEFAULT_CURVE_BPS) / 100).toFixed(2)}%)`],
    ["Fees waiting", `${sol(waiting)} SOL (vaults ${sol(r.vaultLamports)} + not yet swept ${sol(r.unsweptLamports)})`],
    ["Community links", r.socials.map((s) => `<a href="${esc(s.url)}" rel="nofollow">${esc(s.type)}</a>`).join(" · ") || "none listed"],
    ["Checked", esc(r.analyzedAt.slice(0, 16).replace("T", " ")) + " UTC"],
  ].map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join("");
  return shell(`$${r.symbol} creator fees`, `Evidence pack: is the creator of $${r.symbol} gone while creator fees keep accruing?`, `
<p class="mut"><a href="/royalties">← all coins</a></p>
<h1>$${esc(r.symbol)} <span class="mut">${esc(r.name)}</span></h1>
<p>${r.verdict === "abandoned" ? "The facts below suggest the creator has walked away while fees keep accruing." : r.verdict === "shared" ? "This coin already uses pump.fun fee sharing." : "The creator still looks active or the fees are small, so this coin is not listed as abandoned."}</p>
<div class="card"><div class="mut">Creator fees waiting</div><div class="big">${sol(waiting)} SOL</div><div class="mut">≈ ${sol(r.weeklyFeeLamports)} SOL per week at today's volume ($${Math.round(r.volume24h).toLocaleString("en-US")} / 24h)</div></div>
<div class="card"><h2 style="margin-top:0;font-size:18px">Findings</h2><ul>${r.reasons.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
<table>${facts}</table></div>
<div class="card"><h2 style="margin-top:0;font-size:18px">Application draft</h2>
<p class="mut">For the people actually running this coin. Applications go through pump.fun's official CTO form (<a href="${CTO_POST}" rel="nofollow">announcement</a>); pump.fun only emails from cto@pump.fun and decides on its own. Fill in your wallets and links, and add anything that shows your community runs the coin.</p>
<pre id="ev">${esc(evidence(r))}</pre><button onclick="navigator.clipboard.writeText(document.getElementById('ev').innerText).then(()=>{this.textContent='Copied'})">Copy</button></div>
<div class="card"><h2 style="margin-top:0;font-size:18px">If this helped</h2>
<p>This evidence pack is free. If your application succeeds, you can include the agent that found it in your fee split (pump.fun allows up to 10 wallets), for example 5%:</p>
<p><code>${AGENT_WALLET}</code></p><p class="mut">Entirely voluntary. The agent is an open-source experiment in earning its own running costs: <a href="https://github.com/Ahhyeah1/earner">github.com/Ahhyeah1/earner</a>.</p></div>`);
}

// ---------------------------------------------------------------- unclaimed creator fees leaderboard
export function feeStats(recs: Rec[], now = Date.now()) {
  const day = recs.filter((r) => now - Date.parse(r.analyzedAt) < 86_400_000 && r.verdict !== "shared" && r.verdict !== "skip");
  const waiting = day.reduce((s, r) => s + r.vaultLamports + r.unsweptLamports, 0);
  return { coins: day.length, waitingLamports: waiting, over1Sol: day.filter((r) => r.vaultLamports + r.unsweptLamports >= 1e9).length,
           shared: recs.filter((r) => r.verdict === "shared").length };
}

export function feesPage(recs: Rec[], now = Date.now()): string {
  const st = feeStats(recs, now);
  const top = recs.filter((r) => r.verdict !== "shared" && r.verdict !== "skip" && r.vaultLamports + r.unsweptLamports >= 1e8)
    .sort((a, b) => (b.vaultLamports + b.unsweptLamports) - (a.vaultLamports + a.unsweptLamports)).slice(0, 60);
  const rows = top.map((r) => `<tr><td><b>$${esc(r.symbol)}</b><br><span class="mut">${esc(r.name)}</span></td>
<td class="num"><b>${sol(r.vaultLamports + r.unsweptLamports, 2)} SOL</b></td>
<td><a href="https://solscan.io/account/${r.creator}" rel="nofollow"><code>${r.creator.slice(0, 4)}…${r.creator.slice(-4)}</code></a></td>
<td class="num"><a href="/lostfound?wallet=${r.creator}&amp;coins=${r.mint}">Is this yours? Claim →</a></td></tr>`).join("");
  return shell("Unclaimed Creator Fees", "Live: how much SOL pump.fun creators have left unclaimed, coin by coin. Creators can claim in one tap.", `
<h1>💸 Unclaimed pump.fun creator fees</h1>
<p>Every trade on a pump.fun coin pays its creator a fee. Many creators never collect it. Live from the chain:</p>
<div class="card"><div class="big">${sol(st.waitingLamports, 1)} SOL</div>
<div class="mut">waiting unclaimed across the ${st.coins} actively traded coins checked in the last 24 hours · ${st.over1Sol} coins with more than 1 SOL each</div></div>
<div class="card wrap"><table><thead><tr><th>Coin</th><th class="num">Waiting</th><th>Creator</th><th></th></tr></thead>
<tbody>${rows || '<tr><td colspan="4">Collecting data, check back shortly.</td></tr>'}</tbody></table></div>
<p class="mut">Creators: <a href="/lostfound">Lost &amp; Found</a> sweeps the fees still sitting in your coins and claims everything to your own wallet in one transaction (fee: 10% of the first 10 SOL, 3% above). You can also claim on pump.fun yourself. Figures include fees not yet swept from the bonding curve; PumpSwap pool fees are added at claim time. Automated public on-chain data.</p>
<p class="mut">Also: <a href="/royalties">abandoned coins</a> · <a href="https://t.me/Rug1CheckSolBot">rug checks</a> · <a href="https://github.com/Ahhyeah1/earner">open source</a></p>`);
}
