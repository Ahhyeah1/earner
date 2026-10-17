// Rug Loss Harvester service: a job per wallet, advanced one Helius page per request (the free Workers plan allows
// ~10 ms CPU per request, so the browser drives the loop), state in the edge cache, final rows in KV once.
// Free preview (totals + top losers); the full per-token CSV unlocks after payment (SOL via Solana Action, or Stars).
import * as L from "./losses";

export const PAGE = 25, MAX_PAGES = 80, MAX_SWAPS = 2000;          // ~2,000 most recent swaps per report
export const PRICE_USD = 19, PRICE_STARS = 750;
const cache = () => (caches as any).default as Cache;
const ck = (job: string) => new Request(`https://cache.local/losses/job/${job}`);
const kvRows = (job: string) => `loss:rows:${job}`, kvPaid = (job: string) => `loss:paid:${job}`;

async function load(job: string): Promise<L.LossState | null> { const r = await cache().match(ck(job)); return r ? r.json() : null; }
async function save(job: string, s: L.LossState) {
  await cache().put(ck(job), new Response(JSON.stringify(s), { headers: { "content-type": "application/json", "Cache-Control": "max-age=7200" } }));
}

export function newJobId(): string {
  const b = crypto.getRandomValues(new Uint8Array(12));
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export async function start(wallet: string): Promise<string> {
  const job = newJobId();
  await save(job, L.newState(wallet));
  return job;
}

/** One page of swaps. Cutoff: stop at the start of last calendar year (enough basis for this year's sales). */
export async function step(job: string, heliusKey: string, now = Date.now()) {
  const s = await load(job);
  if (!s) return { error: "job expired, start again" };
  if (!s.done) {
    const url = `https://api.helius.xyz/v0/addresses/${s.wallet}/transactions?api-key=${heliusKey}&type=SWAP&limit=${PAGE}${s.before ? `&before=${s.before}` : ""}`;
    const res = await fetch(url);
    if (res.status === 429) return { pages: s.pages, swaps: s.swaps, done: false, retry: true };
    const page: any[] = res.ok ? await res.json() : [];
    for (const tx of page) L.applyTx(s, tx);
    s.pages++;
    const cutoff = Date.UTC(new Date(now).getUTCFullYear() - 1, 0, 1) / 1000;
    if (page.length) { s.before = page[page.length - 1].signature; s.oldest = page[page.length - 1].timestamp; }
    s.done = !res.ok || page.length < PAGE || s.pages >= MAX_PAGES || s.swaps >= MAX_SWAPS || (s.oldest ?? now) < cutoff;
    await save(job, s);
  }
  return { pages: s.pages, swaps: s.swaps, tokens: Object.keys(s.positions).length, oldest: s.oldest ?? null, done: s.done,
           capped: s.swaps >= MAX_SWAPS || s.pages >= MAX_PAGES };
}

/** Daily SOL/USD closes. Kraken (720 days) first, Coinbase (300 days) as fallback; Binance refuses Cloudflare egress. */
export async function solPrices(): Promise<L.PriceDay> {
  const day = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 10);
  try {
    const j: any = await (await fetch("https://api.kraken.com/0/public/OHLC?pair=SOLUSD&interval=1440")).json();
    const rows: any[] = j?.result ? (Object.entries(j.result).find(([k]) => k !== "last")?.[1] as any[]) : [];
    if (rows?.length) return Object.fromEntries(rows.map((r) => [day(Number(r[0])), Number(r[4])]));
  } catch { /* fall back */ }
  try {
    const rows: any[] = await (await fetch("https://api.exchange.coinbase.com/products/SOL-USD/candles?granularity=86400",
      { headers: { "user-agent": "earner-feed" } })).json();
    if (Array.isArray(rows) && rows.length) return Object.fromEntries(rows.map((r) => [day(Number(r[0])), Number(r[4])]));
  } catch { /* none */ }
  return {};
}

/** Current SOL/USD (Kraken, then Coinbase). 0 when both fail. */
export async function solUsdNow(): Promise<number> {
  try { const j: any = await (await fetch("https://api.kraken.com/0/public/Ticker?pair=SOLUSD")).json();
        const v = Object.values(j?.result || {})[0] as any; if (v?.c?.[0]) return Number(v.c[0]); } catch { /* fall back */ }
  try { const j: any = await (await fetch("https://api.exchange.coinbase.com/products/SOL-USD/ticker", { headers: { "user-agent": "earner-feed" } })).json();
        if (j?.price) return Number(j.price); } catch { /* none */ }
  return 0;
}

async function rpc(url: string, method: string, params: unknown[]) {
  const r: any = await (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json();
  if (r.error) throw new Error(r.error.message);
  return r.result;
}

export type Report = { wallet: string; generatedAt: string; swaps: number; skipped: number; oldest: number | null; capped: boolean;
                       year: number; totals: ReturnType<typeof L.totals>; totalsYear: ReturnType<typeof L.totals>; rows: L.Row[] };

/** Price everything once the history is in, store the rows (one KV write) and return the report. */
export async function finish(job: string, kv: KVNamespace, rpcUrl: string, now = Date.now()): Promise<Report | { error: string }> {
  const stored = await kv.get<Report>(kvRows(job), "json");
  if (stored) return stored;
  const s = await load(job);
  if (!s) return { error: "job expired, start again" };
  if (!s.done) return { error: "not finished yet" };
  const holdings: Record<string, number> = {};
  for (const prog of ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"]) {
    const r = await rpc(rpcUrl, "getTokenAccountsByOwner", [s.wallet, { programId: prog }, { encoding: "jsonParsed" }]);
    for (const a of r.value) { const i = a.account.data.parsed.info; holdings[i.mint] = (holdings[i.mint] || 0) + Number(i.tokenAmount.uiAmountString || 0); }
  }
  const mints = Object.keys(s.positions), value: Record<string, number> = {};
  for (let i = 0; i < mints.length && i < 30 * 12; i += 30) {          // DexScreener: 30 tokens per call
    const pairs: any = await (await fetch(`https://api.dexscreener.com/tokens/v1/solana/${mints.slice(i, i + 30).join(",")}`)).json().catch(() => []);
    for (const p of Array.isArray(pairs) ? pairs : []) {
      const m = p.baseToken?.address;
      if (!m || !s.positions[m]) continue;
      s.positions[m].symbol ||= String(p.baseToken.symbol || "").slice(0, 20);
      if ((p.liquidity?.usd || 0) >= 500 && value[m] === undefined) value[m] = Number(p.priceUsd || 0);
    }
  }
  const prices = await solPrices();
  if (!Object.keys(prices).length) return { error: "SOL price history unavailable right now, try again in a minute." };   // never store a $0 report
  const rows = L.summarize(s, prices, holdings, value);
  const year = new Date(now).getUTCFullYear();
  const rep: Report = { wallet: s.wallet, generatedAt: new Date(now).toISOString(), swaps: s.swaps, skipped: s.skipped, oldest: s.oldest ?? null,
    capped: s.swaps >= MAX_SWAPS || s.pages >= MAX_PAGES, year, totals: L.totals(rows), totalsYear: L.totals(rows, year), rows };
  await kv.put(kvRows(job), JSON.stringify(rep), { expirationTtl: 60 * 86_400 });
  return rep;
}

/** What anyone sees before paying: totals and the three biggest losers. */
export function preview(r: Report) {
  const { rows, ...rest } = r;
  const pnl = (x: L.Row) => x.status === "dead" ? x.unrealizedUsd : x.realizedUsd;
  return { ...rest, top: rows.filter((x) => pnl(x) <= -1).sort((a, b) => pnl(a) - pnl(b)).slice(0, 3)
    .map((x) => ({ symbol: x.symbol || x.mint.slice(0, 6), status: x.status, pnlUsd: Math.round(pnl(x)) })),
    rowCount: rows.length, deadMints: rows.filter((x) => x.status === "dead").map((x) => x.mint) };
}

export const isPaid = async (kv: KVNamespace, job: string) => !!(await kv.get(kvPaid(job)));
export const markPaid = (kv: KVNamespace, job: string, how: string) => kv.put(kvPaid(job), JSON.stringify({ how, at: new Date().toISOString() }), { expirationTtl: 60 * 86_400 });
export const stored = (kv: KVNamespace, job: string) => kv.get<Report>(kvRows(job), "json");

/** Deterministic Solana Pay reference for a job: 32 bytes derived from the job id (read-only marker, nobody owns it). */
export async function reference(job: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`earner-loss-report:${job}`)));
}

/** CSV with a short provenance header (as comment lines tax tools skip or users can delete). */
export function csvWithHeader(r: Report): string {
  return [`# Profit & loss data for wallet ${r.wallet}, generated ${r.generatedAt} by earner (github.com/Ahhyeah1/earner)`,
    `# ${r.swaps} swaps analysed${r.oldest ? ` back to ${new Date(r.oldest * 1000).toISOString().slice(0, 10)}` : ""}${r.capped ? " (capped: older history not included)" : ""}; ${r.skipped} swaps without SOL on one side were not priced.`,
    "# Average-cost method; USD at the daily SOL/USD close. A data report, not tax advice: check your country's rules or a tax professional.",
    L.csv(r.rows)].join("\n");
}
