# JobFit

A Chrome extension (Manifest V3) that scores how well a job posting matches your resume, using the **Groq API** (OpenAI-compatible endpoint). Scrapes the job description from LinkedIn, Indeed, or Wellfound, sends it with your stored resume to a Groq LLM, and shows a fit score, matched/missing skills, and resume tweak suggestions.

No build step — load it unpacked.

## Features

- **One-time resume storage** — paste text or upload `.docx` (parsed with `mammoth`) / `.pdf` (parsed with `pdf.js`). Saved in `chrome.storage.local`.
- **Per-site scraping** — selector map per job site with a largest-visible-text-block fallback when selectors break.
- **Groq scoring** — single call from the background service worker (CORS-safe). Model configurable (default `openai/gpt-oss-120b`).
- **Strict JSON output** — `roleExperienceYears`, `totalExperienceYears`, `experienceGap`, `domainMatch`, `matchedSkills`, `missingSkills`, `resumeTweaks`, `summary`, `verdict`, and `fitScore` (1–5). Parsed safely with code-fence stripping and a fallback.
- **Calibrated, skeptical scoring** — a strict-recruiter prompt that reasons before scoring: it computes *relevant* years (not total tenure), assesses domain transfer (e.g. B2B SaaS → consumer marketplace), and caps the score under hard rules when experience is below the JD minimum or the domain is a fundamental mismatch. The popup surfaces relevant-vs-total years, the domain match, and any experience gap.
- **Rate-limit & usage aware**
  - Inputs truncated to ~6k chars each (UI flags truncation).
  - `max_tokens` capped at 800 since the JSON output is small.
  - Reads Groq's `x-ratelimit-remaining-requests` / `-tokens` headers and shows remaining quota.
  - On HTTP 429, parses `retry-after`, shows a clear message, and auto-retries once with exponential backoff.
  - Analyze button is locked while a request is in flight (no concurrent calls).
  - Results cached per job URL — reopening a posting shows the cached result with **no** API call until you click **Re-analyze**.
- **Clear error states** — missing API key, missing resume, scrape failure, 429 rate limit, token-limit-exceeded, and generic API errors.

## File layout

```
manifest.json        MV3 config: permissions, host perms, service worker, popup, options
background.js        Service worker — Groq call, truncation, rate-limit handling, caching
content.js           Per-site scraper + largest-text-block fallback
popup.html/.css/.js  Result UI (score, verdict, skills, tweaks, quota, Re-analyze)
options.html/.js     Settings — API key, model, resume (textarea + file upload)
vendor/              Bundled mammoth + pdf.js (no CDN at runtime)
icons/               Toolbar icons
```

## Install (load unpacked)

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top-right).
3. Click **Load unpacked** and select this folder.
4. Pin JobFit from the toolbar puzzle-piece menu.

## Setup

1. Right-click the JobFit icon → **Options** (or click **Settings** in the popup).
2. Paste your **Groq API key** (get one at [console.groq.com](https://console.groq.com)).
3. Confirm the **model** (default `openai/gpt-oss-120b`).
4. Paste your **resume** text, or upload a `.docx` / `.pdf` to extract it.
5. Click **Save**.

## Usage

1. Open a job posting on LinkedIn, Indeed, or Wellfound and let the description load.
2. Click the JobFit icon → **Analyze**.
3. Review the fit score, verdict, matched vs. missing skills, resume tweaks, and remaining Groq quota.
4. Reopen the popup on the same job to see the cached result instantly; click **Re-analyze** to force a fresh call.

## Adding a new job site

1. Add a hostname entry with CSS selectors to `SITE_SELECTORS` in `content.js`.
2. Add a matching host permission in `manifest.json`.
3. Reload the extension from `chrome://extensions`.

## Privacy

Your API key, resume, and cached results are stored locally in `chrome.storage.local` on your device. The resume and scraped job text are sent only to Groq's API when you click Analyze.

## Notes

- Job sites change their DOM periodically. If scraping returns the fallback block, update the selectors in `content.js`.
- The vendored `pdf.js` is the ESM build; `options.js` loads as a module and points the worker at `vendor/pdf.worker.min.mjs`.
