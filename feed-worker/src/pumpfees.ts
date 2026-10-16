// pump.fun creator-fee plumbing shared by Lost & Found and Royalty Hunter, built from pump.fun's published IDLs
// (github.com/pump-fun/pump-public-docs: idl/pump.json, idl/pump_amm.json, docs/instructions/SWEEP_FEES.md).
//
// Since the "fees kept on the curve" upgrade, creator fees from new trades stay on the bonding curve / PumpSwap
// pool until someone runs the permissionless sweep_creator_fee, which moves them into the creator's vault.
import { address, getAddressEncoder, getProgramDerivedAddress } from "@solana/addresses";

export const PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
export const PSWAP = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
export const PUMP_FEES = "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ";
export const PSWAP_GLOBAL_CONFIG = "ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw";
export const WSOL = "So11111111111111111111111111111111111111112";
export const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const SYSTEM = "11111111111111111111111111111111";
const SWEEP_CREATOR_FEE = [32, 246, 191, 52, 8, 201, 73, 186];          // same discriminator in both programs
const BC_DISC = [23, 183, 248, 55, 96, 216, 172, 96], POOL_DISC = [241, 154, 109, 4, 17, 177, 109, 188];

const enc = new TextEncoder();
export const pda = async (program: string, seeds: (string | Uint8Array)[]) => (await getProgramDerivedAddress({ programAddress: address(program),
  seeds: seeds.map((s) => typeof s === "string" ? getAddressEncoder().encode(address(s)) : s) }))[0] as string;
export const ata = (owner: string, mint: string, tokenProgram = TOKEN) => pda(ATA_PROGRAM, [owner, tokenProgram, mint]);
export const bondingCurve = (mint: string) => pda(PUMP, [enc.encode("bonding-curve"), mint]);
export const sharingConfig = (mint: string) => pda(PUMP_FEES, [enc.encode("sharing-config"), mint]);
export const pumpCreatorVault = (creator: string) => pda(PUMP, [enc.encode("creator-vault"), creator]);
export const swapVaultAuthority = (creator: string) => pda(PSWAP, [enc.encode("creator_vault"), creator]);

// ---------------------------------------------------------------- decoding (field offsets from the IDL type order)
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58(b: Uint8Array): string {
  let n = 0n; for (const x of b) n = (n << 8n) + BigInt(x);
  let s = ""; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const x of b) { if (x !== 0) break; s = "1" + s; }
  return s;
}
const u64 = (d: Uint8Array, o: number) => d.length >= o + 8 ? Number(new DataView(d.buffer, d.byteOffset + o, 8).getBigUint64(0, true)) : 0;
const key = (d: Uint8Array, o: number) => b58(d.subarray(o, o + 32));
const disc = (d: Uint8Array, want: number[]) => want.every((x, i) => d[i] === x);
export const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export type Curve = { creator: string; complete: boolean; quoteMint: string; creatorFeeBps: number; holderReward: boolean; creatorFee: number };
/** Pump BondingCurve: disc 8 | 5×u64 | complete@48 | creator@49 | mayhem@81 | cashback@82 | quote_mint@83 | creator_fee_bps@115 |
 *  can_edit@123 | is_holder_reward@124 | creator_fee@125. Pre-upgrade accounts are shorter: missing fields read as 0. */
export function decodeCurve(d: Uint8Array): Curve | null {
  if (d.length < 81 || !disc(d, BC_DISC)) return null;
  const q = d.length >= 115 ? key(d, 83) : WSOL;
  // Coins created before custom quote mints read the new field as all zeros (= SOL-paired).
  return { creator: key(d, 49), complete: d[48] === 1, quoteMint: q === SYSTEM ? WSOL : q,
           creatorFeeBps: u64(d, 115), holderReward: d.length > 124 && d[124] === 1, creatorFee: u64(d, 125) };
}

export type Pool = { coinCreator: string; baseMint: string; quoteMint: string; poolQuoteAccount: string; creatorFeeBps: number; holderReward: boolean; creatorFees: number };
/** PumpSwap Pool: disc 8 | bump@8 | index@9 | creator@11 | base_mint@43 | quote_mint@75 | lp_mint@107 | pool_base_ta@139 |
 *  pool_quote_ta@171 | lp_supply@203 | coin_creator@211 | mayhem@243 | cashback@244 | vqr i128@245 | creator_fee_bps@261 |
 *  can_edit@269 | is_holder_reward@270 | protocol_fees@271 | creator_fees@279. */
export function decodePool(d: Uint8Array): Pool | null {
  if (d.length < 243 || !disc(d, POOL_DISC)) return null;
  return { coinCreator: key(d, 211), baseMint: key(d, 43), quoteMint: key(d, 75), poolQuoteAccount: key(d, 171),
           creatorFeeBps: u64(d, 261), holderReward: d.length > 270 && d[270] === 1, creatorFees: u64(d, 279) };
}

// ---------------------------------------------------------------- creator fees waiting for a coin (read-only)
async function rpc(url: string, method: string, params: unknown[]) {
  const r: any = await (await fetch(url, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json();
  if (r.error) throw new Error(`${method}: ${r.error.message}`);
  return r.result;
}

export type CreatorFees = { creator: string; waiting: number; creatorLamports: number; shared: boolean };
/** What the coin's creator could claim right now (vaults + fees still on the curve). Null if not a pump.fun coin.
 *  (Unswept PumpSwap pool fees aren't included: that needs the pool address; Lost & Found adds them at claim time.) */
export async function creatorFees(url: string, mint: string): Promise<CreatorFees | null> {
  const ai = await rpc(url, "getAccountInfo", [await bondingCurve(mint), { encoding: "base64", commitment: "confirmed" }]);
  const curve = ai?.value && decodeCurve(fromB64(ai.value.data[0]));
  if (!curve || curve.quoteMint !== WSOL || curve.holderReward) return null;
  if (curve.creator === await sharingConfig(mint)) return { creator: curve.creator, waiting: 0, creatorLamports: 0, shared: true };
  const vaultAta = await ata(await swapVaultAuthority(curve.creator), WSOL);
  const [vault, swap, own] = await Promise.all([
    rpc(url, "getBalance", [await pumpCreatorVault(curve.creator), { commitment: "confirmed" }]).then((r) => Math.max(0, Number(r.value) - 650_240)),
    rpc(url, "getTokenAccountBalance", [vaultAta, { commitment: "confirmed" }]).then((r) => Number(r?.value?.amount || 0)).catch(() => 0),
    rpc(url, "getBalance", [curve.creator, { commitment: "confirmed" }]).then((r) => Number(r.value)),
  ]);
  return { creator: curve.creator, waiting: vault + swap + curve.creatorFee, creatorLamports: own, shared: false };
}

// ---------------------------------------------------------------- sweep instructions (permissionless; payer = owner)
type Meta = { addr: string; signer?: boolean; writable?: boolean };
export type Ix = { program: string; keys: Meta[]; data: number[] };

/** Pump: move unswept creator fees from the bonding curve into the creator vault. SOL-paired coins only. */
export async function sweepCurveIx(payer: string, mint: string, creator: string): Promise<Ix> {
  const curve = await bondingCurve(mint), vault = await pumpCreatorVault(creator);
  return { program: PUMP, data: SWEEP_CREATOR_FEE, keys: [
    { addr: payer, signer: true, writable: true }, { addr: await pda(PUMP, [enc.encode("global")]) }, { addr: mint }, { addr: WSOL },
    { addr: TOKEN }, { addr: ATA_PROGRAM }, { addr: SYSTEM }, { addr: curve, writable: true }, { addr: await ata(curve, WSOL), writable: true },
    { addr: vault, writable: true }, { addr: await ata(vault, WSOL), writable: true },
    { addr: await pda(PUMP, [enc.encode("__event_authority")]) }, { addr: PUMP }] };
}

/** PumpSwap: move unswept creator fees from the pool into the creator vault authority's WSOL account. */
export async function sweepPoolIx(payer: string, pool: string, p: Pool): Promise<Ix> {
  const recipient = await swapVaultAuthority(p.coinCreator);
  return { program: PSWAP, data: SWEEP_CREATOR_FEE, keys: [
    { addr: payer, signer: true, writable: true }, { addr: PSWAP_GLOBAL_CONFIG }, { addr: pool, writable: true }, { addr: p.quoteMint },
    { addr: TOKEN }, { addr: p.poolQuoteAccount, writable: true }, { addr: recipient }, { addr: await ata(recipient, p.quoteMint), writable: true },
    { addr: SYSTEM }, { addr: ATA_PROGRAM }, { addr: await pda(PSWAP, [enc.encode("__event_authority")]) }, { addr: PSWAP }] };
}
