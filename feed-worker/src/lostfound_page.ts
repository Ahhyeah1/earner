// Public Lost & Found checker page (for search traffic: "solana reclaim buffer sol", "recover sol failed deploy",
// "claim pump.fun creator fees"). Paste a wallet -> /lostfound/scan -> one button to the dial.to Blink.
export const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Solana Lost & Found</title>
<meta name="description" content="Find and reclaim forgotten SOL: rent in empty token accounts, leftover program deploy buffers from failed deploys, and unclaimed pump.fun creator fees. One transaction, back to your own wallet.">
<style>
:root{--bg:#f7f7fb;--card:#fff;--fg:#1b1b24;--mut:#6b6b7b;--line:#e4e4ee;--acc:#6c4cf5;--ok:#1a9b5a}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#111118;--card:#1a1a24;--fg:#ececf4;--mut:#9a9aae;--line:#2c2c3a;--acc:#9a82ff;--ok:#3ccf86}}
:root[data-theme="dark"]{--bg:#111118;--card:#1a1a24;--fg:#ececf4;--mut:#9a9aae;--line:#2c2c3a;--acc:#9a82ff;--ok:#3ccf86}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:720px;margin:0 auto;padding:32px 16px 64px}h1{font-size:30px;margin:0 0 6px}p.lead{color:var(--mut);margin:0 0 24px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px;margin-bottom:16px}
form{display:flex;gap:8px;flex-wrap:wrap}input{flex:1 1 260px;min-width:0;padding:12px 14px;border-radius:10px;border:1px solid var(--line);background:var(--bg);color:var(--fg);font:inherit}
button,a.btn{padding:12px 18px;border-radius:10px;border:0;background:var(--acc);color:#fff;font:inherit;font-weight:600;cursor:pointer;text-decoration:none;display:inline-block}
button:disabled{opacity:.6;cursor:wait}.row{display:flex;justify-content:space-between;gap:12px;padding:8px 0;border-bottom:1px solid var(--line)}.row:last-child{border:0}
.big{font-size:28px;font-weight:700;color:var(--ok)}.mut{color:var(--mut);font-size:14px}h2{font-size:18px;margin:0 0 8px}ul{padding-left:20px;margin:6px 0}code{word-break:break-all}
</style></head><body><main>
<h1>🔍 Solana Lost &amp; Found</h1>
<p class="lead">Wallets forget SOL. Paste an address to see what's locked, then get it back to your own wallet in one transaction.</p>
<div class="card"><form id="f"><input id="w" placeholder="Solana wallet address" autocomplete="off" spellcheck="false" aria-label="Wallet address"><button id="go">Check</button></form>
<div id="out" style="margin-top:16px" aria-live="polite"></div></div>
<div class="card"><h2>What it finds</h2><ul>
<li><b>Program deploy buffers</b>: a failed or interrupted <code>solana program deploy</code> leaves a buffer account holding the program's rent, often 1-10 SOL.</li>
<li><b>Unclaimed pump.fun creator fees</b>: trading fees that pile up in the creator's vaults (bonding curve and PumpSwap) until claimed.</li>
<li><b>Empty token accounts</b>: every token you sold or that rugged leaves ~0.002 SOL behind.</li></ul>
<p class="mut">Everything goes back to the connected wallet. Nothing is burned and no tokens move; your wallet shows the exact result before you sign. Fee: 10% of what you reclaim, max 1 SOL per transaction. Prefer the CLI? <code>solana program close --buffers</code> does buffers for free.</p></div>
<p class="mut">Also: <a href="https://t.me/Rug1CheckSolBot">@Rug1CheckSolBot</a> (rug checks) · <a href="/rugs">rug radar</a> · <a href="https://github.com/Ahhyeah1/earner">open source</a></p>
</main><script>
const f=document.getElementById("f"),w=document.getElementById("w"),out=document.getElementById("out"),go=document.getElementById("go");
const sol=(l,d=4)=>(l/1e9).toFixed(d), esc=(s)=>String(s).replace(/[&<>"]/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const label={swap:"Unclaimed PumpSwap creator fees",creator:"Unclaimed pump.fun creator fees",buffer:"Program deploy buffers",token:"Empty token accounts"};
try{const q=new URLSearchParams(location.search).get("wallet");if(q){w.value=q;setTimeout(()=>f.requestSubmit(),0);}}catch(e){}
f.addEventListener("submit",async(e)=>{e.preventDefault();const a=w.value.trim();if(!a)return;go.disabled=true;out.textContent="Scanning…";
 try{const r=await fetch("/lostfound/scan?wallet="+encodeURIComponent(a));const j=await r.json();
  if(!r.ok){out.innerHTML='<p>'+esc(j.error||"Something went wrong")+'</p>';return;}
  if(!j.total){out.innerHTML='<p>Nothing forgotten in this wallet. Clean! 🧹</p>';return;}
  out.innerHTML=Object.entries(j.kinds).filter(([,v])=>v.count).map(([k,v])=>'<div class="row"><span>'+label[k]+' ('+v.count+')</span><b>'+sol(v.lamports)+' SOL</b></div>').join("")
   +'<p>You get back</p><div class="big">'+sol(j.back,4)+' SOL</div>'
   +(j.warning?'<p>⚠️ '+esc(j.warning)+'</p>':'<p style="margin-top:14px"><a class="btn" href="'+esc(j.action)+'" target="_blank" rel="noopener">Reclaim with my wallet →</a></p><p class="mut">Opens dial.to to connect the wallet <code>'+esc(a)+'</code> and sign. '+(j.rounds>1?"Up to 20 items per transaction: "+j.rounds+" rounds.":"")+'</p>');
 }catch(e){out.textContent="Couldn't reach the chain, try again.";}finally{go.disabled=false;}});
</script></body></html>`;
