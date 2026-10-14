// Grant-application service: public landing page + intake form. Intakes go to KV; the local agent
// pulls them, drafts the application and notifies the owner. Personal data is kept to a minimum and
// expires automatically (GDPR: purpose-limited, 90-day retention).
const PRICE = "149";
const TTL = 60 * 60 * 24 * 90;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

const FIELDS: [string, string, string, boolean][] = [
  ["project", "Project name", "text", true],
  ["contact", "How do we reach you? (email, X or Telegram handle)", "text", true],
  ["url", "Website, repo or demo link", "text", true],
  ["what", "What are you building, and for whom?", "textarea", true],
  ["stage", "Stage and traction (devnet/mainnet, users, revenue, hackathon results)", "textarea", false],
  ["country", "Where is the team based? (regional Solana grants depend on it)", "text", false],
  ["ask", "How much funding, and what would you spend it on?", "textarea", false],
  ["program", "A specific grant you're targeting? (optional)", "text", false],
  ["deadline", "Any deadline?", "text", false],
];

export function landing(): string {
  const field = ([id, label, type, req]: typeof FIELDS[number]) =>
    `<label>${esc(label)}${req ? " *" : ""}${type === "textarea"
      ? `<textarea name="${id}" rows="3" maxlength="1500"${req ? " required" : ""}></textarea>`
      : `<input name="${id}" maxlength="300"${req ? " required" : ""}>`}</label>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Grant applications for Solana teams</title>
<style>
:root{--ink:#1f1838;--muted:#6b6385;--accent:#7c5cff;--bg:#fbf8ff;--card:#fff}
@media (prefers-color-scheme:dark){:root{--ink:#f2eeff;--muted:#a59cc4;--bg:#130e26;--card:#1d1638}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:760px;margin:0 auto;padding:32px 16px 64px}h1{font-size:30px;line-height:1.2;margin:0 0 8px}
.lead{color:var(--muted);font-size:18px}.card{background:var(--card);border-radius:18px;padding:20px;margin:18px 0;box-shadow:0 6px 24px rgba(90,60,170,.10)}
ul{padding-left:20px}label{display:block;font-weight:600;font-size:14px;margin:12px 0}
input,textarea{display:block;width:100%;margin-top:4px;padding:10px 12px;border-radius:10px;border:1px solid rgba(120,100,180,.3);background:transparent;color:var(--ink);font:inherit}
button{margin-top:14px;padding:12px 22px;border:0;border-radius:999px;background:linear-gradient(135deg,#7c5cff,#ff7eb6);color:#fff;font:600 16px system-ui;cursor:pointer}
.price{font-size:26px;font-weight:800}.small{font-size:13px;color:var(--muted)}.hp{position:absolute;left:-5000px}
</style></head><body><main>
<h1>Grant applications for Solana teams</h1>
<p class="lead">You build. We turn your project into a clear, complete grant application for the right program: Solana Foundation, Superteam regional grants, ecosystem funds.</p>
<div class="card"><div class="price">$${PRICE} per application</div>
<ul><li>We match you to programs you're actually eligible for (many are regional).</li>
<li>Full draft written to the program's criteria: problem, solution, milestones, budget, KPIs.</li>
<li>A list of exact gaps to fill, so nothing gets bounced for missing info.</li>
<li>Reviewed by a human before it reaches you. Drafted with AI help.</li></ul>
<p class="small">You submit the application yourself under your team's name. Approval is decided by the grant program and is never guaranteed. Paid in USDC on Solana, only after we confirm we can help.</p></div>
<form class="card" method="post" action="/grants/intake">
<h2 style="margin-top:0">Tell us about your project</h2>
${FIELDS.map(field).join("\n")}
<label class="hp">Leave empty<input name="website2" tabindex="-1" autocomplete="off"></label>
<label style="font-weight:400"><input type="checkbox" name="consent" required style="display:inline;width:auto"> I agree that you store these details for up to 90 days only to prepare my application.</label>
<button type="submit">Send — free assessment</button>
<p class="small">No payment now. We reply with which grants fit and a payment link only if we can help.</p>
</form>
<p class="small">Privacy: we store only what you enter here, solely to prepare your application, and delete it automatically after 90 days. Ask for deletion any time via the contact you gave us.</p>
</main></body></html>`;
}

export async function intake(req: Request, kv: KVNamespace): Promise<Response> {
  const f = await req.formData();
  if ((f.get("website2") as string) || !f.get("consent")) return thanks();          // bots: silently accept
  const data: Record<string, string> = {};
  for (const [id, , , req2] of FIELDS) {
    const v = String(f.get(id) ?? "").trim().slice(0, 1500);
    if (req2 && !v) return new Response("Missing: " + id, { status: 400 });
    data[id] = v;
  }
  const key = `intake:${Date.now()}:${crypto.randomUUID().slice(0, 8)}`;
  await kv.put(key, JSON.stringify({ ...data, received_at: new Date().toISOString() }), { expirationTtl: TTL });
  return thanks();
}

function thanks(): Response {
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Thanks</title><body style="font:17px/1.6 system-ui;max-width:640px;margin:60px auto;padding:0 16px">
<h1>Thanks — we've got it.</h1><p>We'll reply within 48 hours with which grants fit your project and how we can help. No payment until then.</p>
<p><a href="/grants">← Back</a></p></body>`, { headers: { "content-type": "text/html; charset=utf-8" } });
}
