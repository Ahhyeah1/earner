// Run: npm test  (bundles test/entry.ts with esbuild, then node:test)
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

// ---- Group guard, rug radar, MCP ----
const E = T.E, M = T.M;
const RISKY = { ...{ result: { value: { owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  data: { parsed: { type: "mint", info: { mintAuthority: "Evil1111111111111111111111111111", freezeAuthority: "Evil1111111111111111111111111111", supply: "1000000000", decimals: 6 } } } } } } };
function riskyWorld(admin = true) {
  const w = world();
  const base = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    url = String(url);
    if (url.endsWith("/getChatMember")) return new Response(JSON.stringify({ ok: true, result: { status: admin ? "administrator" : "member" } }));
    if (!url.includes("telegram") && !url.includes("ntfy") && JSON.parse(init.body).method === "getAccountInfo") return new Response(JSON.stringify(RISKY));
    return base(url, init);
  };
  const store = new Map(); globalThis.caches = { default: { match: async (r) => store.get(r.url), put: async (r, res) => { store.set(r.url, res); } } };
  w.env.FEED.delete = async (k) => { w.env.FEED.m.delete(k); };
  return w;
}

test("guard: off by default, admin turns it on, warns only on risky tokens, once per token", async () => {
  const { sent, env } = riskyWorld();
  await T.handleUpdate(msg(`ape ${MINT}`, 9, "supergroup"), env);
  assert.equal(sent.filter((s) => s.method === "sendMessage").length, 0, "silent while off");
  await T.handleUpdate(msg("/guard on", 9, "supergroup"), env);
  assert.match(sent.at(-1).body.text, /Guard ON/);
  await T.handleUpdate(msg(`ape ${MINT}`, 9, "supergroup"), env);
  assert.match(sent.at(-1).body.text, /Guard warning[\s\S]*CRITICAL/);
  const n = sent.length;
  await T.handleUpdate(msg(`again ${MINT}`, 9, "supergroup"), env);
  assert.equal(sent.length, n, "same token not re-flagged");
  assert.equal((await E.recent(env.FEED, 24))[0].src, "guard");
});

test("guard: non-admins can't toggle it; clean tokens stay silent", async () => {
  const { sent, env } = riskyWorld(false);
  await T.handleUpdate(msg("/guard on", 9, "supergroup"), env);
  assert.match(sent.at(-1).body.text, /Only group admins/);
  const w = world(); w.env.FEED.m.set("tg:guard:9", "1");
  await T.handleUpdate(msg(`ape ${MINT}`, 9, "supergroup"), w.env);
  assert.equal(w.sent.filter((s) => s.method === "sendMessage").length, 0);
});

test("risky private checks are logged once per day; digest and page render", async () => {
  const { env } = riskyWorld();
  await T.handleUpdate(msg(MINT), env); await T.handleUpdate(msg(MINT), env);
  const evs = await E.recent(env.FEED, 24);
  assert.equal(evs.length, 1);
  assert.deepEqual(evs[0].flags, ["mint_authority", "freeze_authority"]);
  const d = E.digest(evs, { [MINT]: "Evil &lt;b&gt; ($EVL)" }, "Rug1CheckSolBot");
  assert.match(d, /1 token\(s\) flagged/); assert.match(d, /can mint more, can freeze wallets/);
  assert.equal(E.digest([], {}, "x"), null);
  assert.match(E.page(evs, "Rug1CheckSolBot"), /<td class="critical">critical/);
});

test("MCP: initialize, list, call, bad input, limit", async () => {
  riskyWorld();
  const call = async (body, ip = "1.1.1.1") => (await M.handle(new Request("https://x/mcp", { method: "POST", body: JSON.stringify(body) }),
    { ip, check: async (m) => T.check({}, m) })).json();
  const init = await call({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.equal((await M.handle(new Request("https://x/mcp", { method: "POST", body: '{"jsonrpc":"2.0","method":"notifications/initialized"}' }), {})).status, 202);
  assert.equal((await call({ jsonrpc: "2.0", id: 2, method: "tools/list" })).result.tools[0].name, "check_solana_token");
  const r = await call({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "check_solana_token", arguments: { mint: MINT } } });
  assert.match(r.result.content[0].text, /CRITICAL risk/); assert.equal(r.result.structuredContent.level, "critical");
  assert.equal((await call({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "check_solana_token", arguments: { mint: "nope" } } })).result.isError, true);
  for (let i = 0; i < M.FREE_PER_IP_DAY; i++) await call({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "check_solana_token", arguments: { mint: MINT } } }, "2.2.2.2");
  assert.match((await call({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "check_solana_token", arguments: { mint: MINT } } }, "2.2.2.2")).result.content[0].text, /Free limit/);
});

// ---- Rug Graveyard ----
const G = T.G;
const OWNER = "4U6pdNLKMjNz68giUMXGmQHoCpsUqYyT32nfvD5dh5vb", FEEW = "4px5eCg2hVXzFY4jguRQmQ4YUyJ5pXPPLJGPnHba6GLg";
const HASH = "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm";
const acct = (i, info, lamports = 2039280) => ({ pubkey: G.b58encode(Uint8Array.from({ length: 32 }, (_, j) => (i * 7 + j + 1) % 256)),
  account: { lamports, data: { parsed: { info: { mint: MINT, owner: OWNER, state: "initialized", tokenAmount: { amount: "0" }, ...info } } } } });

test("base58 round-trips and validates addresses", () => {
  for (const a of [OWNER, G.SYSTEM, G.REFERENCE, G.TOKEN22]) assert.equal(G.b58encode(G.pubkey(a)), a);
  assert.equal(G.isAddress(OWNER), true); assert.equal(G.isAddress("abc"), false); assert.equal(G.isAddress("0OIl"), false);
});

test("classify: only empty, unfrozen, owner-closable accounts with safe extensions", () => {
  const c = G.classify(OWNER, [
    acct(1, {}), acct(2, { tokenAmount: { amount: "5" } }), acct(3, { state: "frozen" }), acct(4, { isNative: true }),
    acct(5, { closeAuthority: "Evil1111111111111111111111111111" }), acct(6, { closeAuthority: OWNER }),
    acct(7, { extensions: [{ extension: "immutableOwner" }, { extension: "pausableAccount" }, { extension: "transferHookAccount" }] }),
    acct(8, { extensions: [{ extension: "transferFeeAmount", state: { withheldAmount: 99 } }] }),
    acct(9, { extensions: [{ extension: "confidentialTransferAccount" }] }), acct(10, { owner: "Someone1111111111111111111111111" }),
  ], G.TOKEN);
  assert.equal(c.closable.length, 3); assert.equal(c.withBalance, 1); assert.equal(c.skipped, 6);
});

function parseTx(tx) {          // independent decoder for the legacy wire format (single-byte compact lengths here)
  let o = 0; const nsig = tx[o++]; o += 64 * nsig;
  const header = [tx[o++], tx[o++], tx[o++]]; const nkeys = tx[o++];
  const keys = []; for (let i = 0; i < nkeys; i++) { keys.push(G.b58encode(tx.slice(o, o + 32))); o += 32; }
  const hash = G.b58encode(tx.slice(o, o + 32)); o += 32;
  const nix = tx[o++], ixs = [];
  for (let i = 0; i < nix; i++) { const prog = keys[tx[o++]]; const na = tx[o++]; const acc = [...tx.slice(o, o + na)].map((k) => keys[k]); o += na; const nd = tx[o++]; ixs.push({ prog, acc, data: [...tx.slice(o, o + nd)] }); o += nd; }
  return { nsig, header, keys, hash, ixs, rest: tx.length - o };
}

test("build: exact instructions, fee math, size limit, fee skipped when it can't land", () => {
  const accs = G.classify(OWNER, Array.from({ length: 30 }, (_, i) => acct(i + 1, {})), G.TOKEN).closable;
  const b = G.build(OWNER, accs, FEEW, HASH, 5_000_000);
  assert.ok(b.tx.length <= G.TX_LIMIT); assert.equal(b.closed.length, 20);
  const p = parseTx(b.tx);
  assert.equal(p.rest, 0); assert.equal(p.nsig, 1); assert.equal(p.keys[0], OWNER); assert.equal(p.hash, HASH);
  assert.deepEqual(p.header, [1, 0, 3]);                              // token program, system program, reference read-only
  const closes = p.ixs.filter((x) => x.prog === G.TOKEN);
  assert.equal(closes.length, 20);
  for (const x of closes) { assert.deepEqual(x.data, [9]); assert.equal(x.acc[1], OWNER); assert.equal(x.acc[2], OWNER); }
  const t = p.ixs.filter((x) => x.prog === G.SYSTEM);
  assert.equal(t.length, 1); assert.deepEqual(t[0].acc, [OWNER, FEEW, G.REFERENCE]);
  const lam = t[0].data.slice(4).reduce((s, x, i) => s + x * 2 ** (8 * i), 0);
  assert.equal(lam, Math.floor(20 * 2039280 / 10)); assert.equal(lam, b.fee);
  assert.equal(p.ixs.length, 21, "nothing else in the transaction");
  assert.equal(G.build(OWNER, accs.slice(0, 2), FEEW, HASH, 0).fee, 0, "tiny fee into an empty wallet would fail: skipped");
  assert.equal(G.build(OWNER, accs, OWNER, HASH, 5_000_000).fee, 0, "no fee to yourself");
  assert.equal(parseTx(G.build(OWNER, accs.slice(0, 2), FEEW, HASH, 0).tx).ixs.length, 2);
});

const scanOf = (closable, extra = {}) => {
  const byKind = { token: [0, 0], buffer: [0, 0], creator: [0, 0], swap: [0, 0] };
  for (const c of closable) { byKind[c.kind][0]++; byKind[c.kind][1] += c.lamports; }
  return { owner: OWNER, closable, withBalance: 3, skipped: 0, lamports: closable.reduce((s, c) => s + c.lamports, 0), byKind,
           ownerLamports: 50_000_000, rentMin: 650_240, signable: true, ...extra };
};
const BUF = { kind: "buffer", address: G.b58encode(new Uint8Array(32).fill(201)), program: G.LOADER, lamports: 3_000_000_000 };
const VAULT = { kind: "creator", address: G.b58encode(new Uint8Array(32).fill(202)), program: G.PUMP, lamports: 12_000_000_000 };

test("report: per-kind lines, per-tx capped fee, low-balance warning", () => {
  const accs = G.classify(OWNER, Array.from({ length: 25 }, (_, i) => acct(i + 1, {})), G.TOKEN).closable;
  const r = G.report(scanOf(accs), "https://dial.to/x");
  assert.match(r.text, /25 empty token account/); assert.match(r.text, /0\.0510 SOL/); assert.match(r.text, /2 rounds/);
  assert.match(r.button.text, /0\.046 SOL/);
  const big = G.report(scanOf([VAULT, BUF]), "x");
  assert.match(big.text, /creator fees: <b>12\.0000 SOL/); assert.match(big.text, /1 leftover program-deploy buffer/);
  assert.match(big.button.text, /14\.000 SOL/, "fee capped at 1 SOL per transaction");
  assert.doesNotMatch(big.text, /almost no SOL/);
  assert.match(G.report(scanOf([BUF], { ownerLamports: 0 }), "x").text, /almost no SOL/);
  assert.equal(G.report(scanOf([]), "x").button, undefined);
});

test("build: buffer close and creator-fee claim instructions are exact", () => {
  const EV = G.b58encode(new Uint8Array(32).fill(203));
  const b = G.build(OWNER, [VAULT, BUF], FEEW, HASH, 5_000_000, { pumpEv: EV });
  const p = parseTx(b.tx);
  assert.equal(p.rest, 0); assert.equal(p.nsig, 1); assert.equal(p.keys[0], OWNER); assert.equal(p.header[0], 1);
  const claim = p.ixs.find((x) => x.prog === G.PUMP);
  assert.deepEqual(claim.acc, [OWNER, VAULT.address, G.SYSTEM, EV, G.PUMP]);
  assert.deepEqual(claim.data, [20, 22, 86, 123, 198, 28, 219, 132]);
  const close = p.ixs.find((x) => x.prog === G.LOADER);
  assert.deepEqual(close.acc, [BUF.address, OWNER, OWNER]); assert.deepEqual(close.data, [5, 0, 0, 0]);
  assert.equal(b.fee, G.FEE_CAP);
  assert.equal(p.ixs.length, 3, "claim, close, fee - nothing else");
  assert.throws(() => G.build(OWNER, [VAULT], FEEW, HASH, 5_000_000), /event authority/);
});
