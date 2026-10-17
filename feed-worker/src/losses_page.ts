// Rug Loss Harvester page: paste a wallet -> the browser drives the history scan page by page (each request stays
// within the free Workers CPU budget) -> free preview -> unlock the full CSV with SOL (Blink) or Telegram Stars.
export const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Rug Loss Report</title>
<meta name="description" content="Turn your Solana meme-coin history into a profit & loss report: realized losses and gains per token, dead coins, cost basis in SOL and USD. Free preview.">
<style>
:root{--bg:#f7f7fb;--card:#fff;--fg:#1b1b24;--mut:#6b6b7b;--line:#e4e4ee;--acc:#6c4cf5;--ok:#1a9b5a;--bad:#d64545}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#111118;--card:#1a1a24;--fg:#ececf4;--mut:#9a9aae;--line:#2c2c3a;--acc:#9a82ff;--ok:#3ccf86;--bad:#ff7070}}
:root[data-theme="dark"]{--bg:#111118;--card:#1a1a24;--fg:#ececf4;--mut:#9a9aae;--line:#2c2c3a;--acc:#9a82ff;--ok:#3ccf86;--bad:#ff7070}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:760px;margin:0 auto;padding:32px 16px 64px}h1{font-size:30px;margin:0 0 6px}.lead{color:var(--mut);margin:0 0 22px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px;margin-bottom:16px}
form{display:flex;gap:8px;flex-wrap:wrap}input{flex:1 1 260px;min-width:0;padding:12px 14px;border-radius:10px;border:1px solid var(--line);background:var(--bg);color:var(--fg);font:inherit}
button,a.btn{padding:12px 18px;border-radius:10px;border:0;background:var(--acc);color:#fff;font:inherit;font-weight:600;cursor:pointer;text-decoration:none;display:inline-block}
a.btn.alt{background:transparent;color:var(--acc);border:1px solid var(--acc)}button:disabled{opacity:.6;cursor:wait}
.bar{height:8px;background:var(--line);border-radius:6px;overflow:hidden;margin:12px 0 6px}.bar i{display:block;height:100%;width:0;background:var(--acc);transition:width .3s}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}.stat b{display:block;font-size:24px}.neg{color:var(--bad)}.pos{color:var(--ok)}
.mut{color:var(--mut);font-size:14px}.row{display:flex;justify-content:space-between;gap:12px;padding:7px 0;border-bottom:1px solid var(--line)}.row:last-child{border:0}
.btns{display:flex;gap:10px;flex-wrap:wrap;margin-top:12px}code{word-break:break-all}
</style></head><body><main>
<h1>🧾 Rug Loss Report</h1>
<p class="lead">Paste a Solana wallet. Get every meme coin you traded as a profit &amp; loss line: what you paid, what you got back, realized losses and gains, and coins that are now dead. Free preview; the full CSV is $19.</p>
<div class="card"><form id="f"><input id="w" placeholder="Solana wallet address" autocomplete="off" spellcheck="false" aria-label="Wallet address"><button id="go">Analyse</button></form>
<div id="prog" hidden><div class="bar"><i id="barfill"></i></div><div class="mut" id="ptext">Starting…</div></div></div>
<div id="out" aria-live="polite"></div>
<div class="card mut">How it works: we read the wallet's swaps (pump.fun, PumpSwap, Jupiter and more) where SOL is on one side, value each in USD at that day's SOL price, and use the average-cost method per token. Covers up to your ~2,000 most recent swaps. Dead coins are tokens you still hold that are worth under 2% of what you paid. <b>This is a data report, not tax advice</b>: rules differ by country, so check with a tax professional. Tokens that were never sold or disposed of usually aren't a realized loss yet.</div>
<p class="mut">Also: <a href="/lostfound">Lost &amp; Found</a> (reclaim SOL from dead token accounts) · <a href="https://t.me/Rug1CheckSolBot">rug checks</a> · <a href="https://github.com/Ahhyeah1/earner">open source</a></p>
</main><script>
const $=(id)=>document.getElementById(id), esc=(s)=>String(s).replace(/[&<>"]/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const usd=(n)=>(n<0?"-":"")+"$"+Math.abs(Math.round(n)).toLocaleString("en-US");
const sleep=(ms)=>new Promise((r)=>setTimeout(r,ms));
let job=null;
try{const sp=new URLSearchParams(location.search);if(sp.get("job")){job=sp.get("job");setTimeout(()=>result(),0);}else if(sp.get("wallet")){$("w").value=sp.get("wallet");setTimeout(()=>$("f").requestSubmit(),0);}}catch(e){}
$("f").addEventListener("submit",async(e)=>{e.preventDefault();const wallet=$("w").value.trim();if(!wallet)return;
 $("go").disabled=true;$("prog").hidden=false;$("out").innerHTML="";
 try{const s=await (await fetch("/losses/start",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({wallet})})).json();
  if(s.error){$("ptext").textContent=s.error;return;} job=s.job;
  try{history.replaceState(null,"","?job="+job);}catch(e){}
  for(let i=0;i<120;i++){const r=await (await fetch("/losses/step",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({job})})).json();
   if(r.error){$("ptext").textContent=r.error;return;} if(r.retry){await sleep(1500);continue;}
   $("barfill").style.width=Math.min(100,r.pages/80*100)+"%";
   $("ptext").textContent=r.swaps+" swaps across "+r.tokens+" tokens"+(r.oldest?" · back to "+new Date(r.oldest*1000).toISOString().slice(0,10):"");
   if(r.done)break;}
  $("barfill").style.width="100%";$("ptext").textContent="Pricing tokens…";await result();
 }catch(e){$("ptext").textContent="Something went wrong, try again.";}finally{$("go").disabled=false;}});
async function result(){
 const r=await (await fetch("/losses/result?job="+job)).json();
 if(r.error){$("out").innerHTML='<div class="card">'+esc(r.error)+'</div>';return;}
 $("prog").hidden=true;
 const t=r.totals, y=r.totalsYear;
 let h='<div class="card"><div class="mut">Wallet <code>'+esc(r.wallet)+'</code> · '+r.swaps+' swaps'+(r.oldest?' since '+new Date(r.oldest*1000).toISOString().slice(0,10):'')+(r.capped?' (most recent only)':'')+'</div>'
  +'<div class="grid" style="margin-top:12px"><div class="stat"><span class="mut">Realized losses</span><b class="neg">'+usd(t.realizedLossUsd)+'</b></div>'
  +'<div class="stat"><span class="mut">Realized gains</span><b class="pos">'+usd(t.realizedGainUsd)+'</b></div>'
  +'<div class="stat"><span class="mut">Dead coins held</span><b>'+t.deadCount+'</b><span class="mut">'+usd(t.deadLossUsd)+' paper loss</span></div>'
  +'<div class="stat"><span class="mut">'+r.year+' realized net</span><b class="'+(y.realizedGainUsd+y.realizedLossUsd<0?'neg':'pos')+'">'+usd(y.realizedGainUsd+y.realizedLossUsd)+'</b></div></div></div>';
 h+='<div class="card"><b>Biggest losers</b>'+r.top.map((x)=>'<div class="row"><span>$'+esc(x.symbol)+' <span class="mut">'+x.status+'</span></span><b class="neg">'+usd(x.pnlUsd)+'</b></div>').join("")
  +'<div class="mut" style="margin-top:8px">+ '+Math.max(0,r.rowCount-3)+' more tokens in the full report</div></div>';
 if(r.paid){h+='<div class="card"><b>Unlocked ✅</b><div class="btns"><a class="btn" href="/losses/csv?job='+job+'">Download CSV</a></div></div>';}
 else{h+='<div class="card"><b>Full report: every token, cost basis, dates, CSV for your tax tool</b><div class="btns">'
  +'<a class="btn" href="'+esc(r.payAction)+'" target="_blank" rel="noopener">Pay $'+r.priceUsd+' in SOL →</a>'
  +'<a class="btn alt" href="'+esc(r.payStars)+'" target="_blank" rel="noopener">Pay '+r.priceStars+' ⭐ in Telegram</a></div>'
  +'<p class="mut" id="paystate">After paying in SOL, keep this page open: it unlocks automatically. Telegram payments get the CSV in the chat.</p></div>';
  pollPaid();}
 if(r.deadMints&&r.deadMints.length){h+='<div class="card"><b>🪦 Bury '+r.deadMints.length+' dead coin'+(r.deadMints.length>1?'s':'')+'</b><p class="mut">Coins you still hold that are essentially worthless. You can clean them up and reclaim their SOL deposits with <a href="/lostfound?wallet='+esc(r.wallet)+'">Lost &amp; Found</a>.</p></div>';}
 $("out").innerHTML=h;}
async function pollPaid(){for(let i=0;i<120;i++){await sleep(5000);try{const p=await (await fetch("/losses/check?job="+job)).json();if(p.paid){const el=$("paystate");if(el)el.innerHTML='Paid ✅ <a class="btn" href="/losses/csv?job='+job+'">Download CSV</a>';return;}}catch(e){}}}
</script></body></html>`;
