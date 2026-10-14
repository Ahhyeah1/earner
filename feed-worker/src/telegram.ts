// Telegram rug-check bot: paste a Solana token address, get the on-chain contract/holder risk verdict.
// Free checks per user per day; more via Telegram Stars (XTR), Telegram's required currency for digital goods.
import { assessMint, isMint, type Assessment } from "./risk";
import * as W from "./watch";

export type TgEnv = {
  FEED: KVNamespace; TG_BOT_TOKEN?: string; TG_SECRET?: string; SOLANA_RPC?: string; NTFY_TOPIC?: string;
};

export const FREE_PER_DAY = 5;
export const PACKS: Record<string, { checks?: number; watches?: number; stars: number; title: string; desc: string }> = {
  p30: { checks: 30, stars: 25, title: "30 rug checks", desc: "30 Solana token rug checks (on-chain contract + holder concentration). Never expire." },
  p200: { checks: 200, stars: 100, title: "200 rug checks", desc: "200 Solana token rug checks (on-chain contract + holder concentration). Never expire." },
  w5: { watches: 5, stars: 75, title: "5 token watches", desc: "Watch 5 tokens for 30 days each: alerts if mint/freeze authority returns, risky extensions appear or holders shift sharply." },
};
const creditKey = (uid: number) => `tg:credits:${uid}`, watchKey = (uid: number) => `tg:wcredits:${uid}`;
const MINT_IN_TEXT = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;
const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));

export async function tg(env: TgEnv, method: string, body: unknown) {
  const r = await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return r.json() as Promise<any>;
}

/** Pull a mint address out of free text or a pump.fun / solscan / birdeye link. */
export function findMint(text: string): string | null {
  const hits = (text.match(MINT_IN_TEXT) || []).filter(isMint);
  return hits.length ? hits[0] : null;
}

const ICON: Record<string, string> = { low: "🟢", medium: "🟡", high: "🟠", critical: "🔴" };

export function format(a: Assessment): string {
  const flags = a.checks.filter((c) => !c.ok);
  const lines = [
    `${ICON[a.level]} <b>${a.level.toUpperCase()} risk</b> · score ${a.score}/100`,
    `<code>${a.mint}</code>`,
  ];
  if (a.known) lines.push(`ℹ️ ${esc(a.known)}`);
  if (flags.length) {
    lines.push("", "<b>Red flags</b>");
    for (const f of flags) lines.push(`• ${esc(f.detail)}`);
  } else {
    lines.push("", "No contract red flags found.");
  }
  const f: any = a.facts;
  if (f.top1_pct != null) lines.push("", `👥 Top holder ${f.top1_pct}% · top 10 ${f.top10_pct}%`);
  if (a.note) lines.push("", `⚠️ ${esc(a.note)}`);
  lines.push("", `<i>On-chain contract checks only, not financial advice. Liquidity locks and team behaviour are not assessed.</i>`);
  return lines.join("\n");
}

const today = () => new Date().toISOString().slice(0, 10);

/** Spend one check: free daily allowance first, then paid credits. Null when none left. */
export async function spend(kv: KVNamespace, uid: number): Promise<{ source: "free" | "credit"; free: number; credits: number } | null> {
  const fk = `tg:free:${uid}:${today()}`;
  const used = Number((await kv.get(fk)) || 0);
  const credits = Number((await kv.get(`tg:credits:${uid}`)) || 0);
  if (used < FREE_PER_DAY) {
    await kv.put(fk, String(used + 1), { expirationTtl: 60 * 60 * 48 });
    return { source: "free", free: FREE_PER_DAY - used - 1, credits };
  }
  if (credits > 0) {
    await kv.put(`tg:credits:${uid}`, String(credits - 1));
    return { source: "credit", free: 0, credits: credits - 1 };
  }
  return null;
}

/** Give back exactly what spend() took (our failure shouldn't cost the user). */
export async function refund(kv: KVNamespace, uid: number, source: "free" | "credit") {
  if (source === "free") {
    const fk = `tg:free:${uid}:${today()}`;
    const used = Number((await kv.get(fk)) || 0);
    if (used > 0) await kv.put(fk, String(used - 1), { expirationTtl: 60 * 60 * 48 });
  } else {
    const ck = `tg:credits:${uid}`;
    await kv.put(ck, String(Number((await kv.get(ck)) || 0) + 1));
  }
}

async function offer(env: TgEnv, chat: number, text = `You've used today's ${FREE_PER_DAY} free checks. Get more with Telegram Stars:`) {
  await tg(env, "sendMessage", { chat_id: chat, text,
    reply_markup: { inline_keyboard: Object.entries(PACKS).map(([id, p]) => [{ text: `${p.title} · ${p.stars} ⭐`, callback_data: `buy:${id}` }]) } });
}

async function invoice(env: TgEnv, chat: number, pack: string) {
  const p = PACKS[pack];
  if (!p) return;
  await tg(env, "sendInvoice", { chat_id: chat, title: p.title, currency: "XTR", provider_token: "",
    description: p.desc, payload: `pack:${pack}`, prices: [{ label: p.title, amount: p.stars }] });
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

async function watch(env: TgEnv, chat: number, uid: number, mint: string) {
  const s = await W.load(env.FEED);
  const credits = Number((await env.FEED.get(watchKey(uid))) || 0);
  const r = W.add(s, uid, chat, mint, credits);
  if (!r.ok) {
    if (r.reason === "no_credit") return offer(env, chat, "Your free watch is in use. Watch more tokens with Telegram Stars (/unwatch frees a slot):");
    return void (await tg(env, "sendMessage", { chat_id: chat,
      text: r.reason === "duplicate" ? "You're already watching that token. /watches" : `You can watch up to ${W.MAX_PER_USER} tokens at once.` }));
  }
  if (r.paid) await env.FEED.put(watchKey(uid), String(credits - 1));
  await W.save(env.FEED, s);
  await tg(env, "sendMessage", { chat_id: chat, parse_mode: "HTML", text: `👁 Watching <code>${mint}</code> until ${day(r.until)}.\n`
    + `I re-check it every 15 minutes and message you if mint/freeze authority comes back, risky extensions appear or big holders shift.`
    + (r.paid ? `\nWatch credits left: ${credits - 1}` : `\n(Free watch, ${W.FREE_DAYS} days. More: /buy)`) });
}

const HELP = `🔎 <b>Solana rug check</b>
Send me a token's mint address (or a pump.fun / solscan link) and I'll check it on-chain:
• can someone mint more, freeze your tokens or take them (permanent delegate)?
• transfer hooks, hidden fees, pause switch, changeable metadata
• holder concentration

👁 <b>Watchtower:</b> <code>/watch &lt;mint&gt;</code> and I'll alert you if the contract turns dangerous later (mint/freeze authority comes back, risky extensions, big holder moves). 1 free watch · /watches · /unwatch

${FREE_PER_DAY} free checks a day. /buy for more · /credits · /terms · /paysupport
In groups: <code>/check &lt;mint&gt;</code>`;

const TERMS = `<b>Terms</b>
Checks are automated readings of public Solana data, provided as-is. They are not financial advice and can't detect every scam (e.g. liquidity pulls or team behaviour). Purchased checks never expire and are non-transferable. A watch credit covers one token for 30 days from when you start it; alerts are best-effort (checked about every 15 minutes) and can be delayed or missed. Refunds: /paysupport.`;

export async function handleUpdate(u: any, env: TgEnv): Promise<void> {
  if (u.pre_checkout_query) {
    const ok = !!PACKS[String(u.pre_checkout_query.invoice_payload || "").replace("pack:", "")];
    await tg(env, "answerPreCheckoutQuery", { pre_checkout_query_id: u.pre_checkout_query.id, ok,
      ...(ok ? {} : { error_message: "Unknown product, please try /buy again." }) });
    return;
  }
  if (u.callback_query) {
    const data = String(u.callback_query.data || "");
    await tg(env, "answerCallbackQuery", { callback_query_id: u.callback_query.id });
    if (data.startsWith("buy:")) await invoice(env, u.callback_query.message.chat.id, data.slice(4));
    if (data.startsWith("watch:") && isMint(data.slice(6))) await watch(env, u.callback_query.message.chat.id, u.callback_query.from.id, data.slice(6));
    return;
  }
  const m = u.message;
  if (!m || !m.from) return;
  const chat = m.chat.id, uid = m.from.id;
  if (m.successful_payment) {
    const pack = PACKS[String(m.successful_payment.invoice_payload).replace("pack:", "")];
    if (!pack) return;
    const key = pack.watches ? watchKey(uid) : creditKey(uid);
    const added = pack.watches || pack.checks || 0;
    const now = Number((await env.FEED.get(key)) || 0) + added;
    await env.FEED.put(key, String(now));
    await env.FEED.put(`tg:charge:${m.successful_payment.telegram_payment_charge_id}`,
      JSON.stringify({ uid, stars: m.successful_payment.total_amount, pack: pack.title, at: new Date().toISOString() }));
    await tg(env, "sendMessage", { chat_id: chat, text: pack.watches
      ? `✅ Thanks! ${added} watch credits added (${now} total). Use /watch <mint>.`
      : `✅ Thanks! ${added} checks added. You now have ${now}.` });
    if (env.NTFY_TOPIC) {
      await fetch(`https://ntfy.sh/${env.NTFY_TOPIC}`, { method: "POST", body: `Telegram sale: ${pack.title} for ${m.successful_payment.total_amount} Stars`,
        headers: { Title: "Telegram bot sale", Tags: "moneybag" } }).catch(() => {});
    }
    return;
  }
  const text: string = m.text || m.caption || "";
  const group = m.chat.type !== "private";
  const cmd = text.trim().split(/\s+/)[0].split("@")[0].toLowerCase();
  if (cmd === "/start" || cmd === "/help") return void (await tg(env, "sendMessage", { chat_id: chat, text: HELP, parse_mode: "HTML" }));
  if (cmd === "/terms") return void (await tg(env, "sendMessage", { chat_id: chat, text: TERMS, parse_mode: "HTML" }));
  if (cmd === "/paysupport") return void (await tg(env, "sendMessage", { chat_id: chat,
    text: "Payment problem or refund request? Reply here with your issue and the purchase date; it's reviewed within 48 hours. You can also reach the developer at x.com/1ahhyeah." }));
  if (cmd === "/buy") return void (await offer(env, chat));
  if (cmd === "/credits") {
    const used = Number((await env.FEED.get(`tg:free:${uid}:${today()}`)) || 0);
    const credits = Number((await env.FEED.get(creditKey(uid))) || 0);
    const wcredits = Number((await env.FEED.get(watchKey(uid))) || 0);
    return void (await tg(env, "sendMessage", { chat_id: chat,
      text: `Free today: ${Math.max(0, FREE_PER_DAY - used)}/${FREE_PER_DAY} · paid checks: ${credits} · watch credits: ${wcredits}` }));
  }
  if (cmd === "/watches") {
    const ws = W.mine(await W.load(env.FEED), uid);
    return void (await tg(env, "sendMessage", { chat_id: chat, parse_mode: "HTML", text: ws.length
      ? "👁 <b>Your watches</b>\n" + ws.map((w) => `• <code>${w.mint}</code> until ${day(w.until)}${w.paid ? "" : " (free)"}`).join("\n") + "\n\n/unwatch &lt;mint&gt; to stop"
      : "You're not watching any tokens. /watch &lt;mint&gt; to start." }));
  }
  if (cmd === "/watch" || cmd === "/unwatch") {
    const target = findMint(text);
    if (!target) return void (await tg(env, "sendMessage", { chat_id: chat, text: `Usage: ${cmd} <token mint address>` }));
    if (cmd === "/watch") return void (await watch(env, chat, uid, target));
    const s = await W.load(env.FEED);
    const gone = W.remove(s, uid, target);
    if (gone) await W.save(env.FEED, s);
    return void (await tg(env, "sendMessage", { chat_id: chat, text: gone ? "Stopped watching that token." : "You weren't watching that token. /watches" }));
  }
  if (group && cmd !== "/check") return;               // in groups, only react to /check
  const mint = findMint(text);
  if (!mint) {
    if (!group) await tg(env, "sendMessage", { chat_id: chat, text: "Send me a Solana token mint address (32-44 characters), or /help." });
    return;
  }
  const left = await spend(env.FEED, uid);
  if (!left) return void (await offer(env, chat));
  await tg(env, "sendChatAction", { chat_id: chat, action: "typing" });
  try {
    const cache = (caches as any).default as Cache, key = new Request(`https://cache.local/risk/${mint}`);
    const hit = await cache.match(key);
    const a: Assessment = hit ? await hit.json() : await assessMint(mint, env.SOLANA_RPC || "https://api.mainnet-beta.solana.com");
    if (!hit) await cache.put(key, new Response(JSON.stringify(a), { headers: { "Cache-Control": "max-age=600", "content-type": "application/json" } }));
    const footer = left.free > 0 ? `\n\n${left.free} free checks left today` : `\n\n${left.credits} paid checks left`;
    await tg(env, "sendMessage", { chat_id: chat, text: format(a) + footer, parse_mode: "HTML",
      reply_to_message_id: m.message_id, link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: [[{ text: "👁 Watch for changes", callback_data: `watch:${mint}` }]] } });
  } catch (e: any) {
    await refund(env.FEED, uid, left.source);         // give the check back - not the user's fault
    const msg = String(e?.message || "").includes("not a token mint") ? "That address isn't a token mint." : "Couldn't read chain data right now, try again in a minute (no check used).";
    await tg(env, "sendMessage", { chat_id: chat, text: msg, reply_to_message_id: m.message_id });
  }
}
export { W };          // for tests
