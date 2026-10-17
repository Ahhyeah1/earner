"""AI calls with structured JSON output, cost accounting, and provider failover.

Claude (Opus) is the primary brain; Gemini is the fallback when Claude is unavailable (credits
used up, billing/auth problems, rate limits, outages). Every call is charged to the treasury with
the model that actually answered, and refused up front if the policy budget is spent.
"""
import json
import os
from types import SimpleNamespace

try:  # this machine intercepts TLS; trust the Windows store like the browser does
    import truststore
    truststore.inject_into_ssl()
except ImportError:
    pass

import anthropic

from . import gemini

MODEL = "claude-opus-5-5"
# $/token, Claude Opus 5.5 first-party pricing (input, output, cache read)
PRICE_IN, PRICE_OUT, PRICE_CACHE_READ = 4.00 / 1e6, 20.00 / 1e6, 0.20 / 1e6
# Conservative upper bound charged against the budget *before* a call is allowed.
MAX_CALL_USD = 0.75   # ~32k output tokens at Opus 5.5 rates + typical input


class BudgetExceeded(Exception):
    pass


class NoProvider(BudgetExceeded):
    """No AI provider can take this call right now (workers stop for the cycle, like a spent budget)."""


class Refused(Exception):
    pass


def client():
    # Keys not scoped to a workspace must name one on every request.
    ws = os.environ.get("ANTHROPIC_WORKSPACE_ID")
    return anthropic.Anthropic(default_headers={"anthropic-workspace-id": ws} if ws else None)


def cost_usd(usage):
    cached = getattr(usage, "cache_read_input_tokens", 0) or 0
    return (usage.input_tokens * PRICE_IN + usage.output_tokens * PRICE_OUT
            + cached * PRICE_CACHE_READ)


def available():
    return bool(os.environ.get("ANTHROPIC_API_KEY")) or gemini.configured()


def claude_outage(e):
    """Errors that mean 'Claude can't serve us right now' (fail over) vs. a real problem with the request."""
    if isinstance(e, (anthropic.AuthenticationError, anthropic.PermissionDeniedError, anthropic.RateLimitError,
                      anthropic.APIConnectionError, anthropic.InternalServerError)):
        return True
    msg = str(e).lower()
    return isinstance(e, anthropic.APIStatusError) and (
        "credit balance" in msg or "billing" in msg or getattr(e, "status_code", 0) in (402, 429, 529)
        or getattr(e, "status_code", 0) >= 500)


class LLM:
    def __init__(self, charge, budget_left_usd, effort="high"):
        """charge(usd, note) records the expense; budget_left_usd is today's remaining allowance."""
        self.charge = charge
        self.left = budget_left_usd
        self.effort = effort
        self.spent = 0.0
        self.order = [p.strip() for p in os.environ.get("EARNER_LLM_ORDER", "claude,gemini").split(",") if p.strip()]
        self.down = {}            # provider -> reason, for the rest of this cycle
        self.used = set()         # providers that actually answered
        self._claude = None

    # ------------------------------------------------------------------ routing
    def _providers(self, needs_sandbox):
        for p in self.order:
            if p in self.down:
                continue
            if p == "claude" and os.environ.get("ANTHROPIC_API_KEY"):
                yield p
            elif p == "gemini" and gemini.configured() and not needs_sandbox:
                yield p

    def call(self, system, prompt, note, tools=None, schema=None, max_tokens=32000, max_continuations=5,
             effort=None):
        """One request, routed to the first healthy provider. Returns an object with .parsed (when a
        schema is given), .content (Claude blocks; empty for Gemini) and .model."""
        if self.left - self.spent < MAX_CALL_USD:
            raise BudgetExceeded(f"${self.left - self.spent:.2f} left today, need ${MAX_CALL_USD}")
        tools = tools or []
        needs_sandbox = any(str(t.get("type", "")).startswith("code_execution") for t in tools)
        web = any(str(t.get("type", "")).startswith(("web_search", "web_fetch")) for t in tools)
        last = None
        for p in self._providers(needs_sandbox):
            try:
                if p == "claude":
                    resp = self._claude_call(system, prompt, note, tools, schema, max_tokens, max_continuations,
                                             effort or self.effort)
                else:
                    resp = self._gemini_call(system, prompt, note, schema, web, max_tokens, effort or self.effort)
                self.used.add(p)
                return resp
            except anthropic.APIError as e:
                if not claude_outage(e):
                    raise
                self.down["claude"], last = str(e)[:300], e
            except gemini.GeminiError as e:
                if e.status not in (401, 403, 429, 500, 503):
                    raise
                self.down["gemini"], last = str(e)[:300], e
        why = "this step needs Claude's code sandbox" if needs_sandbox and gemini.configured() else "no provider left"
        raise NoProvider(f"{note}: {why}" + (f" (last error: {last})" if last else ""))

    def run_python(self, code, note):
        """Execute code in Gemini's sandbox (used when Claude's sandbox is unavailable). Charged like any call."""
        if self.left - self.spent < 0.05:
            raise BudgetExceeded(f"${self.left - self.spent:.2f} left today")
        if not gemini.configured():
            raise NoProvider(f"{note}: no Python sandbox available")
        r = gemini.run_python(code)
        self.spent += r["usd"]
        self.charge(r["usd"], f"{note} ({r['model']} code execution)")
        self.used.add("gemini")
        return r

    def json(self, system, prompt, schema, note, max_tokens=16000):
        return self.call(system, prompt, note, schema=schema, max_tokens=max_tokens).parsed

    # ------------------------------------------------------------------ providers
    def _claude_call(self, system, prompt, note, tools, schema, max_tokens, max_continuations, effort):
        if self._claude is None:
            self._claude = client()
        messages = [{"role": "user", "content": prompt}]
        extra = {"output_config": {"effort": effort}}
        if schema:
            extra["output_config"]["format"] = {"type": "json_schema", "schema": schema}
        resp = None
        for _ in range(max_continuations + 1):
            with self._claude.beta.messages.stream(
                model=MODEL, max_tokens=max_tokens, system=system, messages=messages,
                tools=tools, betas=["server-side-fallback-2026-07-01"], fallbacks="default", **extra,
            ) as stream:
                resp = stream.get_final_message()
            usd = cost_usd(resp.usage)
            self.spent += usd
            self.charge(usd, f"{note} ({resp.model}, {resp.usage.input_tokens}in/{resp.usage.output_tokens}out)")
            if resp.stop_reason != "pause_turn":
                break
            messages = [messages[0], {"role": "assistant", "content": resp.content}]
        if resp.stop_reason == "refusal":
            raise Refused(note)
        if resp.stop_reason == "max_tokens":
            raise ValueError(f"{note}: output truncated at max_tokens")
        resp.parsed = None
        if schema:
            texts = [b.text for b in resp.content if b.type == "text"]
            resp.parsed = json.loads(texts[-1]) if texts else None
        return resp

    def _gemini_call(self, system, prompt, note, schema, web, max_tokens, effort):
        r = gemini.generate(system, prompt, schema=schema, web=web, max_tokens=max_tokens, effort=effort)
        self.spent += r["usd"]
        tier = "free tier" if gemini.free_tier() else "paid"
        self.charge(r["usd"], f"{note} ({r['model']} fallback, {tier}, {r['input_tokens']}in/{r['output_tokens']}out)")
        if r["blocked"] or r["finish"] in ("SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII"):
            raise Refused(note)
        if r["finish"] == "MAX_TOKENS":
            raise ValueError(f"{note}: output truncated at max_tokens")
        if schema and r["parsed"] is None:
            raise ValueError(f"{note}: Gemini returned no JSON")
        return SimpleNamespace(parsed=r["parsed"], content=[], model=r["model"], stop_reason=r["finish"],
                               text=r["text"])
