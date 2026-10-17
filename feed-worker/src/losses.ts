// Rug Loss Harvester: from a wallet's swap history (Helius parsed transactions) work out, per token, what was paid
// and received in SOL, then which positions were closed at a loss and which tokens are dead (held but ~worthless).
// Output is a DATA report for the user's own tax prep: not tax advice (rules differ by country).
//
// Trade detection is deliberately simple and robust: in one transaction, the wallet's net SOL (native + wrapped)
// moves one way and exactly one other token moves the other way. Anything else (token-for-token routes, transfers,
// airdrops) is counted but not priced, and the report says so.

export const WSOL = "So11111111111111111111111111111111111111112";
export type Trade = [ts: number, lamports: number, qty: number];        // lamports & qty always positive
export type Pos = { mint: string; buys: Trade[]; sells: Trade[]; symbol?: string };
export type LossState = { wallet: string; positions: Record<string, Pos>; swaps: number; skipped: number; pages: number;
                          before?: string; oldest?: number; done: boolean };
export const MAX_TRADES_PER_SIDE = 400;

export const newState = (wallet: string): LossState => ({ wallet, positions: {}, swaps: 0, skipped: 0, pages: 0, done: false });

/** Fold one Helius parsed transaction into the state. Returns "trade" | "skip" | "ignore". */
export function applyTx(s: LossState, tx: any): "trade" | "skip" | "ignore" {
  if (tx?.transactionError) return "ignore";
  const w = s.wallet;
  const native = (tx.accountData || []).find((a: any) => a.account === w)?.nativeBalanceChange ?? 0;
  let sol = Number(native) + (tx.feePayer === w ? Number(tx.fee || 0) : 0);     // network fees aren't part of the price
  const qty: Record<string, number> = {};
  for (const t of tx.tokenTransfers || []) {
    const amt = Number(t.tokenAmount || 0);
    if (!amt) continue;
    const sign = t.toUserAccount === w ? 1 : t.fromUserAccount === w ? -1 : 0;
    if (!sign) continue;
    if (t.mint === WSOL) sol += sign * Math.round(amt * 1e9);
    else qty[t.mint] = (qty[t.mint] || 0) + sign * amt;
  }
  const moved = Object.entries(qty).filter(([, q]) => Math.abs(q) > 0);
  if (!moved.length) return "ignore";
  if (moved.length !== 1 || !sol || Math.sign(sol) === Math.sign(moved[0][1])) { if (tx.type === "SWAP") s.skipped++; return "skip"; }
  const [mint, q] = moved[0];
  const p = (s.positions[mint] ||= { mint, buys: [], sells: [] });
  const side = q > 0 ? p.buys : p.sells;
  if (side.length < MAX_TRADES_PER_SIDE) side.push([Number(tx.timestamp), Math.abs(sol), Math.abs(q)]);
  s.swaps++;
  return "trade";
}

export type PriceDay = Record<string, number>;      // "YYYY-MM-DD" -> SOL/USD close
const dayKey = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);
export function usdAt(prices: PriceDay, ts: number): number {
  const d = dayKey(ts);
  if (prices[d]) return prices[d];
  const keys = Object.keys(prices).sort();                    // nearest earlier day, else the latest known
  for (let i = keys.length - 1; i >= 0; i--) if (keys[i] <= d) return prices[keys[i]];
  return prices[keys[keys.length - 1]] || 0;
}

export type Row = {
  mint: string; symbol: string; status: "realized-loss" | "realized-gain" | "dead" | "open";
  boughtQty: number; soldQty: number; heldQty: number; costSol: number; proceedsSol: number; costUsd: number; proceedsUsd: number;
  basisSoldUsd: number; realizedUsd: number; heldCostUsd: number; heldValueUsd: number; unrealizedUsd: number;
  firstBuy: number | null; lastSell: number | null; trades: number;
};

/** Average-cost accounting per token. holdings: current qty; valueUsd: current USD value per token (0/undefined = no market). */
export function summarize(s: LossState, prices: PriceDay, holdings: Record<string, number>, valueUsd: Record<string, number | undefined>,
                          deadValueFraction = 0.02): Row[] {
  const rows: Row[] = [];
  for (const p of Object.values(s.positions)) {
    const buyQ = p.buys.reduce((a, t) => a + t[2], 0), sellQ = p.sells.reduce((a, t) => a + t[2], 0);
    if (!buyQ) continue;                                     // sells of tokens bought before the history window: no basis
    const cost = p.buys.reduce((a, t) => a + t[1], 0), proceeds = p.sells.reduce((a, t) => a + t[1], 0);
    const costUsd = p.buys.reduce((a, t) => a + t[1] / 1e9 * usdAt(prices, t[0]), 0);
    const proceedsUsd = p.sells.reduce((a, t) => a + t[1] / 1e9 * usdAt(prices, t[0]), 0);
    const avgUsd = costUsd / buyQ;
    const soldQ = Math.min(sellQ, buyQ);
    const basisSoldUsd = avgUsd * soldQ;
    const realizedUsd = sellQ ? proceedsUsd * (soldQ / sellQ) - basisSoldUsd : 0;
    const held = holdings[p.mint] ?? Math.max(0, buyQ - sellQ);
    const heldCostUsd = avgUsd * Math.min(held, Math.max(0, buyQ - soldQ));
    const heldValueUsd = (valueUsd[p.mint] || 0) * held;
    const dead = held > 0 && heldCostUsd > 0 && heldValueUsd <= heldCostUsd * deadValueFraction;
    const status: Row["status"] = dead ? "dead" : held > 0 && heldCostUsd > 0 ? "open" : realizedUsd < 0 ? "realized-loss" : "realized-gain";
    rows.push({ mint: p.mint, symbol: p.symbol || "", status, boughtQty: buyQ, soldQty: sellQ, heldQty: held, costSol: cost / 1e9,
      proceedsSol: proceeds / 1e9, costUsd, proceedsUsd, basisSoldUsd, realizedUsd, heldCostUsd, heldValueUsd,
      unrealizedUsd: heldValueUsd - heldCostUsd, firstBuy: p.buys[0]?.[0] ?? null, lastSell: p.sells.length ? Math.max(...p.sells.map((t) => t[0])) : null,
      trades: p.buys.length + p.sells.length });
  }
  return rows.sort((a, b) => (a.realizedUsd + (a.status === "dead" ? a.unrealizedUsd : 0)) - (b.realizedUsd + (b.status === "dead" ? b.unrealizedUsd : 0)));
}

export function totals(rows: Row[], year?: number) {
  const inYear = (r: Row) => !year || (r.lastSell != null && new Date(r.lastSell * 1000).getUTCFullYear() === year);
  const realized = rows.filter((r) => r.soldQty > 0 && inYear(r));
  return {
    tokens: rows.length,
    realizedLossUsd: realized.filter((r) => r.realizedUsd < 0).reduce((a, r) => a + r.realizedUsd, 0),
    realizedGainUsd: realized.filter((r) => r.realizedUsd > 0).reduce((a, r) => a + r.realizedUsd, 0),
    deadCount: rows.filter((r) => r.status === "dead").length,
    deadLossUsd: rows.filter((r) => r.status === "dead").reduce((a, r) => a + r.unrealizedUsd, 0),
  };
}

const iso = (ts: number | null) => (ts ? new Date(ts * 1000).toISOString().slice(0, 10) : "");
const f = (n: number, dp = 2) => (Number.isFinite(n) ? n.toFixed(dp) : "");
const cell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
export function csv(rows: Row[]): string {
  const head = ["token", "mint", "status", "first_buy", "last_sell", "bought_qty", "sold_qty", "held_qty", "cost_sol", "proceeds_sol",
    "cost_usd", "proceeds_usd", "cost_basis_of_sold_usd", "realized_pnl_usd", "held_cost_basis_usd", "held_value_usd", "unrealized_pnl_usd", "trades"];
  return [head.join(","), ...rows.map((r) => [r.symbol, r.mint, r.status, iso(r.firstBuy), iso(r.lastSell), f(r.boughtQty, 6), f(r.soldQty, 6),
    f(r.heldQty, 6), f(r.costSol, 6), f(r.proceedsSol, 6), f(r.costUsd), f(r.proceedsUsd), f(r.basisSoldUsd), f(r.realizedUsd),
    f(r.heldCostUsd), f(r.heldValueUsd), f(r.unrealizedUsd), String(r.trades)].map((v) => cell(String(v))).join(","))].join("\n");
}
