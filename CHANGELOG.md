# Changelog

## Model changes

### `gemini-3.5-flash-lite` (current default)
**Changed because** heavier flash-tier models (e.g. `gemini-3.7-flash`) get
overloaded on the Gemini free tier and returned persistent **HTTP 503
("model overloaded")** on nearly every scan — this is Google's capacity
throttling on free-tier traffic, not a rate limit (429) or a bug.

Google recommends the **flash-lite** models for new projects precisely because
they have far more capacity headroom. So the default was switched to
`gemini-3.5-flash-lite` (lightest, highest availability, cheapest), which is
also a good fit here since the task only produces a small JSON result.

To make scans resilient even when the chosen model is busy, the extension now
**auto-falls back to `gemini-3.1-flash-lite`** if the configured model still
returns 503 after its retries. The popup notes when a fallback model was used.

### `gemini-3.7-flash` (previous)
Superseded — overloaded too often on the free tier (503s).

### `gemini-2.5-flash` (earlier)
Superseded by newer Gemini releases; returned **404** as it aged out.

### `openai/gpt-oss-120b` (Groq era)
Used briefly after Groq deprecated `llama-3.3-70b-versatile` on 2026-06-17.
The extension later moved off Groq entirely to the Gemini API.

### `llama-3.3-70b-versatile` (original, Groq)
The initial model. Deprecated by Groq on 2026-06-17.

## Notes
- The model is configurable in the extension's Settings page.
- If a model 404s or 503s, list what your key can access:
  `curl -s https://generativelanguage.googleapis.com/v1beta/openai/models -H "Authorization: Bearer YOUR_GEMINI_KEY" | grep '"id"'`
- A billing-enabled Gemini key largely removes the free-tier 503 overloads.
