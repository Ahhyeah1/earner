// Paid data for AI agents (x402, listed in the Bazaar): signals only our scanners produce.
//   /v1/creator-fees?mint=   creator's unclaimed fees + is the creator still around (dev-exit signal)
//   /v1/abandoned            coins whose creator left while trading continues, and the biggest unclaimed fee piles
//   /v1/wallet-pnl?wallet=   realized P&L of a wallet's most recent swaps (copy-trading sanity check)
import * as PF from "./pumpfees";
import * as L from "./losses";
import * as R from "./royalty";
import { solPrices } from "./lossreport";

async function rpc(url: string, method: string, params: unknown[]) {
  const r: any = await (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json();
  if (r.error) throw new Error(r.error.message);
  return r.result;
}

export async function creatorFees(rpcUrl: string, mint: string) {
  const cf = await PF.creatorFees(rpcUrl, mint);
  if (!cf) return null;
  const [holdings, sigs] = await Promise.all([
    cf.shared ? null : rpc(rpcUrl, "getTokenAccountsByOwner", [cf.creator, { mint }, { encoding: "jsonParsed" }]).then((r) => r.value as any[]).catch(() => null),
    cf.shared ? [] : rpc(rpcUrl, "getSignaturesForAddress", [cf.creator, { limit: 1 }]).catch(() => []) as Promise<any[]>,
  ]);
  return {
    mint, creator: cf.creator, fee_sharing: cf.shared,
    unclaimed_creator_fees_sol: +(cf.waiting / 1e9).toFixed(6),
    creator_wallet_sol: +(cf.creatorLamports / 1e9).toFixed(6),
    creator_holds_coin: holdings === null ? null : holdings.some((h) => Number(h.account.data.parsed.info.tokenAmount.amount) > 0),
    creator_last_activity: sigs[0]?.blockTime ? new Date(sigs[0].blockTime * 1000).toISOString() : null,
    note: "Unclaimed fees include fees still on the bonding curve; PumpSwap pool fees not yet swept are excluded. A creator that sold out with an idle, empty wallet is a dev-exit signal, not proof.",
    generated_at: new Date().toISOString(),
  };
}

export async function abandoned(kv: KVNamespace) {
  const recs = await R.board(kv);
  const pick = (r: R.Rec) => ({ mint: r.mint, symbol: r.symbol, name: r.name, creator: r.creator, verdict: r.verdict, graduated: r.graduated,
    fees_waiting_sol: +((r.vaultLamports + r.unsweptLamports) / 1e9).toFixed(4), est_fees_per_week_sol: +(r.weeklyFeeLamports / 1e9).toFixed(4),
    volume_24h_usd: Math.round(r.volume24h), liquidity_usd: Math.round(r.liquidityUsd), coin_age_days: r.ageDays != null ? +r.ageDays.toFixed(1) : null,
    creator_holds_coin: r.devHolds, creator_last_signed_days: r.lastSignedDays != null ? +r.lastSignedDays.toFixed(1) : null,
    reasons: r.reasons, analyzed_at: r.analyzedAt });
  const live = recs.filter((r) => r.verdict !== "shared" && r.verdict !== "skip");
  return {
    stats: R.feeStats(recs),
    abandoned: live.filter((r) => r.verdict === "abandoned").map(pick),
    largest_unclaimed: live.sort((a, b) => (b.vaultLamports + b.unsweptLamports) - (a.vaultLamports + a.unsweptLamports)).slice(0, 25).map(pick),
    note: "Continuously refreshed sample of actively traded pump.fun coins. 'abandoned' = sold out, no creator-signed tx for 14+ days, coin 14+ days old, still trading.",
    generated_at: new Date().toISOString(),
  };
}

export const PNL_SWAPS = 40;      // one Helius page: keeps the request inside the free CPU budget

export async function walletPnl(heliusKey: string, wallet: string) {
  const res = await fetch(`https://api.helius.xyz/v0/addresses/${wallet}/transactions?api-key=${heliusKey}&type=SWAP&limit=${PNL_SWAPS}`);
  if (!res.ok) throw new Error(`history ${res.status}`);
  const page: any[] = await res.json();
  const s = L.newState(wallet);
  for (const tx of page) L.applyTx(s, tx);
  const rows = L.summarize(s, await solPrices(), {}, {}).filter((r) => r.soldQty > 0);
  const closed = rows.filter((r) => r.soldQty >= r.boughtQty * 0.98);
  const wins = closed.filter((r) => r.realizedUsd > 0);
  return {
    wallet, swaps_analyzed: s.swaps, swaps_unpriced: s.skipped,
    window: page.length ? { from: new Date(page[page.length - 1].timestamp * 1000).toISOString(), to: new Date(page[0].timestamp * 1000).toISOString() } : null,
    realized_pnl_usd: Math.round(rows.reduce((a, r) => a + r.realizedUsd, 0)),
    realized_pnl_sol: +rows.reduce((a, r) => a + r.proceedsSol * Math.min(1, r.boughtQty / r.soldQty) - r.costSol * Math.min(1, r.soldQty / r.boughtQty), 0).toFixed(4),
    closed_positions: closed.length, win_rate: closed.length ? +(wins.length / closed.length).toFixed(3) : null,
    best: rows.length ? { mint: rows[rows.length - 1].mint, pnl_usd: Math.round(rows[rows.length - 1].realizedUsd) } : null,
    worst: rows.length ? { mint: rows[0].mint, pnl_usd: Math.round(rows[0].realizedUsd) } : null,
    note: `Most recent ${PNL_SWAPS} swaps only, SOL-quoted trades, average cost, USD at the daily SOL close. Positions bought before the window have no cost basis and are excluded.`,
    generated_at: new Date().toISOString(),
  };
}
