"""Claude calls with structured JSON output and cost accounting.

Every call is charged to the treasury as an expense, and refused up front if the
policy budget for today or for the lifetime operating allowance is spent.
"""
import json
import os

try:  # this machine intercepts TLS; trust the Windows store like the browser does
    import truststore
    truststore.inject_into_ssl()
except ImportError:
    pass

import anthropic

MODEL = "claude-opus-5-5"
# $/token, Claude Opus 5.5 first-party pricing (input, output, cache read)
PRICE_IN, PRICE_OUT, PRICE_CACHE_READ = 4.00 / 1e6, 20.00 / 1e6, 0.20 / 1e6
# Conservative upper bound charged against the budget *before* a call is allowed.
MAX_CALL_USD = 0.75   # ~32k output tokens at Opus 5.5 rates + typical input


class BudgetExceeded(Exception):
    pass


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


class LLM:
    def __init__(self, charge, budget_left_usd, effort="high"):
        """charge(usd, note) records the expense; budget_left_usd is today's remaining allowance."""
        self.client = client()
        self.charge = charge
        self.left = budget_left_usd
        self.effort = effort
        self.spent = 0.0

    def call(self, system, prompt, note, tools=None, schema=None, max_tokens=32000, max_continuations=5,
             effort=None):
        """Request with server tools (code execution / web search). Resumes pause_turn.
        Returns the final Message; parsed JSON is in .parsed when a schema is given."""
        if self.left - self.spent < MAX_CALL_USD:
            raise BudgetExceeded(f"${self.left - self.spent:.2f} left today, need ${MAX_CALL_USD}")
        messages = [{"role": "user", "content": prompt}]
        extra = {"output_config": {"effort": effort or self.effort}}
        if schema:
            extra["output_config"]["format"] = {"type": "json_schema", "schema": schema}
        resp = None
        for _ in range(max_continuations + 1):
            with self.client.beta.messages.stream(
                model=MODEL, max_tokens=max_tokens, system=system, messages=messages,
                tools=tools or [], betas=["server-side-fallback-2026-07-01"], fallbacks="default",
                **extra,
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

    def json(self, system, prompt, schema, note, max_tokens=16000):
        if self.left - self.spent < MAX_CALL_USD:
            raise BudgetExceeded(f"${self.left - self.spent:.2f} left today, need ${MAX_CALL_USD}")
        with self.client.beta.messages.stream(
            model=MODEL,
            max_tokens=max_tokens,
            system=system,
            messages=[{"role": "user", "content": prompt}],
            output_config={"effort": self.effort,
                           "format": {"type": "json_schema", "schema": schema}},
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
        ) as stream:
            resp = stream.get_final_message()
        usd = cost_usd(resp.usage)
        self.spent += usd
        self.charge(usd, f"{note} ({resp.model}, {resp.usage.input_tokens}in/{resp.usage.output_tokens}out)")
        if resp.stop_reason == "refusal":
            raise Refused(note)
        if resp.stop_reason == "max_tokens":
            raise ValueError(f"{note}: output truncated at max_tokens")
        text = next(b.text for b in resp.content if b.type == "text")
        return json.loads(text)
