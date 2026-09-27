// JobFit background service worker (MV3, module).
// Owns the Gemini API call so requests aren't blocked by page CORS.
// Uses Gemini's OpenAI-compatible chat-completions endpoint.

const GEMINI_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
const DEFAULT_MODEL = "gemini-3.5-flash-lite"; // lightest, highest availability
const FALLBACK_MODEL = "gemini-3.1-flash-lite"; // tried if primary is 503-overloaded
const CHAR_BUDGET = 4000; // per-field cap before sending (token-thrift)
const MAX_TOKENS = 500; // completion is small JSON
const CACHE_PREFIX = "jobfit_cache_v4_";

// Reduce a job URL to a stable identity so the same posting reuses its
// cached analysis even when tracking/query params change between visits.
function normalizeJobUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const host = u.hostname.replace(/^www\./, "");
    if (host.includes("linkedin.com")) {
      const id =
        u.searchParams.get("currentJobId") ||
        (u.pathname.match(/\/jobs\/view\/(\d+)/) || [])[1];
      if (id) return "linkedin:" + id;
    }
    if (host.includes("indeed.com")) {
      const jk = u.searchParams.get("jk") || u.searchParams.get("vjk");
      if (jk) return "indeed:" + jk;
    }
    // Default: origin + path, dropping query and hash noise.
    return host + u.pathname.replace(/\/+$/, "");
  } catch (_) {
    return rawUrl || "unknown";
  }
}

// Small stable hash (djb2) of the job text, so the cache key is tied to the
// actual description — different postings can never collide, and re-opening
// the same posting still hits the cache.
function hashText(s) {
  let h = 5381;
  const str = (s || "").slice(0, 4000);
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);
}

function cacheKeyFor(url, jobDescription) {
  return CACHE_PREFIX + normalizeJobUrl(url) + ":" + hashText(jobDescription);
}

function truncate(text, budget = CHAR_BUDGET) {
  const clean = (text || "").trim();
  if (clean.length <= budget) return { text: clean, truncated: false };
  return { text: clean.slice(0, budget), truncated: true };
}

const SYSTEM_PROMPT = `You are a strict, calibrated technical recruiter. Assess fit between the RESUME and JOB DESCRIPTION. Be skeptical; avoid grade inflation. Match on substance, not keywords or numbers in the text.

Before scoring:
1. Extract the JD's hard requirements: minimum years of role-specific experience, domain/business model (B2B vs B2C, SaaS vs marketplace, online vs offline), seniority, must-have skills.
2. From the resume's dated titles compute (a) years in the JD's specific discipline — count only roles clearly in that function, excluding unrelated earlier roles even at the same employer — and (b) total career years. If all roles match the discipline, a=b (do NOT penalize). Never treat total tenure as relevant experience; verify any headline number (e.g. "8 years") against the dated roles.
3. Assess domain transfer: cross-domain moves (e.g. B2B SaaS -> consumer marketplace) are real gaps, not keyword matches.
4. List what the candidate LACKS for THIS role and domain.

Caps: role-specific experience below the JD minimum -> fitScore <= 3. Fundamental domain mismatch -> fitScore <= 3. Both -> <= 2. missingSkills may be empty ONLY for a same-domain, same-seniority match; for any cross-domain case you MUST list concrete gaps.

Return STRICT JSON only — no prose, markdown, or code fences. Emit fitScore LAST:
{"roleExperienceYears":number,"totalExperienceYears":number,"experienceGap":"one line or 'none'","domainMatch":"e.g. 'B2B SaaS -> marketplace: weak'","matchedSkills":[],"missingSkills":[],"resumeTweaks":[],"summary":"2-3 sentences","verdict":"strong fit | partial fit | weak fit","fitScore":1-5 integer (1=weak, 3=partial, 5=strong same-domain same-level)}`;

function buildPrompt(resume, jobDescription) {
  return [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content:
        "RESUME:\n" + resume + "\n\n---\n\nJOB DESCRIPTION:\n" + jobDescription
    }
  ];
}

function stripFences(s) {
  let t = (s || "").trim();
  // Remove ```json ... ``` or ``` ... ``` wrappers.
  t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  // If there's still surrounding prose, grab the first {...} block.
  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) {
    t = t.slice(first, last + 1);
  }
  return t.trim();
}

function safeParseResult(content) {
  try {
    const parsed = JSON.parse(stripFences(content));
    return {
      fitScore: clampScore(parsed.fitScore),
      verdict: typeof parsed.verdict === "string" ? parsed.verdict : "partial fit",
      roleExperienceYears: toNum(parsed.roleExperienceYears),
      totalExperienceYears: toNum(parsed.totalExperienceYears),
      experienceGap: typeof parsed.experienceGap === "string" ? parsed.experienceGap : "none",
      domainMatch: typeof parsed.domainMatch === "string" ? parsed.domainMatch : "",
      matchedSkills: asArray(parsed.matchedSkills),
      missingSkills: asArray(parsed.missingSkills),
      resumeTweaks: asArray(parsed.resumeTweaks),
      summary: typeof parsed.summary === "string" ? parsed.summary : ""
    };
  } catch (e) {
    return null;
  }
}

function clampScore(n) {
  const v = Math.round(Number(n));
  if (Number.isNaN(v)) return 1;
  return Math.max(1, Math.min(5, v));
}

function toNum(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v : null;
}

function asArray(a) {
  if (!Array.isArray(a)) return [];
  return a.map((x) => String(x)).filter(Boolean);
}

function readRateLimit(headers) {
  return {
    remainingRequests: headers.get("x-ratelimit-remaining-requests"),
    remainingTokens: headers.get("x-ratelimit-remaining-tokens"),
    limitRequests: headers.get("x-ratelimit-limit-requests"),
    limitTokens: headers.get("x-ratelimit-limit-tokens"),
    retryAfter: headers.get("retry-after")
  };
}

function parseRetryAfter(value) {
  if (!value) return null;
  const secs = Number(value);
  if (!Number.isNaN(secs)) return Math.ceil(secs);
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, Math.ceil((date - Date.now()) / 1000));
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callGemini({ apiKey, model, messages }) {
  const body = JSON.stringify({
    model: model || DEFAULT_MODEL,
    messages,
    max_tokens: MAX_TOKENS,
    temperature: 0.2,
    response_format: { type: "json_object" }
  });

  const maxAttempts = 3; // initial try + retries on 429 / transient 5xx
  let attempt = 0;
  let lastRateLimit = null;

  while (attempt < maxAttempts) {
    attempt++;
    const res = await fetch(GEMINI_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + apiKey
      },
      body
    });

    lastRateLimit = readRateLimit(res.headers);

    if (res.status === 429) {
      const retryAfter = parseRetryAfter(lastRateLimit.retryAfter);
      if (attempt < maxAttempts) {
        // Exponential backoff: honor retry-after, else 2^attempt seconds.
        const waitMs = (retryAfter != null ? retryAfter : Math.pow(2, attempt)) * 1000;
        await sleep(Math.min(waitMs, 30000));
        continue;
      }
      return {
        ok: false,
        errorType: "rate_limited",
        retryAfter,
        rateLimit: lastRateLimit,
        error:
          "Rate limited by Gemini." +
          (retryAfter != null ? " Retry in " + retryAfter + "s." : "")
      };
    }

    // Transient server errors (503 overloaded, 500/502/504) — retry with backoff.
    if (res.status >= 500 && res.status < 600) {
      if (attempt < maxAttempts) {
        await sleep(Math.min(Math.pow(2, attempt) * 1000, 30000));
        continue;
      }
      return {
        ok: false,
        errorType: "server_error",
        rateLimit: lastRateLimit,
        error:
          "Gemini is temporarily unavailable (" + res.status +
          "). The model is usually overloaded — wait a moment and try again."
      };
    }

    if (!res.ok) {
      let detail = "";
      let errorType = "api_error";
      try {
        const errJson = await res.json();
        detail = errJson?.error?.message || "";
        const code = errJson?.error?.code || "";
        if (/token|context|length/i.test(detail) || /context_length|tokens/i.test(code)) {
          errorType = "token_limit";
        }
      } catch (_) {
        detail = await res.text().catch(() => "");
      }
      return {
        ok: false,
        errorType,
        rateLimit: lastRateLimit,
        error: "Gemini API error (" + res.status + ")" + (detail ? ": " + detail : "")
      };
    }

    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content || "";
    const result = safeParseResult(content);
    if (!result) {
      return {
        ok: false,
        errorType: "parse_error",
        rateLimit: lastRateLimit,
        raw: content,
        error: "Could not parse the model's response as JSON."
      };
    }
    return { ok: true, result, rateLimit: lastRateLimit, usage: data.usage || null };
  }

  return {
    ok: false,
    errorType: "api_error",
    rateLimit: lastRateLimit,
    error: "Request failed after retries."
  };
}

async function analyze({ jobDescription, url, title, force }) {
  const { geminiApiKey, geminiModel, resume } = await chrome.storage.local.get([
    "geminiApiKey",
    "geminiModel",
    "resume"
  ]);

  if (!geminiApiKey) {
    return { ok: false, errorType: "no_key", error: "No Gemini API key set. Open Settings to add one." };
  }
  if (!resume || !resume.trim()) {
    return { ok: false, errorType: "no_resume", error: "No resume saved. Open Settings to add yours." };
  }
  if (!jobDescription || jobDescription.trim().length < 80) {
    return { ok: false, errorType: "scrape_failed", error: "Couldn't read a job description from this page." };
  }

  const cacheKey = cacheKeyFor(url, jobDescription);

  if (!force) {
    const cached = await chrome.storage.local.get(cacheKey);
    if (cached[cacheKey]) {
      return { ...cached[cacheKey], ok: true, cached: true };
    }
  }

  const r = truncate(resume);
  const j = truncate(jobDescription);
  const messages = buildPrompt(r.text, j.text);

  const primaryModel = geminiModel || DEFAULT_MODEL;
  let out = await callGemini({ apiKey: geminiApiKey, model: primaryModel, messages });

  // If the chosen model is overloaded (503) even after retries, fall back to a
  // lighter model automatically so a scan can still complete.
  let usedFallbackModel = null;
  if (!out.ok && out.errorType === "server_error" && primaryModel !== FALLBACK_MODEL) {
    const fb = await callGemini({ apiKey: geminiApiKey, model: FALLBACK_MODEL, messages });
    if (fb.ok) {
      out = fb;
      usedFallbackModel = FALLBACK_MODEL;
    }
  }
  if (!out.ok) return out;

  const payload = {
    result: out.result,
    rateLimit: out.rateLimit,
    usage: out.usage,
    usedFallbackModel,
    truncated: { resume: r.truncated, jobDescription: j.truncated },
    url,
    title,
    analyzedAt: Date.now(),
    cached: false
  };

  await chrome.storage.local.set({ [cacheKey]: payload });
  return { ...payload, ok: true };
}

async function getCache(url, jobDescription) {
  const cacheKey = cacheKeyFor(url, jobDescription);
  const cached = await chrome.storage.local.get(cacheKey);
  if (cached[cacheKey]) return { ...cached[cacheKey], ok: true, cached: true };
  return { ok: false, cached: false };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "JOBFIT_ANALYZE") {
    analyze(msg.payload || {})
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, errorType: "api_error", error: String(e) }));
    return true; // async response
  }
  if (msg && msg.type === "JOBFIT_GET_CACHE") {
    getCache(msg.url, msg.jobDescription)
      .then(sendResponse)
      .catch(() => sendResponse({ ok: false, cached: false }));
    return true;
  }
});
