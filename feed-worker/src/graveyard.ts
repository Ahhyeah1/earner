// Rug Graveyard: find a wallet's EMPTY token accounts (dead/rugged/sold tokens) and build ONE transaction the
// owner signs that closes them, returning the rent deposit (~0.002 SOL each) to the owner, minus a 10% fee.
//
// Safety by construction: the transaction contains ONLY
//   - token-program CloseAccount instructions for accounts whose balance is exactly 0, destination = the owner,
//   - one System transfer of the fee (10% of the reclaimed rent) to our fee wallet.
// No burns, no approvals, no token transfers. The owner's wallet simulates it before signing.
// Serialized by hand (legacy message) so we add no Solana SDK to the worker bundle.

export const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN22 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const SYSTEM = "11111111111111111111111111111111";
// Read-only marker on every fee transfer, so our books can find all Graveyard payments with
// getSignaturesForAddress (Solana Pay "reference" trick). A random key nobody owns.
export const REFERENCE = "G6UU9Hjv2XaQcHuDbMyfgNFGgc3aaettcRhgJrpkbCfm";
export const FEE_BPS = 1000, MAX_PER_TX = 20, TX_LIMIT = 1232, NETWORK_FEE = 5000;
// A system account must hold at least this much to exist; a smaller payment into an empty fee wallet fails the tx.
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
export type Closable = { address: string; program: string; mint: string; lamports: number };
export type Scan = { owner: string; closable: Closable[]; withBalance: number; skipped: number; lamports: number };

async function rpc(url: string, method: string, params: unknown[]) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j: any = await r.json();
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
    closable.push({ address: a.pubkey, program, mint: info.mint, lamports: Number(a.account.lamports) });
  }
  return { closable, withBalance, skipped };
}

export async function scan(owner: string, url: string): Promise<Scan> {
  const out: Scan = { owner, closable: [], withBalance: 0, skipped: 0, lamports: 0 };
  for (const program of [TOKEN, TOKEN22]) {
    const res = await rpc(url, "getTokenAccountsByOwner", [owner, { programId: program }, { encoding: "jsonParsed", commitment: "confirmed" }]);
    const c = classify(owner, res?.value || [], program);
    out.closable.push(...c.closable); out.withBalance += c.withBalance; out.skipped += c.skipped;
  }
  out.closable.sort((a, b) => b.lamports - a.lamports);
  out.lamports = out.closable.reduce((s, c) => s + c.lamports, 0);
  return out;
}

export const fee = (lamports: number) => Math.floor((lamports * FEE_BPS) / 10_000);
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

export type Built = { tx: Uint8Array; closed: Closable[]; reclaimed: number; fee: number };

/** Unsigned legacy transaction: close up to MAX_PER_TX accounts, then pay the fee. Fee payer & signer = owner. */
/** feeWalletLamports: current fee-wallet balance; if the fee alone couldn't make it rent-exempt, the fee is skipped
 *  (the user's reclaim must never fail because of our fee). */
export function build(owner: string, accounts: Closable[], feeWallet: string, blockhash: string, feeWalletLamports: number, max = MAX_PER_TX): Built {
  let take = accounts.slice(0, max);
  for (;;) {
    const built = assemble(owner, take, feeWallet, blockhash, feeWalletLamports);
    if (built.tx.length <= TX_LIMIT || take.length <= 1) return built;
    take = take.slice(0, -1);
  }
}

function assemble(owner: string, closed: Closable[], feeWallet: string, blockhash: string, feeWalletLamports: number): Built {
  if (!closed.length) throw new Error("nothing to close");
  const reclaimed = closed.reduce((s, c) => s + c.lamports, 0);
  const due = fee(reclaimed);
  const f = owner === feeWallet || due === 0 || feeWalletLamports + due < RENT_EXEMPT_MIN ? 0 : due;
  // Account order for a legacy message: writable signers, writable non-signers, read-only non-signers.
  const programs = [...new Set(closed.map((c) => c.program))];
  const keys = [owner, ...closed.map((c) => c.address), ...(f ? [feeWallet] : []), ...programs, ...(f ? [SYSTEM, REFERENCE] : [])];
  const idx = (k: string) => keys.indexOf(k);
  const ro = programs.length + (f ? 2 : 0);
  const ixs: number[][] = closed.map((c) => [idx(c.program), ...compact(3), idx(c.address), 0, 0, ...compact(1), 9]);   // CloseAccount(9): account, destination=owner, authority=owner
  if (f) ixs.push([idx(SYSTEM), ...compact(3), 0, idx(feeWallet), idx(REFERENCE), ...compact(12), 2, 0, 0, 0, ...u64le(f)]);   // Transfer(2)
  const msg = [1, 0, ro, ...compact(keys.length), ...keys.flatMap((k) => [...pubkey(k)]), ...pubkey(blockhash),
               ...compact(ixs.length), ...ixs.flat()];
  const tx = Uint8Array.from([...compact(1), ...new Uint8Array(64), ...msg]);
  return { tx, closed, reclaimed, fee: f };
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
    type: "action", icon: `${base}/graveyard/icon.svg`, title: "Rug Graveyard: reclaim your locked SOL",
    description: "Every token you ever held left an empty account holding ~0.002 SOL rent. Close the empty ones and get that SOL back "
      + "in one transaction. Only accounts with a zero balance are touched; nothing is burned or transferred. Fee: 10% of what you reclaim.",
    label: "Reclaim my SOL",
    links: { actions: [{ type: "transaction", label: "Reclaim my SOL", href: `${base}/graveyard/action` }] },
  };
}

export function report(s: Scan, actionLink: string): { text: string; button?: { text: string; url: string } } {
  if (!s.closable.length) {
    return { text: `🪦 <b>Rug Graveyard</b> · <code>${s.owner}</code>\n\nNo empty token accounts to close. Clean wallet! 🧹`
      + (s.withBalance ? `\n(${s.withBalance} token account(s) still hold a balance.)` : "") };
  }
  const first = s.closable.slice(0, MAX_PER_TX), firstRent = first.reduce((a, c) => a + c.lamports, 0);
  const batches = Math.ceil(s.closable.length / MAX_PER_TX);
  return {
    text: [`🪦 <b>Rug Graveyard</b> · <code>${s.owner}</code>`, "",
      `Found <b>${s.closable.length}</b> empty token accounts (dead, rugged or sold tokens).`,
      `💰 Locked rent: <b>${sol(s.lamports)} SOL</b> · you get back <b>${sol(s.lamports - fee(s.lamports))} SOL</b> (10% fee).`,
      batches > 1 ? `One tap closes up to ${MAX_PER_TX} (${sol(firstRent - fee(firstRent))} SOL); tap again for the rest (${batches} rounds).` : null,
      "", "Only zero-balance accounts are closed: nothing is burned or sent anywhere except the rent back to you and the fee. Your wallet shows the exact result before you sign.",
      s.withBalance ? `\n(${s.withBalance} account(s) still hold tokens and are left alone.)` : null].filter((l) => l !== null).join("\n"),
    button: { text: `⚰️ Reclaim ${sol(s.lamports - fee(s.lamports), 3)} SOL`, url: actionLink },
  };
}
