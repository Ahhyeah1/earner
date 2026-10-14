// Run: npm test  (bundles src/telegram.ts with esbuild, then node:test)
import { test } from "node:test";
import assert from "node:assert/strict";
const T = await import(process.env.TG_BUNDLE);

const MINT = "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm";
function fakeKV() { const m = new Map(); return { m, get: async (k, t) => { const v = m.get(k) ?? null; return t === "json" && v != null ? JSON.parse(v) : v; }, put: async (k, v) => { m.set(k, v); } }; }
function world({ rpcFails = false } = {}) {
  const sent = [];
  globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
  globalThis.fetch = async (url, init) => {
    url = String(url);
    if (url.includes("api.telegram.org")) { sent.push({ method: url.split("/").pop(), body: JSON.parse(init.body) }); return new Response('{"ok":true}'); }
    if (url.includes("ntfy.sh")) { sent.push({ method: "ntfy" }); return new Response("ok"); }
    if (rpcFails) throw new Error("network down");
    const body = JSON.parse(init.body);
    if (body.method === "getAccountInfo") return new Response(JSON.stringify({ result: { value: { owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      data: { parsed: { type: "mint", info: { mintAuthority: null, freezeAuthority: null, supply: "1000000000", decimals: 6 } } } } } }));
    return new Response(JSON.stringify({ result: { value: [{ amount: "100000000" }, { amount: "50000000" }] } }));
  };
  return { sent, env: { FEED: fakeKV(), TG_BOT_TOKEN: "x", TG_SECRET: "s", NTFY_TOPIC: "t" } };
}
const msg = (text, uid = 7, type = "private") => ({ message: { message_id: 1, text, from: { id: uid }, chat: { id: uid, type } } });

test("finds a mint in text and links, ignores junk", () => {
  assert.equal(T.findMint(`check https://pump.fun/coin/${MINT} pls`), MINT);
  assert.equal(T.findMint("hello there"), null);
});

test("five free checks a day, then an offer to buy", async () => {
  const { sent, env } = world();
  for (let i = 0; i < 5; i++) await T.handleUpdate(msg(MINT), env);
  const verdicts = sent.filter((s) => s.method === "sendMessage" && /risk/.test(s.body.text));
  assert.equal(verdicts.length, 5);
  assert.match(verdicts[0].body.text, /Top holder 10%/);
  await T.handleUpdate(msg(MINT), env);
  const last = sent.filter((s) => s.method === "sendMessage").pop();
  assert.ok(last.body.reply_markup.inline_keyboard.length >= 2, "6th check shows Stars packs");
});

test("Stars purchase: pre-checkout approved, credits added, owner pinged, credits used after free ones", async () => {
  const { sent, env } = world();
  await T.handleUpdate({ pre_checkout_query: { id: "q1", invoice_payload: "pack:p30" } }, env);
  assert.equal(sent.find((s) => s.method === "answerPreCheckoutQuery").body.ok, true);
  await T.handleUpdate({ pre_checkout_query: { id: "q2", invoice_payload: "pack:nope" } }, env);
  assert.equal(sent.filter((s) => s.method === "answerPreCheckoutQuery")[1].body.ok, false);
  await T.handleUpdate({ message: { message_id: 2, from: { id: 7 }, chat: { id: 7, type: "private" },
    successful_payment: { invoice_payload: "pack:p30", total_amount: 25, telegram_payment_charge_id: "c1" } } }, env);
  assert.equal(await env.FEED.get("tg:credits:7"), "30");
  assert.ok(sent.some((s) => s.method === "ntfy"));
  for (let i = 0; i < 6; i++) await T.handleUpdate(msg(MINT), env);
  assert.equal(await env.FEED.get("tg:credits:7"), "29");          // 5 free used first, then 1 paid
});

test("groups: only /check triggers, plain chatter is ignored", async () => {
  const { sent, env } = world();
  await T.handleUpdate(msg(`look at ${MINT}`, 9, "supergroup"), env);
  assert.equal(sent.length, 0);
  await T.handleUpdate(msg(`/check ${MINT}`, 9, "supergroup"), env);
  assert.ok(sent.some((s) => s.method === "sendMessage" && /risk/.test(s.body.text)));
});

test("chain failure gives the check back", async () => {
  const { env } = world({ rpcFails: true });
  await T.handleUpdate(msg(MINT), env);
  const key = [...env.FEED.m.keys()].find((k) => k.startsWith("tg:free:7:"));
  assert.equal(env.FEED.m.get(key), "0");
});

// ---- Watchtower ----
const W = T.W;
const snap = (o = {}) => ({ mint_authority: null, freeze_authority: null, extensions: [], flags: [], top1: 20, top10: 50, level: "low", ...o });
const assessment = (o = {}) => ({ mint: MINT, level: o.level || "low", score: 0, checks: o.checks || [],
  facts: { mint_authority: o.mint_authority ?? null, freeze_authority: null, extensions: [], top1_pct: "top1" in o ? o.top1 : 20, top10_pct: "top1" in o && o.top1 == null ? null : 50 } });

test("diff: dangerous changes alert, small drift doesn't", () => {
  assert.equal(W.diff(snap(), snap({ top1: 24, top10: 55 })).length, 0);
  assert.match(W.diff(snap(), snap({ mint_authority: "Evil111" })).join(), /RE-ENABLED/);
  assert.match(W.diff(snap(), snap({ freeze_authority: "Evil111" })).join(), /Freeze/);
  assert.match(W.diff(snap(), snap({ top1: 35 })).join(), /jumped/);
  assert.match(W.diff(snap({ top1: 40 }), snap({ top1: 15 })).join(), /dropped/);
});

test("one free watch, then Stars watch credits", async () => {
  const { sent, env } = world();
  await T.handleUpdate(msg(`/watch ${MINT}`), env);
  assert.match(sent.at(-1).body.text, /Watching/);
  await T.handleUpdate(msg(`/watch ${MINT}`), env);
  assert.match(sent.at(-1).body.text, /already watching/);
  const other = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
  await T.handleUpdate(msg(`/watch ${other}`), env);
  assert.ok(sent.at(-1).body.reply_markup.inline_keyboard.some((r) => r[0].callback_data === "buy:w5"), "offers watch pack");
  await T.handleUpdate({ message: { message_id: 3, from: { id: 7 }, chat: { id: 7, type: "private" },
    successful_payment: { invoice_payload: "pack:w5", total_amount: 75, telegram_payment_charge_id: "c2" } } }, env);
  assert.equal(await env.FEED.get("tg:wcredits:7"), "5");
  await T.handleUpdate({ callback_query: { id: "cb", data: `watch:${other}`, from: { id: 7 }, message: { chat: { id: 7 } } } }, env);
  assert.equal(await env.FEED.get("tg:wcredits:7"), "4");
  await T.handleUpdate(msg("/watches"), env);
  assert.match(sent.at(-1).body.text, /\(free\)/);
  await T.handleUpdate(msg(`/unwatch ${MINT}`), env);
  assert.equal(W.mine(await W.load(env.FEED), 7).length, 1);
});

test("verdicts carry a watch button", async () => {
  const { sent, env } = world();
  await T.handleUpdate(msg(MINT), env);
  assert.equal(sent.find((s) => /risk/.test(s.body.text || "")).body.reply_markup.inline_keyboard[0][0].callback_data, `watch:${MINT}`);
});

test("cron: baseline, quiet runs write nothing, change alerts, expiry ends", async () => {
  const kv = fakeKV(); const out = []; let writes = 0;
  const put = kv.put; kv.put = async (k, v) => { writes++; return put(k, v); };
  const send = async (chat, text) => out.push(text);
  const s = { watches: [] }; W.add(s, 7, 7, MINT, 0, 0); await W.save(kv, s); writes = 0;
  let a = assessment();
  const run = (now) => W.run(kv, "rpc", send, now, async () => a);
  await run(1000); assert.equal(writes, 1);                        // baseline stored
  await run(2000); await run(3000); assert.equal(writes, 1);       // nothing changed: no KV writes
  a = assessment({ top1: null }); await run(4000); assert.equal(out.length, 0);   // holder lookup failed: not a change
  a = assessment({ mint_authority: "Evil1111111111111111111111111111" }); await run(5000);
  assert.match(out.at(-1), /RE-ENABLED/);
  await run(6000); assert.equal(out.length, 1);                   // alert once, not every run
  await run(4 * 86_400_000); assert.match(out.at(-1), /ended/);
  assert.equal((await W.load(kv)).watches.length, 0);
});

test("cron checks a bounded batch per run", async () => {
  const kv = fakeKV(); const s = { watches: [] };
  for (let i = 0; i < 30; i++) s.watches.push({ uid: i, chat: i, mint: `M${String(i).padStart(2, "0")}`, until: 1e12, paid: true });
  await W.save(kv, s);
  let calls = 0;
  const r = await W.run(kv, "rpc", async () => {}, 0, async () => { calls++; return assessment(); });
  assert.equal(calls, W.TOKENS_PER_RUN); assert.equal(r.tokens, 30);
});
