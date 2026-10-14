// Apify Actor: Solana token rug checks. The check itself runs on the earner-feed Cloudflare worker
// (same code as the Telegram bot and the x402 API); this Actor sells it on the Apify Store, billed
// per checked token via pay-per-event ("token-check").
import { Actor, log } from "apify";

const API = process.env.EARNER_API || "https://earner-feed.earner-feed.workers.dev";
const MINT = /[1-9A-HJ-NP-Za-km-z]{32,44}/;
const MAX_MINTS = 1000, CONCURRENCY = 4;

export function extractMint(s) {
    const m = String(s || "").match(MINT);
    return m ? m[0] : null;
}

export function row(mint, a) {
    return {
        mint, level: a.level, score: a.score,
        redFlags: a.checks.filter((c) => !c.ok).map((c) => c.detail),
        top1Pct: a.facts?.top1_pct ?? null, top10Pct: a.facts?.top10_pct ?? null,
        coverage: a.coverage ?? null, known: a.known ?? null, note: a.note ?? null,
        checks: a.checks, facts: a.facts, checkedAt: a.generated_at, disclaimer: a.disclaimer,
    };
}

async function check(mint, key) {
    for (let attempt = 0; attempt < 3; attempt++) {
        const r = await fetch(`${API}/internal/token-risk?mint=${mint}`, { headers: { "x-internal-key": key } });
        if (r.ok) return { ok: true, a: await r.json() };
        if (r.status === 404 || r.status === 400) return { ok: false, error: r.status === 404 ? "not a token mint" : "invalid address" };
        if (r.status === 403) throw new Error("Backend rejected the Actor key (EARNER_INTERNAL_KEY).");
        await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
    }
    return { ok: false, error: "chain data temporarily unavailable" };
}

await Actor.init();
const input = (await Actor.getInput()) || {};
const key = process.env.EARNER_INTERNAL_KEY;
if (!key) await Actor.fail("EARNER_INTERNAL_KEY is not configured for this Actor.");

const mints = [...new Set((input.mints || []).map(extractMint).filter(Boolean))].slice(0, MAX_MINTS);
if (!mints.length) await Actor.fail("Give at least one Solana token mint address in `mints`.");
log.info(`Checking ${mints.length} token(s)`);

let i = 0, charged = 0, stop = false;
async function workerLoop() {
    while (!stop && i < mints.length) {
        const mint = mints[i++];
        const res = await check(mint, key);
        if (!res.ok) { await Actor.pushData({ mint, error: res.error }); continue; }   // failures are free
        const out = row(mint, res.a);
        if (input.onlyRisky && !["high", "critical"].includes(out.level)) continue;   // filtered out: not charged
        await Actor.pushData(out);
        const c = await Actor.charge({ eventName: "token-check", count: 1 });
        charged++;
        if (c?.eventChargeLimitReached) { log.info("Run's spending limit reached, stopping."); stop = true; }
    }
}
await Promise.all(Array.from({ length: CONCURRENCY }, workerLoop));
log.info(`Done: ${charged} token(s) delivered.`);
await Actor.exit();
