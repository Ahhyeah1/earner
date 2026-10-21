// Event study: do our on-chain signals predict price moves? Every signal is logged with the coin's price at
// detection, then re-priced at +1h, +24h and +72h. A control group (coins whose creator still holds) is logged
// the same way, so a signal only counts if its coins do worse than the control over the same period.
// One KV key. Signals are logged instantly WITHOUT a price (no outbound requests, so the scanner's request budget
// isn't touched); a separate cron prices them within minutes (that moment becomes t0) and re-prices due events
// in DexScreener batches of 30.

export type Signal = "dev_sold_out" | "dev_holds" | "abandoned" | "risk_high" | "risk_critical" | "watch_alert";
export const HORIZONS_H = [1, 24, 72];
const KEY = "es:state", MAX_PENDING = 1500, MAX_DONE = 4000, DEDUPE_MS = 24 * 3_600_000;

export type Ev = { mint: string; sig: Signal; t: number; p0: number | null; liq0: number;
                   r: (number | null)[];   // return at each horizon (-1 = coin gone/no market); null = not yet
                   extra?: Record<string, number> };
type State = { pending: Ev[]; done: Ev[] };

const load = async (kv: KVNamespace): Promise<State> => (await kv.get<State>(KEY, "json")) ?? { pending: [], done: [] };

type Px = { price: number; liq: number };
export async function prices(mints: string[]): Promise<Record<string, Px>> {
  const out: Record<string, Px> = {};
  for (let i = 0; i < mints.length; i += 30) {
    const pairs: any = await (await fetch(`https://api.dexscreener.com/tokens/v1/solana/${mints.slice(i, i + 30).join(",")}`)).json().catch(() => []);
    for (const p of Array.isArray(pairs) ? pairs : []) {
      const m = p.baseToken?.address, liq = Number(p.liquidity?.usd || 0);
      if (m && (!out[m] || liq > out[m].liq)) out[m] = { price: Number(p.priceUsd || 0), liq };   // deepest pool wins
    }
  }
  return out;
}

/** Log signals. With `price` the event starts now; otherwise followUp() prices it on its next run.
 *  Same coin+signal is logged at most once a day. No outbound requests. */
export async function log(kv: KVNamespace, items: { mint: string; sig: Signal; extra?: Record<string, number>; price?: Px }[], now = Date.now()) {
  if (!items.length) return 0;
  const s = await load(kv);
  const recent = new Set(s.pending.filter((e) => now - e.t < DEDUPE_MS).map((e) => `${e.mint}:${e.sig}`));
  const fresh = items.filter((i) => !recent.has(`${i.mint}:${i.sig}`));
  if (!fresh.length) return 0;
  for (const i of fresh) {
    if (i.price && !i.price.price) continue;
    s.pending.push({ mint: i.mint, sig: i.sig, t: now, p0: i.price ? i.price.price : null, liq0: i.price ? Math.round(i.price.liq) : 0,
                     r: HORIZONS_H.map(() => null), extra: i.extra });
  }
  s.pending = s.pending.slice(-MAX_PENDING);
  await kv.put(KEY, JSON.stringify(s));
  return fresh.length;
}

/** Cron: price every event whose next horizon is due; finished events move to `done`. */
export async function followUp(kv: KVNamespace, now = Date.now(), fetchPrices = prices) {
  const s = await load(kv);
  const unpriced = s.pending.filter((e) => e.p0 === null);
  const due = s.pending.filter((e) => e.p0 !== null && e.r.some((v, k) => v === null && now - e.t >= HORIZONS_H[k] * 3_600_000));
  if (!due.length && !unpriced.length) return { priced: 0, pending: s.pending.length, done: s.done.length };
  const px = await fetchPrices([...new Set([...unpriced, ...due].map((e) => e.mint))].slice(0, 300));
  for (const e of unpriced) {                              // first price: the measurement starts now
    const p = px[e.mint];
    if (p && p.price && p.liq >= 100) { e.p0 = p.price; e.liq0 = Math.round(p.liq); e.t = now; }
    else e.r = HORIZONS_H.map(() => -2);                   // no market at detection: dropped below
  }
  s.pending = s.pending.filter((e) => e.r[0] !== -2);
  for (const e of due) {
    const p = px[e.mint];
    e.r = e.r.map((v, k) => v !== null || now - e.t < HORIZONS_H[k] * 3_600_000 ? v
      : !p || !p.price || p.liq < 100 ? -1 : +(p.price / (e.p0 as number) - 1).toFixed(4));
  }
  const finished = s.pending.filter((e) => e.r.every((v) => v !== null));
  s.pending = s.pending.filter((e) => e.r.some((v) => v === null));
  s.done = [...s.done, ...finished].slice(-MAX_DONE);
  await kv.put(KEY, JSON.stringify(s));
  return { priced: due.length + unpriced.length, pending: s.pending.length, done: s.done.length };
}

const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

/** Per signal and horizon: n, median return, share down >=50% (incl. gone), share gone. */
export function summary(evs: Ev[]) {
  const sigs = [...new Set(evs.map((e) => e.sig))];
  return Object.fromEntries(sigs.map((sig) => [sig, Object.fromEntries(HORIZONS_H.map((h, k) => {
    const rs = evs.filter((e) => e.sig === sig && e.r[k] !== null).map((e) => e.r[k] as number);
    return [`${h}h`, { n: rs.length, median: median(rs), down50: rs.length ? +(rs.filter((r) => r <= -0.5).length / rs.length).toFixed(3) : null,
                       gone: rs.length ? +(rs.filter((r) => r === -1).length / rs.length).toFixed(3) : null }];
  }))]));
}

export async function report(kv: KVNamespace) {
  const s = await load(kv);
  return { method: "Each signal logged with price at detection, re-priced at +1h/+24h/+72h (DexScreener deepest pool; -1 = no market). "
    + "dev_holds is the control group. A signal is meaningful only if it differs clearly from the control.",
    pending: s.pending.length, completed: s.done.length, results: summary([...s.done, ...s.pending]) };
}
