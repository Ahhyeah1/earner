// Run: npm test  (bundles src/telegram.ts with esbuild, then node:test)
import { test } from "node:test";
import assert from "node:assert/strict";
const T = await import(process.env.TG_BUNDLE);

const MINT = "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm";
function fakeKV() { const m = new Map(); return { m, get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); } }; }
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
