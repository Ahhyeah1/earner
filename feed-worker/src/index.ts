// earner feed: the agent's ranked list of paid work open to AI agents, sold per call via x402.
//
// Free:  GET /            what this is, pricing, how to pay
//        GET /health
//        GET /v1/sample   top 3, titles and links only
// Paid:  GET /v1/opportunities   full ranked feed (USDC on Base, or on Solana when configured)
//
// The worker never holds a key: it only names the receiving address(es). PayAI's facilitator
// verifies the buyer's signed payment and settles it on-chain.
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { createFacilitatorConfig } from "@payai/facilitator";
import { createPaywall } from "@x402/paywall";
import { bazaarResourceServerExtension, declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { assessMint, isMint, KNOWN, NotAMint } from "./risk";
import { intake, landing } from "./grants";
import { handleUpdate, tg, check } from "./telegram";
import * as E from "./events";
import { handle as mcp } from "./mcp";
import * as G from "./graveyard";
import { PAGE as LOSTFOUND_PAGE } from "./lostfound_page";
import * as R from "./royalty";
import * as LR from "./lossreport";
import * as AD from "./agentdata";
import * as SW from "./swap";
import { PAGE as LOSSES_PAGE } from "./losses_page";
import { run as runWatches } from "./watch";
import { svmPaywall } from "@x402/paywall/svm";

export type Bindings = {
  FEED: KVNamespace;
  PAY_TO_EVM: `0x${string}`;
  PAY_TO_SOLANA?: string;            // optional: a receive-only Solana address
  PRICE_USD: string;                 // e.g. "0.01"
  EVM_NETWORK: `${string}:${string}`;     // "eip155:8453" (Base mainnet)
  SOLANA_NETWORK: `${string}:${string}`;  // "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" (mainnet)
  PAYAI_API_KEY_ID?: string;
  PAYAI_API_KEY_SECRET?: string;
  SOLANA_RPC?: string;               // optional secret: an RPC with a holder index (e.g. Helius) enables concentration checks
  RISK_PRICE_USD?: string;           // default "0.002"
  TG_BOT_TOKEN?: string;             // secret: Telegram bot token from @BotFather
  TG_SECRET?: string;                // secret: verifies that webhook calls really come from Telegram
  NTFY_TOPIC?: string;               // secret: owner's ntfy topic for sale notifications
  TG_CHANNEL?: string;               // optional: "@channel" the bot (as admin) posts the daily rug radar to
  GRAVEYARD_OFF?: string;            // "1" pauses Graveyard transactions (kill switch)
  INTERNAL_KEY?: string;             // secret: lets our own Apify Actor call the risk check (Apify bills its users)
};

export type Opportunity = {
  source: string; title: string; url: string; reward_usd: number | null; reward_token: string | null;
  deadline: string | null; competition: number | null; agent_allowed: boolean; track: string;
  score: number; reasons: string[];
};
export type Feed = { generated_at: string; count: number; opportunities: Opportunity[] };

const SAMPLE_SIZE = 3;

export async function readFeed(kv: KVNamespace): Promise<Feed | null> {
  return (await kv.get<Feed>("feed", "json")) ?? null;
}

export function sample(feed: Feed): object {
  return {
    generated_at: feed.generated_at,
    total_available: feed.count,
    sample: feed.opportunities.slice(0, SAMPLE_SIZE).map((o) => ({ source: o.source, title: o.title, url: o.url })),
    full_feed: "GET /v1/opportunities (x402: pay per call in USDC)",
  };
}

export function paymentOptions(env: Bindings, priceUsd: string = env.PRICE_USD) {
  const price = `$${priceUsd}`;
  const opts: { scheme: "exact"; price: string; network: `${string}:${string}`; payTo: string }[] = [
    { scheme: "exact", price, network: env.EVM_NETWORK, payTo: env.PAY_TO_EVM },
  ];
  if (env.PAY_TO_SOLANA) opts.push({ scheme: "exact", price, network: env.SOLANA_NETWORK, payTo: env.PAY_TO_SOLANA });
  return opts;
}

const app = new Hono<{ Bindings: Bindings }>();

app.get("/", (c) =>
  c.json({
    name: "earner feed",
    what: "Ranked paid work that AI agents are allowed to do (bounties, agent marketplaces, bug bounties), "
      + "refreshed every 2 hours by an autonomous agent. Each item links to the original listing.",
    paid: { endpoint: "GET /v1/opportunities", price_usd: c.env.PRICE_USD, protocol: "x402",
            accepts: paymentOptions(c.env).map((o) => o.network) },
    free: ["GET /v1/sample", "GET /health"],
    agent_data: { "GET /v1/creator-fees?mint=": "$0.005", "GET /v1/abandoned": "$0.02", "GET /v1/wallet-pnl?wallet=": "$0.01" },
    token_risk: { endpoint: "GET /v1/token-risk?mint=<solana mint>", price_usd: c.env.RISK_PRICE_USD || "0.002",
                  what: "Contract-level rug/honeypot checks from public on-chain data, score 0-100 with reasons" },
    mcp: { endpoint: "POST /mcp", tool: "check_solana_token", note: "Streamable HTTP MCP server, free with a daily limit" },
    rug_radar: ["GET /rugs", "GET /rugs.json"],
    telegram_bot: "https://t.me/Rug1CheckSolBot",
    fields: ["source", "title", "url", "reward_usd", "reward_token", "deadline", "competition",
             "agent_allowed", "track", "score", "reasons"],
    note: "Scores are the agent's own estimate of expected payout per competitor. Not advice; check each listing's rules.",
  }));

// Telegram rug-check bot webhook (Telegram -> us). Answer fast, work in the background.
app.post("/tg/hook", async (c) => {
  if (!c.env.TG_BOT_TOKEN || !c.env.TG_SECRET || c.req.header("X-Telegram-Bot-Api-Secret-Token") !== c.env.TG_SECRET) {
    return c.text("forbidden", 403);
  }
  const update = await c.req.json().catch(() => null);
  if (update) c.executionCtx.waitUntil(handleUpdate(update, c.env).catch(() => {}));
  return c.text("ok");
});

// MCP server: the rug check as a tool for AI assistants/agents (free, per-IP daily limit).
app.options("/mcp", () => new Response(null, { headers: { "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, GET, OPTIONS", "access-control-allow-headers": "content-type, mcp-protocol-version, mcp-session-id" } }));
app.all("/mcp", (c) => mcp(c.req.raw, { ip: c.req.header("cf-connecting-ip") || "?", check: (m) => check(c.env, m),
  reclaim: (wallet, coins) => reclaimTx(c.env, wallet, coins) }));

// Rug radar: public log of flagged tokens (last 7 days).
app.get("/rugs", async (c) => {
  const res = c.html(E.page(await E.recent(c.env.FEED, 24 * 7), "Rug1CheckSolBot"));
  res.headers.set("Cache-Control", "public, max-age=300");
  return res;
});
app.get("/rugs.json", async (c) => c.json({ window_hours: 168, note: "Automated contract-level flags; not accusations or financial advice.",
  events: await E.recent(c.env.FEED, 24 * 7) }, 200, { "Cache-Control": "public, max-age=300", "access-control-allow-origin": "*" }));

// Our Apify Actor's backend: same check, authenticated by a shared secret instead of x402.
app.get("/internal/token-risk", async (c) => {
  if (!c.env.INTERNAL_KEY || c.req.header("x-internal-key") !== c.env.INTERNAL_KEY) return c.json({ error: "forbidden" }, 403);
  const mint = c.req.query("mint");
  if (!isMint(mint)) return c.json({ error: "invalid mint" }, 400);
  try { return c.json(await check(c.env, mint!)); }
  catch (e: any) { return e instanceof NotAMint ? c.json({ error: "not a token mint" }, 404) : c.json({ error: "chain data unavailable" }, 503); }
});

// Lost & Found (ex Rug Graveyard) as a Solana Action (Blink): GET = card, POST {account} = unsigned reclaim tx.
const BASE = "https://earner-feed.earner-feed.workers.dev";
app.get("/actions.json", () => G.actionJson({ rules: [{ pathPattern: "/graveyard/**", apiPath: "/graveyard/**" }] }));
app.options("/actions.json", () => G.actionOptions());
app.options("/graveyard/action", () => G.actionOptions());
app.get("/graveyard/action", () => G.actionJson(G.actionMeta(BASE)));
/** Shared by the Blink and the MCP tool: an unsigned reclaim transaction for `account`, or why not. */
export async function reclaimTx(env: Bindings, account: string, coins: string[]): Promise<{ status: number; message: string; transaction?: string; scan?: G.Scan }> {
  if (env.GRAVEYARD_OFF === "1" || !env.PAY_TO_SOLANA) return { status: 503, message: "Lost & Found is paused, try again later." };
  if (!G.isAddress(account)) return { status: 400, message: "Connect a Solana wallet first." };
  const rpc = env.SOLANA_RPC || "https://api.mainnet-beta.solana.com";
  try {
    const s = await G.scan(account, rpc, await G.coinRefs(coins));
    if (!s.closable.length) return { status: 422, message: "Nothing to reclaim in this wallet. Clean! 🧹", scan: s };
    if (!s.signable) return { status: 422, message: "This address is a program or multisig account, not a normal wallet. Reclaim from your multisig app instead.", scan: s };
    if (!G.canPayFee(s)) return { status: 422, message: "This wallet needs about 0.001 SOL to pay the network fee. Top it up, then try again.", scan: s };
    const [hash, feeBal] = await Promise.all([G.latestBlockhash(rpc), G.balance(rpc, env.PAY_TO_SOLANA)]);
    const b = G.build(account, s.closable, env.PAY_TO_SOLANA, hash, feeBal, await G.programCtx());
    const left = s.closable.length - b.closed.length;
    return { status: 200, transaction: G.b64(b.tx), scan: s,
      message: `Reclaiming ${b.closed.length} item(s): +${G.sol(b.reclaimed - b.fee)} SOL to you, ${b.fee ? G.sol(b.fee) + " SOL fee" : "no fee this time"}.`
        + (left ? ` ${left} more left: run it again after this one confirms.` : "") };
  } catch {
    return { status: 503, message: "Couldn't read the chain right now, try again in a minute." };
  }
}

app.post("/graveyard/action", async (c) => {
  const body: any = await c.req.json().catch(() => ({}));
  const r = await reclaimTx(c.env, body.account, (c.req.query("coins") || "").split(",").filter(Boolean));
  return r.transaction ? G.actionJson({ type: "transaction", transaction: r.transaction, message: r.message })
    : G.actionJson({ message: r.message }, r.status as any);
});
app.get("/graveyard/icon.svg", () => new Response(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" fill="#1b1530"/><circle cx="256" cy="150" r="70" fill="#f5d76e" opacity=".9"/><path d="M176 470V250a80 80 0 0 1 160 0v220z" fill="#8f8aa8"/><path d="M256 270v110M216 310h80" stroke="#1b1530" stroke-width="18" stroke-linecap="round"/><rect y="440" width="512" height="72" fill="#2c5f3a"/><text x="256" y="500" font-family="sans-serif" font-size="40" font-weight="700" fill="#f5d76e" text-anchor="middle">+SOL</text></svg>`,
  { headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400", "access-control-allow-origin": "*" } }));
app.get("/graveyard", (c) => c.redirect(G.dialLink(BASE)));
// Royalty Hunter: board of abandoned pump.fun coins + evidence packs for CTO creator-fee applications.
app.get("/royalties", async (c) => c.html(R.boardPage(await R.board(c.env.FEED)), 200, { "Cache-Control": "public, max-age=300" }));
app.get("/fees", async (c) => c.html(R.feesPage(await R.board(c.env.FEED)), 200, { "Cache-Control": "public, max-age=300" }));
app.get("/fees.json", async (c) => c.json(R.feeStats(await R.board(c.env.FEED)), 200, { "Cache-Control": "public, max-age=300", "access-control-allow-origin": "*" }));
app.get("/royalties.json", async (c) => c.json({ note: "Automated on-chain facts; 'abandoned' is an inference, not an accusation.",
  stats: R.feeStats(await R.board(c.env.FEED)), full_data: "GET /v1/abandoned (x402)" }, 200, { "Cache-Control": "public, max-age=300", "access-control-allow-origin": "*" }));
app.get("/royalties/:mint", async (c) => {
  const r = (await R.board(c.env.FEED)).find((x) => x.mint === c.req.param("mint"));
  return r ? c.html(R.evidencePage(r), 200, { "Cache-Control": "public, max-age=300" }) : c.text("Not on the board (yet).", 404);
});
// Rug Loss Harvester: browser-driven job (one Helius page per request), free preview, paid CSV.
const heliusKey = (env: Bindings) => (env.SOLANA_RPC || "").match(/api-key=([^&]+)/)?.[1] || "";
app.get("/losses", (c) => c.html(LOSSES_PAGE, 200, { "Cache-Control": "public, max-age=3600" }));
app.post("/losses/start", async (c) => {
  const { wallet } = await c.req.json().catch(() => ({} as any));
  if (!G.isAddress(wallet)) return c.json({ error: "That's not a Solana address." }, 400);
  if (!heliusKey(c.env)) return c.json({ error: "Reports are unavailable right now." }, 503);
  return c.json({ job: await LR.start(wallet) });
});
app.post("/losses/step", async (c) => {
  const { job } = await c.req.json().catch(() => ({} as any));
  if (!/^[0-9a-f]{24}$/.test(String(job))) return c.json({ error: "bad job" }, 400);
  return c.json(await LR.step(job, heliusKey(c.env)));
});
app.get("/losses/result", async (c) => {
  const job = c.req.query("job") || "";
  if (!/^[0-9a-f]{24}$/.test(job)) return c.json({ error: "bad job" }, 400);
  const r = await LR.finish(job, c.env.FEED, c.env.SOLANA_RPC || "https://api.mainnet-beta.solana.com");
  if ("error" in r) return c.json(r, 409);
  return c.json({ ...LR.preview(r), paid: await LR.isPaid(c.env.FEED, job), priceUsd: LR.PRICE_USD, priceStars: LR.PRICE_STARS,
    payAction: `https://dial.to/?action=${encodeURIComponent(`solana-action:${BASE}/losses/pay?job=${job}`)}`,
    payStars: `https://t.me/Rug1CheckSolBot?start=loss_${job}` });
});
const solUsd = LR.solUsdNow;
app.options("/losses/pay", () => G.actionOptions());
app.get("/losses/pay", (c) => G.actionJson({ type: "action", icon: `${BASE}/graveyard/icon.svg`, title: "Rug Loss Report",
  description: `Unlock your full per-token profit & loss CSV (realized losses and gains, dead coins, cost basis in SOL and USD). $${LR.PRICE_USD}, paid in SOL.`,
  label: `Pay $${LR.PRICE_USD} in SOL`, links: { actions: [{ type: "transaction", label: `Pay $${LR.PRICE_USD} in SOL`, href: `${BASE}/losses/pay?job=${c.req.query("job") || ""}` }] } }));
app.post("/losses/pay", async (c) => {
  const job = c.req.query("job") || "";
  const { account } = await c.req.json().catch(() => ({} as any));
  if (!/^[0-9a-f]{24}$/.test(job) || !(await LR.stored(c.env.FEED, job))) return G.actionJson({ message: "Report not found: generate it first." }, 404);
  if (!G.isAddress(account) || !c.env.PAY_TO_SOLANA) return G.actionJson({ message: "Connect a Solana wallet first." }, 400);
  const px = await solUsd();
  if (!px) return G.actionJson({ message: "Price feed unavailable, try again in a minute." }, 503);
  const lamports = Math.ceil(LR.PRICE_USD / px * 1e9);
  const ref = G.b58encode(await LR.reference(job));
  const data = [2, 0, 0, 0, ...Array.from({ length: 8 }, (_, i) => Number((BigInt(lamports) >> BigInt(8 * i)) & 255n))];
  const tx = G.compile(account, [{ program: G.SYSTEM, data, keys: [{ addr: account, signer: true, writable: true },
    { addr: c.env.PAY_TO_SOLANA, writable: true }, { addr: ref }] }], await G.latestBlockhash(c.env.SOLANA_RPC || "https://api.mainnet-beta.solana.com"));
  return G.actionJson({ type: "transaction", transaction: G.b64(tx), message: `Pays ${(lamports / 1e9).toFixed(4)} SOL ($${LR.PRICE_USD}) for the full report.` });
});
/** Paid? Looks for a successful transfer tagged with the job's reference that paid at least 95% of the price. */
app.get("/losses/check", async (c) => {
  const job = c.req.query("job") || "";
  if (!/^[0-9a-f]{24}$/.test(job)) return c.json({ error: "bad job" }, 400);
  if (await LR.isPaid(c.env.FEED, job)) return c.json({ paid: true });
  const rpc = c.env.SOLANA_RPC || "https://api.mainnet-beta.solana.com";
  const call = async (m: string, p: unknown[]) => (await (await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: m, params: p }) })).json() as any).result;
  const sigs: any[] = (await call("getSignaturesForAddress", [G.b58encode(await LR.reference(job)), { limit: 5, commitment: "confirmed" }])) || [];
  const px = await solUsd();
  for (const sg of sigs.filter((x) => !x.err)) {
    const tx = await call("getTransaction", [sg.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]);
    const keys = tx?.transaction?.message?.accountKeys?.map((k: any) => k.pubkey) || [];
    const i = keys.indexOf(c.env.PAY_TO_SOLANA);
    const got = i >= 0 ? tx.meta.postBalances[i] - tx.meta.preBalances[i] : 0;
    if (got > 0 && (!px || got / 1e9 * px >= LR.PRICE_USD * 0.95)) { await LR.markPaid(c.env.FEED, job, `sol:${sg.signature}`); return c.json({ paid: true }); }
  }
  return c.json({ paid: false });
});
app.get("/losses/csv", async (c) => {
  const job = c.req.query("job") || "";
  if (!/^[0-9a-f]{24}$/.test(job) || !(await LR.isPaid(c.env.FEED, job))) return c.text("Not unlocked.", 402);
  const r = await LR.stored(c.env.FEED, job);
  if (!r) return c.text("Report expired.", 404);
  return new Response(LR.csvWithHeader(r), { headers: { "content-type": "text/csv; charset=utf-8",
    "content-disposition": `attachment; filename="pnl-${r.wallet.slice(0, 6)}-${r.generatedAt.slice(0, 10)}.csv"` } });
});
// Trade button (Solana Action via Jupiter, small integrator fee). Buy only offered for low/medium-risk tokens.
app.options("/swap/action", () => G.actionOptions());
app.get("/swap/action", async (c) => {
  const mint = c.req.query("mint") || "";
  if (!isMint(mint)) return G.actionJson({ message: "Missing token." }, 400);
  let level = "high";
  try { level = (await check(c.env, mint)).level; } catch { /* unknown: sell only */ }
  return G.actionJson(SW.meta(BASE, mint, (c.req.query("symbol") || mint.slice(0, 4)).slice(0, 12), level === "low" || level === "medium"));
});
app.post("/swap/action", async (c) => {
  const mint = c.req.query("mint") || "", side = c.req.query("side") === "buy" ? "buy" : "sell", v = Number(c.req.query("v"));
  const { account } = await c.req.json().catch(() => ({} as any));
  if (!isMint(mint) || !G.isAddress(account)) return G.actionJson({ message: "Connect a Solana wallet first." }, 400);
  if (side === "buy") {                     // re-check: never offer a buy on a token that has turned risky
    try { const a = await check(c.env, mint); if (a.level !== "low" && a.level !== "medium") return G.actionJson({ message: "Buying is disabled: this token is now rated high risk." }, 422); }
    catch { return G.actionJson({ message: "Couldn't verify the token right now." }, 503); }
  }
  try {
    const b = await SW.build(c.env.SOLANA_RPC || "https://api.mainnet-beta.solana.com", c.env.PAY_TO_SOLANA || "", account, mint, side, v);
    return G.actionJson({ type: "transaction", transaction: b.transaction, message: b.message });
  } catch (e: any) { return G.actionJson({ message: String(e?.message || "Swap unavailable").slice(0, 160) }, 422); }
});
app.get("/lostfound", (c) => c.html(LOSTFOUND_PAGE, 200, { "Cache-Control": "public, max-age=3600" }));
app.get("/lostfound/scan", async (c) => {
  const w = c.req.query("wallet");
  if (!G.isAddress(w)) return c.json({ error: "That's not a Solana address." }, 400);
  try {
    const coins = (c.req.query("coins") || "").split(",").filter(Boolean).slice(0, G.MAX_COINS);
    const s = await G.scan(w!, c.env.SOLANA_RPC || "https://api.mainnet-beta.solana.com", await G.coinRefs(coins));
    const kinds = Object.fromEntries(Object.entries(s.byKind).map(([k, [count, lamports]]) => [k, { count, lamports }]));
    const warning = !s.closable.length ? null : !s.signable ? "This is a program or multisig account, not a normal wallet: reclaim from your multisig app."
      : !G.canPayFee(s) ? "This wallet needs about 0.001 SOL to pay the network fee. Top it up first." : null;
    return c.json({ wallet: w, total: s.lamports, back: s.lamports - G.totalFee(s.closable), kinds, rounds: Math.ceil(s.closable.length / G.MAX_PER_TX),
      warning, action: G.dialLink(BASE, coins) }, 200, { "Cache-Control": "private, max-age=30" });
  } catch { return c.json({ error: "Couldn't read the chain right now, try again in a minute." }, 503); }
});

// Grant-application service (landing page + intake form)
app.get("/grants", (c) => c.html(landing()));
app.post("/grants/intake", (c) => intake(c.req.raw, c.env.FEED));

app.get("/health", async (c) => {
  const feed = await readFeed(c.env.FEED);
  return c.json({ ok: !!feed, generated_at: feed?.generated_at ?? null, count: feed?.count ?? 0 });
});

app.get("/v1/sample", async (c) => {
  const feed = await readFeed(c.env.FEED);
  return feed ? c.json(sample(feed)) : c.json({ error: "feed not published yet" }, 503);
});

// Payment middleware is built on first use: Workers only expose env per request.
let payment: MiddlewareHandler | undefined;

const RISK_EXAMPLE = {
  mint: "So11111111111111111111111111111111111111112", score: 72, level: "critical",
  checks: [{ id: "mint_authority", ok: false, severity: "critical", points: 35, detail: "Someone can mint unlimited new tokens and dilute holders." },
           { id: "freeze_authority", ok: false, severity: "high", points: 30, detail: "Someone can freeze any holder's tokens (honeypot risk)." }],
  facts: { token_program: "spl-token", decimals: 6, supply: 1000000000, mint_authority: "Ab...", freeze_authority: "Cd..." },
  generated_at: "2026-10-14T18:00:00.000Z", method: "on-chain", disclaimer: "Contract-level checks; not financial advice.",
};

// Reject malformed input before anyone pays.
app.use("/v1/creator-fees", async (c, next) => isMint(c.req.query("mint")) ? next()
  : c.json({ error: "add ?mint=<pump.fun coin mint>", example: "/v1/creator-fees?mint=Diy4Q5aiNEcdn7CWhuwYtuoHtHD9rKBTHCa9hi4qpump" }, 400));
app.use("/v1/wallet-pnl", async (c, next) => G.isAddress(c.req.query("wallet")) ? next()
  : c.json({ error: "add ?wallet=<Solana wallet address>" }, 400));
app.use("/v1/token-risk", async (c, next) => {
  if (!isMint(c.req.query("mint"))) {
    return c.json({ error: "add ?mint=<Solana token mint address>", example: "/v1/token-risk?mint=" + Object.keys(KNOWN)[0] }, 400);
  }
  return next();
});

const pay = async (c: any, next: any) => {
  if (!payment) {
    const env = c.env;
    const facilitator = env.PAYAI_API_KEY_ID && env.PAYAI_API_KEY_SECRET
      ? createFacilitatorConfig(env.PAYAI_API_KEY_ID, env.PAYAI_API_KEY_SECRET)
      : { url: "https://facilitator.payai.network" };
    const server = new x402ResourceServer(new HTTPFacilitatorClient(facilitator))
      .register(env.EVM_NETWORK, new ExactEvmScheme());
    if (env.PAY_TO_SOLANA) server.register(env.SOLANA_NETWORK, new ExactSvmScheme());
    server.registerExtension(bazaarResourceServerExtension);     // lets facilitators list us in the x402 Bazaar
    payment = paymentMiddleware(
      {
        "GET /v1/opportunities": {
          accepts: paymentOptions(env),
          description: "Ranked paid work open to AI agents (bounties, agent marketplaces, bug bounties), refreshed every 2 hours",
          mimeType: "application/json",
          serviceName: "earner feed",
          tags: ["bounties", "jobs", "ai-agents", "solana", "earn", "opportunities"],
          extensions: {
            ...declareDiscoveryExtension({           // method comes from the route key ("GET ...")
              output: {
                example: {
                  generated_at: "2026-10-14T18:00:00+00:00", count: 1,
                  opportunities: [{ source: "superteam", title: "Write a technical guide", url: "https://earn.superteam.fun/listing/example",
                    reward_usd: 500, reward_token: "USDC", deadline: "2026-11-01T00:00:00Z", competition: 2,
                    agent_allowed: true, track: "work", score: 48.0, reasons: ["$500 vs 2 competitors -> EV ~$125"] }],
                },
              },
            }),
          },
          unpaidResponseBody: async () => {
            const feed = await readFeed(env.FEED);
            return { contentType: "application/json", body: feed ? sample(feed) : {} };
          },
        },
        "GET /v1/creator-fees": {
          accepts: paymentOptions(env, "0.005"),
          description: "pump.fun coin: creator fees waiting unclaimed, creator wallet SOL, whether the creator still holds the coin and "
            + "when it was last active. A dev-exit signal for trading agents.",
          mimeType: "application/json", serviceName: "earner creator fees", tags: ["solana", "pump.fun", "creator", "dev", "memecoin", "signal"],
          extensions: { ...declareDiscoveryExtension({ input: { mint: "Diy4Q5aiNEcdn7CWhuwYtuoHtHD9rKBTHCa9hi4qpump" },
            inputSchema: { properties: { mint: { type: "string", description: "pump.fun coin mint" } }, required: ["mint"] },
            output: { example: { mint: "…pump", creator: "…", fee_sharing: false, unclaimed_creator_fees_sol: 218.06, creator_wallet_sol: 13.9,
              creator_holds_coin: true, creator_last_activity: "2026-10-16T22:50:00.000Z" } } }) },
        },
        "GET /v1/abandoned": {
          accepts: paymentOptions(env, "0.02"),
          description: "pump.fun coins whose creator left (sold out, inactive 14+ days) while trading continues, plus the largest unclaimed "
            + "creator-fee piles among actively traded coins. Refreshed every 15 minutes.",
          mimeType: "application/json", serviceName: "earner abandoned coins", tags: ["solana", "pump.fun", "memecoin", "creator fees", "signal"],
          extensions: { ...declareDiscoveryExtension({ output: { example: { stats: { coins: 68, waitingLamports: 802675534895, over1Sol: 18, shared: 31 },
            abandoned: [], largest_unclaimed: [{ mint: "…pump", symbol: "STREAM", fees_waiting_sol: 218.06, est_fees_per_week_sol: 83.4 }] } } }) },
        },
        "GET /v1/wallet-pnl": {
          accepts: paymentOptions(env, "0.01"),
          description: `Realized profit & loss of a Solana wallet's most recent ${AD.PNL_SWAPS} swaps (SOL-quoted, average cost, USD): win rate, `
            + "best and worst trade. A sanity check before copy-trading a wallet.",
          mimeType: "application/json", serviceName: "earner wallet pnl", tags: ["solana", "wallet", "pnl", "copy trading", "trader", "memecoin"],
          extensions: { ...declareDiscoveryExtension({ input: { wallet: "<solana wallet>" },
            inputSchema: { properties: { wallet: { type: "string", description: "Solana wallet address" } }, required: ["wallet"] },
            output: { example: { wallet: "…", swaps_analyzed: 38, realized_pnl_usd: -412, closed_positions: 11, win_rate: 0.273 } } }) },
        },
        "GET /v1/token-risk": {
          accepts: paymentOptions(env, env.RISK_PRICE_USD || "0.002"),
          description: "Solana token contract-risk check from on-chain data: mint/freeze authority, permanent delegate, "
            + "transfer hooks and fees, pausability, mutable metadata, holder concentration. Score 0-100 with reasons.",
          mimeType: "application/json",
          serviceName: "earner token risk",
          tags: ["solana", "token", "risk", "rug", "honeypot", "security", "trading"],
          extensions: {
            ...declareDiscoveryExtension({
              input: { mint: "So11111111111111111111111111111111111111112" },
              inputSchema: { properties: { mint: { type: "string", description: "SPL or Token-2022 mint address" } }, required: ["mint"] },
              output: { example: RISK_EXAMPLE },
            }),
          },
          unpaidResponseBody: async () => ({ contentType: "application/json", body: {
            what: "Contract-level rug/honeypot check for a Solana token, from public on-chain data.",
            price_usd: env.RISK_PRICE_USD || "0.002", example_response: RISK_EXAMPLE } }),
        },
      },
      server,
      undefined,
      // Browsers get a wallet page (Phantom etc.) to pay in USDC on Solana; agents read the 402 headers.
      createPaywall().withNetwork(svmPaywall)
        .withConfig({ appName: "earner feed", testnet: !env.SOLANA_NETWORK.endsWith("5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp") })
        .build(),
    );
  }
  return payment(c, next);
};
app.use("/v1/opportunities", pay);
app.use("/v1/token-risk", pay);
app.use("/v1/creator-fees", pay);
app.use("/v1/abandoned", pay);
app.use("/v1/wallet-pnl", pay);
app.get("/v1/creator-fees", async (c) => {
  try { const r = await AD.creatorFees(c.env.SOLANA_RPC || "https://api.mainnet-beta.solana.com", c.req.query("mint")!);
        return r ? c.json(r) : c.json({ error: "not a SOL-paired pump.fun coin" }, 404); }
  catch { return c.json({ error: "chain data temporarily unavailable" }, 503); }
});
app.get("/v1/abandoned", async (c) => c.json(await AD.abandoned(c.env.FEED)));
app.get("/v1/wallet-pnl", async (c) => {
  try { return c.json(await AD.walletPnl(heliusKey(c.env), c.req.query("wallet")!)); }
  catch { return c.json({ error: "history temporarily unavailable" }, 503); }
});

// Free live demo on one fixed token (cached), so buyers can see a real answer before paying.
app.get("/v1/token-risk/demo", async (c) => {
  const demo = "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm";      // WIF (dogwifhat)
  const cache = (caches as any).default as Cache, key = new Request(`https://cache.local/risk-demo/${demo}`);
  const hit = await cache.match(key);
  if (hit) return new Response(hit.body, hit);
  try {
    const res = c.json({ demo: true, demo_note: "Free demo on WIF. Any other mint: GET /v1/token-risk?mint=... (x402, $0.002)",
                         ...(await assessMint(demo, c.env.SOLANA_RPC || "https://api.mainnet-beta.solana.com")) });
    res.headers.set("Cache-Control", "max-age=600");
    c.executionCtx.waitUntil(cache.put(key, res.clone()));
    return res;
  } catch (e: any) {
    return c.json({ error: "chain data temporarily unavailable", detail: String(e?.message ?? e).replace(/https?:\/\/\S+/g, "[rpc]").slice(0, 160) }, 503);
  }
});

app.get("/v1/token-risk", async (c) => {
  const mint = c.req.query("mint")!;
  const cache = (caches as any).default as Cache, key = new Request(`https://cache.local/risk/${mint}`);
  const hit = await cache.match(key);
  if (hit) return new Response(hit.body, hit);
  try {
    const result = await assessMint(mint, c.env.SOLANA_RPC || "https://api.mainnet-beta.solana.com");
    const res = c.json(result);
    res.headers.set("Cache-Control", "max-age=600");
    c.executionCtx.waitUntil(cache.put(key, res.clone()));
    return res;
  } catch (e: any) {
    if (e instanceof NotAMint) return c.json({ error: "that address is not a token mint" }, 404);
    return c.json({ error: "chain data temporarily unavailable, try again shortly" }, 503);
  }
});

app.get("/v1/opportunities", async (c) => {
  const feed = await readFeed(c.env.FEED);
  return feed ? c.json(feed) : c.json({ error: "feed not published yet" }, 503);
});

export const DIGEST_CRON = "0 18 * * *";      // 18:00 UTC: US afternoon, European evening

/** Daily rug-radar post to the owner's Telegram channel. */
export async function postDigest(env: Bindings) {
  if (!env.TG_BOT_TOKEN || !env.TG_CHANNEL) return "no channel";
  const evs = await E.recent(env.FEED, 24);
  const mints = [...new Set(evs.map((e) => e.mint))].slice(0, 10);
  const text = E.digest(evs, env.SOLANA_RPC ? await E.names(env.SOLANA_RPC, mints) : {}, "Rug1CheckSolBot");
  if (!text) return "nothing flagged";
  const r: any = await tg(env, "sendMessage", { chat_id: env.TG_CHANNEL, text, parse_mode: "HTML", link_preview_options: { is_disabled: true } });
  return r?.ok ? "posted" : `failed: ${r?.description}`;
}

export const ROYALTY_CRON = "7,22,37,52 * * * *";   // own invocation: its own outbound-request budget

// Crons: every 15 min the Watchtower re-checks watched tokens (and, offset, Royalty Hunter scans a few coins);
// once a day the rug radar is posted.
export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Bindings, ctx: ExecutionContext) {
    if (event.cron === ROYALTY_CRON) {
      return void ctx.waitUntil(R.run(env.FEED, env.SOLANA_RPC || "https://api.mainnet-beta.solana.com", env.NTFY_TOPIC
        ? (title, body) => fetch(`https://ntfy.sh/${env.NTFY_TOPIC}`, { method: "POST", body, headers: { Title: title, Tags: "crown" } })
        : undefined).catch(() => {}));
    }
    if (!env.TG_BOT_TOKEN) return;
    if (event.cron === DIGEST_CRON) return void ctx.waitUntil(postDigest(env).catch(() => {}));
    ctx.waitUntil(runWatches(env.FEED, env.SOLANA_RPC || "https://api.mainnet-beta.solana.com",
      (chat, text) => tg(env, "sendMessage", { chat_id: chat, text, parse_mode: "HTML", link_preview_options: { is_disabled: true } })));
  },
};
