"""Gemini backend (Google Generative Language API, generateContent) - the agent's fallback brain.

Standard library only. Structured JSON output, optional Google Search / URL context tools.
Code execution is intentionally NOT offered: the BountyBook verifier relies on Claude's bash
sandbox output format, so sandbox work waits for Claude.
"""
import json
import os
import urllib.error
import urllib.request

API = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
DEFAULT_MODEL = "gemini-3.8-flash"
# Paid-tier $/token (input, output incl. thinking). Free tier costs nothing but has rate limits and
# Google may use free-tier prompts to improve its products.
PRICES = {"gemini-3.8-flash": (0.75e-6, 3.75e-6), "gemini-3.6-flash": (0.75e-6, 3.75e-6),
          "gemini-3.5-flash-lite": (0.30e-6, 2.50e-6), "gemini-4-argon": (2.00e-6, 10.00e-6)}
THINKING = {"low": "low", "medium": "medium", "high": "high", "xhigh": "high", "max": "high"}


class GeminiError(Exception):
    def __init__(self, status, body):
        super().__init__(f"Gemini HTTP {status}: {body[:300]}")
        self.status, self.body = status, body


def configured():
    return bool(os.environ.get("GEMINI_API_KEY"))


def model():
    return os.environ.get("EARNER_GEMINI_MODEL", DEFAULT_MODEL)


def free_tier():
    return os.environ.get("EARNER_GEMINI_TIER", "free").lower() == "free"


def _post(model_id, body, timeout=300):
    req = urllib.request.Request(API.format(model=model_id), data=json.dumps(body).encode(), method="POST",
                                 headers={"Content-Type": "application/json",
                                          "x-goog-api-key": os.environ["GEMINI_API_KEY"]})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        raise GeminiError(e.code, e.read().decode("utf-8", "replace")) from None


GROUNDING_FREE_PER_MONTH = 5000      # Gemini 3+ shared allowance, then $14 per 1,000 grounded prompts
GROUNDING_USD = 14.0 / 1000
_COUNTER = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "gemini_grounding.json")


def grounding_fee(month=None):
    """Count this month's grounded prompts; charge only beyond the free allowance."""
    from datetime import datetime, timezone
    month = month or datetime.now(timezone.utc).strftime("%Y-%m")
    try:
        with open(_COUNTER, encoding="utf-8") as f:
            c = json.load(f)
    except (OSError, ValueError):
        c = {}
    c[month] = c.get(month, 0) + 1
    try:
        os.makedirs(os.path.dirname(_COUNTER), exist_ok=True)
        with open(_COUNTER, "w", encoding="utf-8") as f:
            json.dump(c, f)
    except OSError:
        pass
    return GROUNDING_USD if c[month] > GROUNDING_FREE_PER_MONTH else 0.0


def _strip_json(text):
    """Text -> JSON, tolerating ```json fences or prose around a single object."""
    t = text.strip()
    if t.startswith("```"):
        t = t.split("\n", 1)[1].rsplit("```", 1)[0]
    try:
        return json.loads(t)
    except json.JSONDecodeError:
        a, b = t.find("{"), t.rfind("}")
        if a >= 0 and b > a:
            return json.loads(t[a:b + 1])
        raise


def generate(system, prompt, schema=None, web=False, max_tokens=16000, effort="medium"):
    """Returns dict(text, parsed, model, input_tokens, output_tokens, usd, finish)."""
    m = model()
    gen = {"maxOutputTokens": max_tokens, "thinkingConfig": {"thinkingLevel": THINKING.get(effort, "medium")}}
    body = {"systemInstruction": {"parts": [{"text": system}]},
            "contents": [{"role": "user", "parts": [{"text": prompt}]}], "generationConfig": gen}
    if web:
        body["tools"] = [{"googleSearch": {}}, {"urlContext": {}}]
    if schema:
        gen["responseMimeType"] = "application/json"
        gen["responseJsonSchema"] = schema
    attempts = [body]
    # Graceful degradation if this model/tier rejects an option: drop thinking config, then the
    # schema (keep JSON via instructions), then tools (free tier has no search grounding on 3.x).
    b2 = json.loads(json.dumps(body)); b2["generationConfig"].pop("thinkingConfig", None); attempts.append(b2)
    if schema:
        b3 = json.loads(json.dumps(b2)); b3["generationConfig"].pop("responseJsonSchema", None)
        b3["generationConfig"].pop("responseMimeType", None)
        b3["contents"][0]["parts"][0]["text"] += ("\n\nRespond with ONLY a JSON object matching this JSON Schema:\n"
                                                  + json.dumps(schema))
        attempts.append(b3)
    if web:
        b4 = json.loads(json.dumps(attempts[-1])); b4.pop("tools", None); attempts.append(b4)
    err = None
    for b in attempts:
        try:
            resp = _post(m, b)
            break
        except GeminiError as e:
            err = e
            if e.status != 400:
                raise
    else:
        raise err
    cand = (resp.get("candidates") or [{}])[0]
    finish = cand.get("finishReason", "")
    parts = (cand.get("content") or {}).get("parts") or []
    text = "".join(p.get("text", "") for p in parts if not p.get("thought"))
    u = resp.get("usageMetadata") or {}
    tin = u.get("promptTokenCount", 0) + u.get("toolUsePromptTokenCount", 0)
    tout = u.get("candidatesTokenCount", 0) + u.get("thoughtsTokenCount", 0)
    pin, pout = PRICES.get(m, PRICES[DEFAULT_MODEL])
    usd = 0.0 if free_tier() else tin * pin + tout * pout
    grounded = web and "tools" in b and bool((cand.get("groundingMetadata") or {}).get("webSearchQueries"))
    if grounded and not free_tier():
        usd += grounding_fee()
    parsed = _strip_json(text) if (schema and text) else None
    return {"text": text, "parsed": parsed, "model": m, "input_tokens": tin, "output_tokens": tout,
            "usd": usd, "finish": finish, "blocked": (resp.get("promptFeedback") or {}).get("blockReason")}
