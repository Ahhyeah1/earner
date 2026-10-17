// Swap button (Solana Action) routed through Jupiter with a small integrator fee paid to our wrapped-SOL account.
// Sell is offered on every rug check (getting out of a risky token helps the user); buy only on low/medium risk.
// The fee is taken in SOL: from the input on buys, from the output on sells. If our fee account doesn't exist yet
// (it needs ~0.002 SOL rent to create), swaps still work but without a fee.
import * as PF from "./pumpfees";

export const FEE_BPS = 50;                         // 0.5%
export const BUY_SOL = [0.05, 0.1, 0.5];
export const SELL_PCT = [25, 50, 100];
const JUP = "https://lite-api.jup.ag/swap/v1";

async function rpc(url: string, method: string, params: unknown[]) {
  const r: any = await (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json();
  if (r.error) throw new Error(r.error.message);
  return r.result;
}

export async function feeAccount(rpcUrl: string, payTo: string): Promise<string | null> {
  const ata = await PF.ata(payTo, PF.WSOL);
  const ai = await rpc(rpcUrl, "getAccountInfo", [ata, { encoding: "base64", dataSlice: { offset: 0, length: 0 } }]).catch(() => null);
  return ai?.value ? ata : null;
}

export function meta(base: string, mint: string, symbol: string, canBuy: boolean) {
  const href = (side: string, v: number) => `${base}/swap/action?mint=${mint}&side=${side}&v=${v}`;
  const actions = [
    ...(canBuy ? BUY_SOL.map((v) => ({ type: "transaction", label: `Buy ${v} SOL`, href: href("buy", v) })) : []),
    ...SELL_PCT.map((v) => ({ type: "transaction", label: `Sell ${v}%`, href: href("sell", v) })),
  ];
  return { type: "action", icon: `${base}/graveyard/icon.svg`, title: `Trade $${symbol}`,
    description: `Swap via Jupiter's best route. ${FEE_BPS / 100}% fee supports the free rug-check bot. Memecoins are extremely risky; `
      + `only trade what you can afford to lose. Not financial advice.`, label: "Trade", links: { actions } };
}

export type Built = { transaction: string; message: string };

/** Quote + swap transaction for `account`. side=buy: v SOL -> token. side=sell: v% of the account's balance -> SOL. */
export async function build(rpcUrl: string, payTo: string, account: string, mint: string, side: "buy" | "sell", v: number): Promise<Built> {
  let input: string, output: string, amount: bigint;
  if (side === "buy") {
    if (!BUY_SOL.includes(v)) throw new Error("bad amount");
    input = PF.WSOL; output = mint; amount = BigInt(Math.round(v * 1e9));
  } else {
    if (!SELL_PCT.includes(v)) throw new Error("bad percent");
    const accts = await rpc(rpcUrl, "getTokenAccountsByOwner", [account, { mint }, { encoding: "jsonParsed" }]);
    const bal = (accts?.value || []).reduce((s: bigint, a: any) => s + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n);
    if (bal === 0n) throw new Error("You don't hold this token.");
    input = mint; output = PF.WSOL; amount = v === 100 ? bal : (bal * BigInt(v)) / 100n;
  }
  const fee = await feeAccount(rpcUrl, payTo);
  const q = await fetch(`${JUP}/quote?inputMint=${input}&outputMint=${output}&amount=${amount}&slippageBps=300`
    + (fee ? `&platformFeeBps=${FEE_BPS}` : ""));
  const quote: any = await q.json();
  if (!q.ok || !quote?.outAmount) throw new Error(quote?.error || "No route for this token right now.");
  const s = await fetch(`${JUP}/swap`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
    quoteResponse: quote, userPublicKey: account, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true,
    prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: 200_000, priorityLevel: "medium" } },
    ...(fee ? { feeAccount: fee } : {}) }) });
  const sw: any = await s.json();
  if (!s.ok || !sw?.swapTransaction) throw new Error(sw?.error || "Couldn't build the swap, try again.");
  const out = side === "buy" ? `${quote.outAmount} raw units of the token` : `~${(Number(quote.outAmount) / 1e9).toFixed(4)} SOL`;
  return { transaction: sw.swapTransaction, message: `Swap ${side === "buy" ? `${v} SOL` : `${v}% of your tokens`} for ${out} (max 3% slippage)`
    + (fee ? `, ${FEE_BPS / 100}% fee.` : ".") };
}
