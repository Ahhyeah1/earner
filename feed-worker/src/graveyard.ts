// Rug Graveyard: find a wallet's EMPTY token accounts (dead/rugged/sold tokens) and build ONE transaction the
// owner signs that closes them, returning the rent deposit (~0.002 SOL each) to the owner, minus a 10% fee.
//
// Safety by construction: the transaction contains ONLY
//   - token-program CloseAccount instructions for accounts whose balance is exactly 0, destination = the owner,
//   - one System transfer of the fee (10% of the reclaimed rent) to our fee wallet.
// No burns, no approvals, no token transfers. (Lost & Found adds closing leftover program buffers and claiming
// pump.fun creator fees: same rule, every lamport goes to the owner except the capped fee.) The owner's wallet simulates it before signing.
import { address, getAddressEncoder, getProgramDerivedAddress } from "@solana/addresses";

// Serialized by hand (legacy message) so we add no Solana SDK to the worker bundle.

export const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN22 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const SYSTEM = "11111111111111111111111111111111";
// Read-only marker on every fee transfer, so our books can find all Graveyard payments with
// getSignaturesForAddress (Solana Pay "reference" trick). A random key nobody owns.
export const REFERENCE = "G6UU9Hjv2XaQcHuDbMyfgNFGgc3aaettcRhgJrpkbCfm";
export const FEE_BPS = 1000, MAX_PER_TX = 20, TX_LIMIT = 1232, NETWORK_FEE = 5000;
// A system account must hold at least this much to exist; a smaller payment into an empty fee wallet fails the tx.
// (Conservative: the live minimum has been lower since Solana's rent cut; fetched per scan where exactness matters.)
export const RENT_EXEMPT_MIN = 890_880;

// Token-2022 account extensions that don't block closing an empty account.
const SAFE_EXT = new Set(["immutableOwner", "transferFeeAmount", "nonTransferableAccount", "transferHookAccount", "cpiGuard", "memoTransfer", "pausableAccount"]);

// ---------------------------------------------------------------- base58
const ALPHA = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function b58decode(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) { const i = ALPHA.indexOf(c); if (i < 0) throw new Error("bad base58"); n = n * 58n + BigInt(i); }
  const out: number[] = [];
  while (n > 0n) { out.unshift(Number(n & 255n)); n >>= 8n; }
  for (const c of s) { if (c !== "1") break; out.unshift(0); }
  return Uint8Array.from(out);
}
export function b58encode(b: Uint8Array): string {
  let n = 0n;
  for (const x of b) n = (n << 8n) + BigInt(x);
  let s = "";
  while (n > 0n) { s = ALPHA[Number(n % 58n)] + s; n /= 58n; }
  for (const x of b) { if (x !== 0) break; s = "1" + s; }
  return s;
}
export function pubkey(s: string): Uint8Array {
  const k = b58decode(s);
  if (k.length !== 32) throw new Error(`not a 32-byte address: ${s}`);
  return k;
}
export const isAddress = (s: unknown): s is string => { try { return typeof s === "string" && pubkey(s).length === 32; } catch { return false; } };

// ---------------------------------------------------------------- scan
// Three kinds of forgotten SOL a wallet can reclaim by itself:
//   token   - empty token accounts (rent deposit, ~0.002 SOL each)
//   buffer  - leftover program-deploy buffers the wallet is authority of (often 1-10 SOL each)
//   creator - unclaimed pump.fun creator fees in the creator's bonding-curve vault (native SOL)
//   swap    - unclaimed PumpSwap creator fees for graduated tokens (wrapped SOL in the creator vault's token account;
//             claimed into the owner's WSOL account, which is then closed to unwrap it to plain SOL)
export type Kind = "token" | "buffer" | "creator" | "swap";
export type Closable = { kind: Kind; address: string; program: string; mint?: string; lamports: number;
                         authority?: string; dest?: string };        // swap: vault authority PDA, owner's WSOL ATA
export type Scan = { owner: string; closable: Closable[]; withBalance: number; skipped: number; lamports: number; byKind: Record<Kind, [number, number]>;
                     ownerLamports: number; rentMin: number; signable: boolean };

export const LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
export const PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const COLLECT_CREATOR_FEE = [20, 22, 86, 123, 198, 28, 219, 132];        // sha256("global:collect_creator_fee")[0..8]
export const PSWAP = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
export const WSOL = "So11111111111111111111111111111111111111112";
export const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const COLLECT_COIN_CREATOR_FEE = [160, 57, 89, 42, 181, 139, 43, 66];     // sha256("global:collect_coin_creator_fee")[0..8]

async function rpc(url: string, method: string, params: unknown[]) {
  let r: Response | undefined;
  for (let i = 0; i < 3; i++) {             // the free RPC tier rate-limits bursts: brief back-off, then retry
    r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    if (r.status !== 429) break;
    await new Promise((res) => setTimeout(res, 700 * (i + 1)));
  }
  const j: any = await r!.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

/** Pure: which of these parsed token accounts can the owner close right now. */
export function classify(owner: string, accounts: any[], program: string) {
  const closable: Closable[] = []; let withBalance = 0, skipped = 0;
  for (const a of accounts) {
    const info = a.account?.data?.parsed?.info;
    if (!info) { skipped++; continue; }
    if (info.tokenAmount?.amount !== "0") { withBalance++; continue; }
    const exts: any[] = info.extensions || [];
    const blocked = info.isNative || info.state !== "initialized" || info.owner !== owner
      || (info.closeAuthority && info.closeAuthority !== owner)
      || exts.some((e) => !SAFE_EXT.has(e.extension) || (e.extension === "transferFeeAmount" && Number(e.state?.withheldAmount || 0) > 0));
    if (blocked) { skipped++; continue; }
    closable.push({ kind: "token", address: a.pubkey, program, mint: info.mint, lamports: Number(a.account.lamports) });
  }
  return { closable, withBalance, skipped };
}

const enc = new TextEncoder();
export async function creatorVault(owner: string) {
  return (await getProgramDerivedAddress({ programAddress: address(PUMP), seeds: [enc.encode("creator-vault"), getAddressEncoder().encode(address(owner))] }))[0] as string;
}
const pda = async (program: string, seeds: (string | Uint8Array)[]) => (await getProgramDerivedAddress({ programAddress: address(program),
  seeds: seeds.map((s) => typeof s === "string" ? getAddressEncoder().encode(address(s)) : s) }))[0] as string;
export const ata = (owner: string, mint: string, tokenProgram = TOKEN) => pda(ATA_PROGRAM, [owner, tokenProgram, mint]);

export type Ctx = { pumpEv?: string; swapEv?: string };
let ctxCache: Required<Ctx> | undefined;
/** Event-authority PDAs of the pump and PumpSwap programs (constant; computed once). */
export async function programCtx(): Promise<Required<Ctx>> {
  return ctxCache ??= { pumpEv: await pda(PUMP, [enc.encode("__event_authority")]), swapEv: await pda(PSWAP, [enc.encode("__event_authority")]) };
}
export const pumpEventAuthority = async () => (await programCtx()).pumpEv;

export async function scan(owner: string, url: string): Promise<Scan> {
  const [ownerAcct, rentMin] = await Promise.all([
    rpc(url, "getAccountInfo", [owner, { encoding: "base64", dataSlice: { offset: 0, length: 0 }, commitment: "confirmed" }]).then((r) => r.value),
    rpc(url, "getMinimumBalanceForRentExemption", [0]).then(Number).catch(() => RENT_EXEMPT_MIN)]);
  const out: Scan = { owner, closable: [], withBalance: 0, skipped: 0, lamports: 0, byKind: { token: [0, 0], buffer: [0, 0], creator: [0, 0], swap: [0, 0] },
    ownerLamports: Number(ownerAcct?.lamports || 0), rentMin,
    // Only a plain system account (a normal wallet) can pay network fees; multisig vaults / program accounts can't.
    signable: !ownerAcct || ownerAcct.owner === SYSTEM };
  for (const program of [TOKEN, TOKEN22]) {
    const res = await rpc(url, "getTokenAccountsByOwner", [owner, { programId: program }, { encoding: "jsonParsed", commitment: "confirmed" }]);
    const c = classify(owner, res?.value || [], program);
    out.closable.push(...c.closable); out.withBalance += c.withBalance; out.skipped += c.skipped;
  }
  // Buffers: tag 1 (Buffer) + Some(authority = owner). Best effort: some RPCs refuse program scans.
  try {
    const bufs = await rpc(url, "getProgramAccounts", [LOADER, { encoding: "base64", dataSlice: { offset: 0, length: 0 }, commitment: "confirmed",
      filters: [{ memcmp: { offset: 0, bytes: "2UzHM" } }, { memcmp: { offset: 4, bytes: "2" } }, { memcmp: { offset: 5, bytes: owner } }] }]);
    for (const b of bufs || []) out.closable.push({ kind: "buffer", address: b.pubkey, program: LOADER, lamports: Number(b.account.lamports) });
  } catch { /* skip buffers */ }
  try {
    const vault = await creatorVault(owner);
    const bal = (await rpc(url, "getBalance", [vault, { commitment: "confirmed" }])).value;
    const claimable = bal - rentMin;                         // the program leaves the vault its live rent-exempt minimum
    if (claimable > 10_000) out.closable.push({ kind: "creator", address: vault, program: PUMP, lamports: claimable });
  } catch { /* skip creator fees */ }
  try {             // PumpSwap (graduated tokens): WSOL sits in the ATA of the vault authority PDA ["creator_vault", owner]
    const authority = await pda(PSWAP, [enc.encode("creator_vault"), owner]);
    const vaultAta = await ata(authority, WSOL);
    const amt = Number((await rpc(url, "getTokenAccountBalance", [vaultAta, { commitment: "confirmed" }]))?.value?.amount || 0);
    if (amt > 10_000) out.closable.push({ kind: "swap", address: vaultAta, program: PSWAP, lamports: amt, authority, dest: await ata(owner, WSOL) });
  } catch { /* no PumpSwap vault */ }
  out.closable.sort((a, b) => b.lamports - a.lamports);
  for (const c of out.closable) { out.byKind[c.kind][0]++; out.byKind[c.kind][1] += c.lamports; }
  out.lamports = out.closable.reduce((s, c) => s + c.lamports, 0);
  return out;
}

export const FEE_CAP = 1_000_000_000;                          // never more than 1 SOL fee per transaction
export const fee = (lamports: number) => Math.min(FEE_CAP, Math.floor((lamports * FEE_BPS) / 10_000));
export const sol = (lamports: number, dp = 4) => (lamports / 1e9).toFixed(dp);

// ---------------------------------------------------------------- transaction
function compact(n: number): number[] {
  const out: number[] = [];
  for (;;) { let b = n & 0x7f; n >>= 7; if (n) { out.push(b | 0x80); } else { out.push(b); return out; } }
}
function u64le(n: number): number[] {
  const out: number[] = []; let v = BigInt(n);
  for (let i = 0; i < 8; i++) { out.push(Number(v & 255n)); v >>= 8n; }
  return out;
}

type Meta = { addr: string; signer?: boolean; writable?: boolean };
export type Ix = { program: string; keys: Meta[]; data: number[] };

/** The instruction(s) that reclaim an item. Everything lands in the owner's wallet. */
export function reclaimIxs(owner: string, c: Closable, ctx: Ctx = {}): Ix[] {
  const me = { addr: owner, signer: true, writable: true };
  if (c.kind === "token") return [{ program: c.program, keys: [{ addr: c.address, writable: true }, me, me], data: [9] }];          // CloseAccount
  if (c.kind === "buffer") return [{ program: LOADER, keys: [{ addr: c.address, writable: true }, me, me], data: [5, 0, 0, 0] }];  // Close (buffer: no program account)
  if (c.kind === "creator") {
    if (!ctx.pumpEv) throw new Error("event authority needed");
    return [{ program: PUMP, data: COLLECT_CREATOR_FEE, keys: [me, { addr: c.address, writable: true }, { addr: SYSTEM },
      { addr: ctx.pumpEv }, { addr: PUMP }] }];                                                                             // collect_creator_fee
  }
  if (!ctx.swapEv || !c.authority || !c.dest) throw new Error("swap context needed");
  const wsolAta = { addr: c.dest, writable: true };
  return [
    { program: ATA_PROGRAM, data: [1], keys: [me, wsolAta, { addr: owner }, { addr: WSOL }, { addr: SYSTEM }, { addr: TOKEN }] },  // CreateIdempotent
    { program: PSWAP, data: COLLECT_COIN_CREATOR_FEE, keys: [{ addr: WSOL }, { addr: TOKEN }, me, { addr: c.authority },
      { addr: c.address, writable: true }, wsolAta, { addr: ctx.swapEv }, { addr: PSWAP }] },                               // collect_coin_creator_fee
    { program: TOKEN, data: [9], keys: [wsolAta, me, me] },                                                                 // unwrap: close WSOL account
  ];
}

/** Legacy message compiler: fee payer first, then writable signers, readonly signers, writable, readonly. */
export function compile(payer: string, ixs: Ix[], blockhash: string): Uint8Array {
  const flags = new Map<string, { s: boolean; w: boolean }>([[payer, { s: true, w: true }]]);
  const touch = (m: Meta) => { const f = flags.get(m.addr) || { s: false, w: false }; f.s ||= !!m.signer; f.w ||= !!m.writable; flags.set(m.addr, f); };
  for (const ix of ixs) { ix.keys.forEach(touch); touch({ addr: ix.program }); }
  const all = [...flags.entries()];
  const cls = (s: boolean, w: boolean) => all.filter(([, f]) => f.s === s && f.w === w).map(([k]) => k);
  const keys = [...cls(true, true), ...cls(true, false), ...cls(false, true), ...cls(false, false)];
  const header = [cls(true, true).length + cls(true, false).length, cls(true, false).length, cls(false, false).length];
  if (header[0] !== 1) throw new Error("only the owner may sign");
  const idx = (k: string) => keys.indexOf(k);
  const body = ixs.flatMap((ix) => [idx(ix.program), ...compact(ix.keys.length), ...ix.keys.map((k) => idx(k.addr)), ...compact(ix.data.length), ...ix.data]);
  const msg = [...header, ...compact(keys.length), ...keys.flatMap((k) => [...pubkey(k)]), ...pubkey(blockhash), ...compact(ixs.length), ...body];
  return Uint8Array.from([...compact(1), ...new Uint8Array(64), ...msg]);
}

export type Built = { tx: Uint8Array; closed: Closable[]; reclaimed: number; fee: number };

/** Unsigned transaction: reclaim up to MAX_PER_TX items (biggest first), then pay the fee. Fee payer & signer = owner.
 *  feeWalletLamports: current fee-wallet balance; if the fee couldn't make an empty fee wallet rent-exempt, it is
 *  skipped (the user's reclaim must never fail because of our fee). */
export function build(owner: string, items: Closable[], feeWallet: string, blockhash: string, feeWalletLamports: number,
                      ctx: Ctx = {}, max = MAX_PER_TX): Built {
  let take = items.slice(0, max);
  for (;;) {
    const built = assemble(owner, take, feeWallet, blockhash, feeWalletLamports, ctx);
    if (built.tx.length <= TX_LIMIT || take.length <= 1) return built;
    take = take.slice(0, -1);
  }
}

function assemble(owner: string, closed: Closable[], feeWallet: string, blockhash: string, feeWalletLamports: number, ctx: Ctx): Built {
  if (!closed.length) throw new Error("nothing to close");
  const reclaimed = closed.reduce((s, c) => s + c.lamports, 0);
  const due = fee(reclaimed);
  const f = owner === feeWallet || due === 0 || feeWalletLamports + due < RENT_EXEMPT_MIN ? 0 : due;
  const ixs = closed.flatMap((c) => reclaimIxs(owner, c, ctx));
  if (f) ixs.push({ program: SYSTEM, data: [2, 0, 0, 0, ...u64le(f)],                                                    // Transfer
    keys: [{ addr: owner, signer: true, writable: true }, { addr: feeWallet, writable: true }, { addr: REFERENCE }] });
  return { tx: compile(owner, ixs, blockhash), closed, reclaimed, fee: f };
}

export async function latestBlockhash(url: string): Promise<string> {
  return (await rpc(url, "getLatestBlockhash", [{ commitment: "confirmed" }])).value.blockhash;
}

export async function balance(url: string, address: string): Promise<number> {
  return (await rpc(url, "getBalance", [address, { commitment: "confirmed" }])).value;
}

export const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));

// ---------------------------------------------------------------- Solana Action (Blink) + Telegram text
const ACTION_HEADERS = {
  "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,PUT,OPTIONS",
  "access-control-allow-headers": "Content-Type, Authorization, Content-Encoding, Accept-Encoding",
  "access-control-expose-headers": "X-Action-Version, X-Blockchain-Ids",
  "x-action-version": "2.4", "x-blockchain-ids": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "content-type": "application/json",
};
export const actionJson = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: ACTION_HEADERS });
export const actionOptions = () => new Response(null, { headers: ACTION_HEADERS });

export const dialLink = (base: string) => `https://dial.to/?action=${encodeURIComponent(`solana-action:${base}/graveyard/action`)}`;

export function actionMeta(base: string) {
  return {
    type: "action", icon: `${base}/graveyard/icon.svg`, title: "Lost & Found: reclaim your forgotten SOL",
    description: "Wallets forget SOL: empty token accounts from dead tokens (~0.002 SOL each), leftover program-deploy buffers "
      + "(often 1-10 SOL) and unclaimed pump.fun creator fees. Connect, and get it all back to your own wallet in one transaction. "
      + "Nothing is burned and no tokens move. Fee: 10% of what you reclaim, max 1 SOL per transaction.",
    label: "Reclaim my SOL",
    links: { actions: [{ type: "transaction", label: "Reclaim my SOL", href: `${base}/graveyard/action` }] },
  };
}

/** Total fee if every batch is reclaimed (fee and cap apply per transaction). */
export function totalFee(items: Closable[]): number {
  let t = 0;
  for (let i = 0; i < items.length; i += MAX_PER_TX) t += fee(items.slice(i, i + MAX_PER_TX).reduce((s, c) => s + c.lamports, 0));
  return t;
}

const KIND_LINE: Record<Kind, (n: number, l: number) => string> = {
  creator: (n, l) => `💸 Unclaimed pump.fun creator fees: <b>${sol(l)} SOL</b>`,
  swap: (n, l) => `💸 Unclaimed PumpSwap creator fees (graduated tokens): <b>${sol(l)} SOL</b>`,
  buffer: (n, l) => `🧱 ${n} leftover program-deploy buffer(s): <b>${sol(l)} SOL</b>`,
  token: (n, l) => `🪦 ${n} empty token account(s) (dead, rugged or sold tokens): <b>${sol(l)} SOL</b>`,
};

/** The owner pays the network fee before anything is reclaimed, and must stay rent-exempt while doing so. */
export const canPayFee = (s: Scan) => s.signable && s.ownerLamports >= s.rentMin + 2 * NETWORK_FEE;

export function report(s: Scan, actionLink: string): { text: string; button?: { text: string; url: string } } {
  if (!s.closable.length) {
    return { text: `🔍 <b>Lost &amp; Found</b> · <code>${s.owner}</code>\n\nNothing forgotten here: no empty token accounts, program buffers or unclaimed creator fees. Clean wallet! 🧹`
      + (s.withBalance ? `\n(${s.withBalance} token account(s) still hold a balance.)` : "") };
  }
  const total = s.lamports, back = total - totalFee(s.closable), batches = Math.ceil(s.closable.length / MAX_PER_TX);
  const lines = (["swap", "creator", "buffer", "token"] as Kind[]).filter((k) => s.byKind[k][0]).map((k) => KIND_LINE[k](...s.byKind[k]));
  return {
    text: [`🔍 <b>Lost &amp; Found</b> · <code>${s.owner}</code>`, "", ...lines, "",
      `💰 Total: <b>${sol(total)} SOL</b> · you get back <b>${sol(back)} SOL</b> (10% fee, max 1 SOL per transaction).`,
      !s.signable ? "⚠️ This address is a program or multisig account, not a normal wallet: reclaim it from the multisig app (e.g. Squads) instead."
        : canPayFee(s) ? null : `⚠️ This wallet holds almost no SOL. Send it about ${sol(s.rentMin + 2 * NETWORK_FEE - s.ownerLamports + 100_000, 4)} SOL first so it can pay the network fee.`,
      batches > 1 ? `Biggest items first, up to ${MAX_PER_TX} per tap; tap again for the rest (${batches} rounds).` : null,
      "", "Everything goes back to your own wallet except the fee. Nothing is burned, no tokens move, and your wallet shows the exact result before you sign.",
      s.withBalance ? `\n(${s.withBalance} token account(s) still hold tokens and are left alone.)` : null].filter((l) => l !== null).join("\n"),
    button: { text: `💰 Reclaim ${sol(back, 3)} SOL`, url: actionLink },
  };
}
