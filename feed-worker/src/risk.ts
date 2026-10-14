// Solana token contract-risk assessment from public on-chain data only (no third-party APIs resold).
// What can the token's controllers do to holders? Mint more, freeze, seize, tax or block transfers,
// pause, change metadata - plus holder concentration when the RPC supports it.

export type Check = { id: string; ok: boolean; severity: "info" | "low" | "medium" | "high" | "critical"; points: number; detail: string };
export type Assessment = {
  mint: string; score: number; level: "low" | "medium" | "high" | "critical"; checks: Check[];
  facts: Record<string, unknown>; known?: string; generated_at: string; method: string; disclaimer: string;
  coverage: "contract+holders" | "contract-only"; note?: string;
};

const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const isMint = (s: string | null | undefined): s is string => !!s && MINT_RE.test(s);

// Issuer-controlled assets where authorities are expected and disclosed by the issuer.
export const KNOWN: Record<string, string> = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC (Circle) - issuer-controlled stablecoin",
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: "USDT (Tether) - issuer-controlled stablecoin",
  "2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH": "USDG (Paxos) - issuer-controlled stablecoin",
  "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo": "PYUSD (PayPal/Paxos) - issuer-controlled stablecoin",
  So11111111111111111111111111111111111111112: "Wrapped SOL - native asset wrapper",
};

const DISCLAIMER = "Contract-level checks from public Solana data. Does not assess liquidity locks, team behaviour or " +
  "price. A low score is not a guarantee and nothing here is financial advice.";

type Ext = { extension: string; state?: Record<string, any> };

export function assess(mint: string, info: any, program: string, largest: { amount: number }[] | null): Assessment {
  const checks: Check[] = [];
  const add = (id: string, bad: boolean, severity: Check["severity"], points: number, detail: string) =>
    checks.push({ id, ok: !bad, severity: bad ? severity : "info", points: bad ? points : 0, detail });
  const exts: Ext[] = info.extensions || [];
  const ext = (name: string) => exts.find((e) => e.extension === name);
  const t22 = program === "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

  add("mint_authority", !!info.mintAuthority, "critical", 35,
    info.mintAuthority ? `Someone (${info.mintAuthority}) can mint unlimited new tokens and dilute holders.` : "Mint authority revoked: supply is fixed.");
  add("freeze_authority", !!info.freezeAuthority, "high", 30,
    info.freezeAuthority ? `Someone (${info.freezeAuthority}) can freeze any holder's tokens (honeypot risk).` : "Freeze authority revoked.");
  if (t22) {
    const pd = ext("permanentDelegate")?.state?.delegate;
    add("permanent_delegate", !!pd, "critical", 40, pd ? `Permanent delegate ${pd} can move or burn tokens from ANY wallet.` : "No permanent delegate.");
    const hook = ext("transferHook")?.state?.programId;
    add("transfer_hook", !!hook, "high", 25, hook ? `Every transfer runs custom program ${hook}, which can block sells.` : "No transfer hook.");
    const fee = ext("transferFeeConfig")?.state;
    const bps = Math.max(Number(fee?.newerTransferFee?.transferFeeBasisPoints ?? 0), Number(fee?.olderTransferFee?.transferFeeBasisPoints ?? 0));
    add("transfer_fee", bps > 0, bps >= 500 ? "high" : "medium", bps >= 500 ? 30 : 10,
      bps > 0 ? `Transfer fee of ${(bps / 100).toFixed(2)}% on every transfer.` : "No transfer fee.");
    add("non_transferable", !!ext("nonTransferable"), "critical", 50,
      ext("nonTransferable") ? "Token is non-transferable: you cannot sell it." : "Transferable.");
    const das = ext("defaultAccountState")?.state?.accountState;
    add("default_frozen", das === "frozen", "critical", 40,
      das === "frozen" ? "New holder accounts start frozen: buyers may be unable to sell." : "New accounts start unfrozen.");
    const pause = ext("pausableConfig")?.state?.authority;
    add("pausable", !!pause, "high", 30, pause ? `Authority ${pause} can pause all transfers.` : "Not pausable.");
    const close = ext("mintCloseAuthority")?.state?.closeAuthority;
    add("mint_close_authority", !!close, "medium", 10, close ? "The mint account can be closed by its close authority." : "Mint cannot be closed.");
    const upd = ext("tokenMetadata")?.state?.updateAuthority;
    add("mutable_metadata", !!upd, "low", 5, upd ? "Name, symbol and image can still be changed." : "Metadata is immutable or absent.");
  }
  const supply = Number(info.supply) / 10 ** Number(info.decimals || 0);
  add("zero_supply", supply === 0, "medium", 10, supply === 0 ? "Total supply is zero." : `Supply ${supply.toLocaleString("en-US")}.`);
  let top1: number | null = null, top10: number | null = null;
  if (largest && largest.length && supply > 0) {
    top1 = (largest[0].amount / supply) * 100;
    top10 = (largest.slice(0, 10).reduce((s, a) => s + a.amount, 0) / supply) * 100;
    add("top_holder", top1 > 50, "medium", 20, `Largest account holds ${top1.toFixed(1)}% (may be a liquidity pool).`);
    add("top10_holders", top10 > 80, "high", 20, `Top 10 accounts hold ${top10.toFixed(1)}%.`);
  } else {
    checks.push({ id: "holder_concentration", ok: true, severity: "info", points: 0, detail: "Not checked (RPC without holder index)." });
  }
  const known = KNOWN[mint];
  let score = Math.min(100, checks.reduce((s, c) => s + c.points, 0));
  if (known) score = Math.min(score, 10);       // authorities on these are disclosed issuer controls
  let level: Assessment["level"] = score >= 60 ? "critical" : score >= 35 ? "high" : score >= 15 ? "medium" : "low";
  const coverage = top1 === null ? "contract-only" : "contract+holders";
  let note: string | undefined;
  if (coverage === "contract-only" && !known && level === "low") {
    // Clean contracts are the norm for launchpad meme coins; their risk is in holders/liquidity, which we didn't see.
    level = "medium";
    note = "Contract looks clean, but holder concentration was not checked - most meme-coin rugs come from a few "
      + "wallets dumping, not from contract settings. Treat as unverified.";
  }
  return {
    mint, score, level, checks, known, coverage, note,
    facts: { token_program: t22 ? "token-2022" : "spl-token", decimals: info.decimals, supply,
             mint_authority: info.mintAuthority ?? null, freeze_authority: info.freezeAuthority ?? null,
             extensions: exts.map((e) => e.extension), top1_pct: top1 && +top1.toFixed(2), top10_pct: top10 && +top10.toFixed(2) },
    generated_at: new Date().toISOString(), method: "on-chain", disclaimer: DISCLAIMER,
  };
}

async function rpc(url: string, method: string, params: unknown[]) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j: any = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message ?? JSON.stringify(j.error)}`);
  return j.result;
}

export class NotAMint extends Error {}

export async function assessMint(mint: string, rpcUrl: string): Promise<Assessment> {
  const acct = await rpc(rpcUrl, "getAccountInfo", [mint, { encoding: "jsonParsed" }]);
  const v = acct?.value;
  if (!v || v.data?.parsed?.type !== "mint") throw new NotAMint("not a token mint");
  let largest: { amount: number }[] | null = null;
  try {
    const decimals = Number(v.data.parsed.info.decimals || 0);
    let res;
    try { res = await rpc(rpcUrl, "getTokenLargestAccounts", [mint]); }
    catch { await new Promise((r) => setTimeout(r, 800)); res = await rpc(rpcUrl, "getTokenLargestAccounts", [mint]); }  // index can be briefly overloaded
    largest = (res?.value || []).map((a: any) => ({ amount: Number(a.amount) / 10 ** decimals }));
  } catch { largest = null; }                 // many free RPCs don't serve this; report "not checked"
  return assess(mint, v.data.parsed.info, v.owner, largest);
}
