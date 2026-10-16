// Minimal MCP server (Streamable HTTP, JSON responses, stateless) at POST /mcp, so AI assistants and agent
// frameworks can call the rug check as a tool. Free with a best-effort daily limit per IP; heavy users are
// pointed at the paid x402 endpoint. Listed in MCP directories for distribution.
import type { Assessment } from "./risk";
import { isMint } from "./risk";

export const FREE_PER_IP_DAY = 30;
const VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const TOOL = {
  name: "check_solana_token",
  title: "Solana token rug check",
  description: "Contract-level rug/honeypot check for a Solana SPL or Token-2022 token, read from on-chain data: mint and freeze "
    + "authority, permanent delegate, transfer hooks and fees, pausability, default-frozen accounts, mutable metadata and "
    + "holder concentration. Returns a 0-100 risk score, a level (low/medium/high/critical) and the reasons. Does not assess "
    + "liquidity locks or team behaviour; not financial advice.",
  inputSchema: { type: "object", properties: { mint: { type: "string", description: "Token mint address (base58)" } }, required: ["mint"] },
  annotations: { readOnlyHint: true, openWorldHint: true },
};

// Lost & Found for agents: AI agents with Solana wallets collect dead token accounts too. They find these tools in
// MCP directories, sign the returned transaction themselves, and the 10%/3% fee is inside that transaction.
const WALLET_ARGS = { type: "object", required: ["wallet"], properties: {
  wallet: { type: "string", description: "Solana wallet address (base58) to scan" },
  coins: { type: "array", items: { type: "string" }, maxItems: 4, description: "Optional: pump.fun coins this wallet created, to also sweep their unclaimed creator fees" } } };
const FIND_TOOL = {
  name: "find_forgotten_sol", title: "Find forgotten SOL in a wallet",
  description: "Scans a Solana wallet for SOL it can reclaim: rent locked in empty token accounts (dead or sold tokens), leftover "
    + "program-deploy buffers, and unclaimed pump.fun / PumpSwap creator fees. Read-only. Use build_reclaim_transaction to get it back.",
  inputSchema: WALLET_ARGS, annotations: { readOnlyHint: true, openWorldHint: true },
};
const BUILD_TOOL = {
  name: "build_reclaim_transaction", title: "Build a transaction that reclaims forgotten SOL",
  description: "Returns an UNSIGNED Solana transaction (base64, legacy format) that closes the wallet's empty token accounts and "
    + "program buffers and claims its creator fees, sending everything to the wallet itself minus a service fee (10% of the first "
    + "10 SOL reclaimed, 3% above). The wallet is the only signer and fee payer: sign it with the wallet's key and send it. "
    + "Nothing is burned and no tokens move. Up to 20 items per transaction; call again after it confirms for the rest.",
  inputSchema: WALLET_ARGS, annotations: { readOnlyHint: true, openWorldHint: true },
};

type Reclaim = { status: number; message: string; transaction?: string; scan?: { lamports: number; byKind: Record<string, [number, number]>; closable: unknown[] } };
type Ctx = { ip: string; check: (mint: string) => Promise<Assessment>; reclaim?: (wallet: string, coins: string[]) => Promise<Reclaim> };

const KIND_TEXT: Record<string, string> = { token: "empty token accounts", buffer: "program-deploy buffers", creator: "pump.fun creator fees", swap: "PumpSwap creator fees" };
export function reclaimSummary(wallet: string, r: Reclaim): string {
  const s = r.scan;
  if (!s || !s.closable.length) return `${wallet}: nothing to reclaim. ${r.status === 200 ? "" : r.message}`.trim();
  const lines = Object.entries(s.byKind).filter(([, [n]]) => n).map(([k, [n, l]]) => `- ${n} ${KIND_TEXT[k] || k}: ${(l / 1e9).toFixed(4)} SOL`);
  return [`${wallet} can reclaim ${(s.lamports / 1e9).toFixed(4)} SOL:`, ...lines, r.status === 200 ? `Next batch: ${r.message}` : `Note: ${r.message}`].join("\n");
}

const ok = (id: unknown, result: unknown) => ({ jsonrpc: "2.0", id, result });
const err = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

export function summary(a: Assessment): string {
  const flags = a.checks.filter((c) => !c.ok);
  const f: any = a.facts;
  return [`${a.level.toUpperCase()} risk, score ${a.score}/100 for ${a.mint}`, a.known ? `Known token: ${a.known}` : "",
    flags.length ? "Red flags:\n" + flags.map((c) => `- ${c.detail}`).join("\n") : "No contract red flags found.",
    f.top1_pct != null ? `Top holder ${f.top1_pct}%, top 10 ${f.top10_pct}%.` : "", a.note || "", a.disclaimer].filter(Boolean).join("\n");
}

/** Best-effort per-IP daily counter in the edge cache (no KV writes). */
async function allowed(ip: string): Promise<boolean> {
  const cache = (caches as any).default as Cache, key = new Request(`https://cache.local/mcp/${new Date().toISOString().slice(0, 10)}/${ip}`);
  const n = Number((await (await cache.match(key))?.text()) || 0);
  if (n >= FREE_PER_IP_DAY) return false;
  await cache.put(key, new Response(String(n + 1), { headers: { "Cache-Control": "max-age=86400" } }));
  return true;
}

async function one(msg: any, ctx: Ctx): Promise<object | null> {
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return err(msg?.id ?? null, -32600, "Invalid Request");
  const { id, method, params } = msg;
  if (id === undefined) return null;                                   // notification (e.g. notifications/initialized)
  switch (method) {
    case "initialize":
      return ok(id, { protocolVersion: VERSIONS.includes(params?.protocolVersion) ? params.protocolVersion : VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "solana-rug-check", title: "Solana Rug Check & Lost-and-Found", version: "1.1.0" },
        instructions: "Call check_solana_token with a Solana token mint address before trading or recommending a token. Call find_forgotten_sol / build_reclaim_transaction to recover SOL locked in a wallet you control." });
    case "ping": return ok(id, {});
    case "tools/list": return ok(id, { tools: ctx.reclaim ? [TOOL, FIND_TOOL, BUILD_TOOL] : [TOOL] });
    case "tools/call": {
      if ((params?.name === FIND_TOOL.name || params?.name === BUILD_TOOL.name) && ctx.reclaim) {
        const wallet = String(params?.arguments?.wallet || "").trim();
        const coins = (Array.isArray(params?.arguments?.coins) ? params.arguments.coins : []).map(String).filter(isMint).slice(0, 4);
        if (!isMint(wallet)) return ok(id, { isError: true, content: [{ type: "text", text: "wallet must be a Solana address (base58)." }] });
        if (!(await allowed(ctx.ip))) return ok(id, { isError: true, content: [{ type: "text", text: `Free limit of ${FREE_PER_IP_DAY} calls/day reached; try tomorrow.` }] });
        const r = await ctx.reclaim(wallet, coins);
        const text = reclaimSummary(wallet, r);
        if (params.name === FIND_TOOL.name) return ok(id, { content: [{ type: "text", text }], structuredContent: { wallet, reclaimableLamports: r.scan?.lamports ?? 0, byKind: r.scan?.byKind ?? {} } });
        if (!r.transaction) return ok(id, { isError: r.status !== 422, content: [{ type: "text", text }] });
        return ok(id, { content: [{ type: "text", text: `${text}\n\nUnsigned transaction (base64): sign with ${wallet} and send.` }],
          structuredContent: { wallet, transaction: r.transaction, encoding: "base64", message: r.message } });
      }
      if (params?.name !== TOOL.name) return err(id, -32602, `Unknown tool: ${params?.name}`);
      const mint = String(params?.arguments?.mint || "").trim();
      if (!isMint(mint)) return ok(id, { isError: true, content: [{ type: "text", text: "mint must be a Solana token mint address (base58, 32-44 chars)." }] });
      if (!(await allowed(ctx.ip))) return ok(id, { isError: true, content: [{ type: "text", text:
        `Free limit of ${FREE_PER_IP_DAY} checks/day reached. Unlimited: GET https://earner-feed.earner-feed.workers.dev/v1/token-risk?mint=${mint} (x402, $0.002 USDC per call), or the Telegram bot @Rug1CheckSolBot.` }] });
      try {
        const a = await ctx.check(mint);
        return ok(id, { content: [{ type: "text", text: summary(a) }], structuredContent: a });
      } catch (e: any) {
        const msg = String(e?.message || "").includes("not a token mint") ? "That address is not a token mint." : "Chain data temporarily unavailable, try again shortly.";
        return ok(id, { isError: true, content: [{ type: "text", text: msg }] });
      }
    }
    default: return err(id, -32601, `Method not found: ${method}`);
  }
}

export async function handle(req: Request, ctx: Ctx): Promise<Response> {
  if (req.method === "GET") return new Response("This MCP server doesn't offer an SSE stream; POST JSON-RPC to /mcp.", { status: 405, headers: { Allow: "POST" } });
  if (req.method === "DELETE") return new Response(null, { status: 405 });
  let body: any;
  try { body = await req.json(); } catch { return Response.json(err(null, -32700, "Parse error"), { status: 400 }); }
  const out = Array.isArray(body) ? (await Promise.all(body.map((m) => one(m, ctx)))).filter(Boolean) : await one(body, ctx);
  if (!out || (Array.isArray(out) && !out.length)) return new Response(null, { status: 202 });
  return Response.json(out, { headers: { "access-control-allow-origin": "*" } });
}
