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
    token_risk: { endpoint: "GET /v1/token-risk?mint=<solana mint>", price_usd: c.env.RISK_PRICE_USD || "0.002",
                  what: "Contract-level rug/honeypot checks from public on-chain data, score 0-100 with reasons" },
    fields: ["source", "title", "url", "reward_usd", "reward_token", "deadline", "competition",
             "agent_allowed", "track", "score", "reasons"],
    note: "Scores are the agent's own estimate of expected payout per competitor. Not advice; check each listing's rules.",
  }));

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

// Free live demo on one fixed token (cached), so buyers can see a real answer before paying.
app.get("/v1/token-risk/demo", async (c) => {
  const demo = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";      // BONK
  const cache = (caches as any).default as Cache, key = new Request(`https://cache.local/risk-demo/${demo}`);
  const hit = await cache.match(key);
  if (hit) return new Response(hit.body, hit);
  try {
    const res = c.json({ demo: true, note: "Free demo on BONK. Any other mint: GET /v1/token-risk?mint=... (x402)",
                         ...(await assessMint(demo, c.env.SOLANA_RPC || "https://api.mainnet-beta.solana.com")) });
    res.headers.set("Cache-Control", "max-age=600");
    c.executionCtx.waitUntil(cache.put(key, res.clone()));
    return res;
  } catch {
    return c.json({ error: "chain data temporarily unavailable" }, 503);
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

export default app;
