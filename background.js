// JobFit background service worker (MV3, module).
// Owns the Gemini API call so requests aren't blocked by page CORS.
// Uses Gemini's OpenAI-compatible chat-completions endpoint.

const GEMINI_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
const DEFAULT_MODEL = "gemini-3.7-flash";
const CHAR_BUDGET = 6000; // per-field cap before sending
const MAX_TOKENS = 800; // completion is small JSON
const CACHE_PREFIX = "jobfit_cache_v3_";

function truncate(text, budget = CHAR_BUDGET) {
  const clean = (text || "").trim();
  if (clean.length <= budget) return { text: clean, truncated: false };
  return { text: clean.slice(0, budget), truncated: true };
}

const SYSTEM_PROMPT = `You are a strict, calibrated technical recruiter. Analyze the fit between the RESUME and JOB DESCRIPTION provided. Be skeptical and avoid grade inflation. Match on substance, not on keywords or numbers appearing in the text.

Reason step by step BEFORE scoring:
1. Extract the JD's hard requirements: years of role-specific experience, domain/business model (e.g. B2B vs B2C, SaaS vs marketplace, online vs offline fulfillment), seniority level, and must-have skills.
2. From the resume's employment DATES and titles, compute two numbers: (a) years of experience in the specific discipline/seniority the JD requires, and (b) total career years. To get (a), count only roles whose title or responsibilities clearly fall within the JD's target discipline; exclude earlier roles in a different function, even at the same employer. If every role matches the discipline, (a) and (b) will be equal — that is expected and must NOT be penalized. Never assume total tenure equals relevant experience, and never take a summary's headline number (e.g. "8 years") at face value — always verify it against the dated roles.
3. Assess domain transfer explicitly. Cross-domain moves (e.g. B2B SaaS -> consumer marketplace, online -> offline fulfillment) are significant gaps, not keyword matches.
4. List the skills and experiences the candidate LACKS for THIS specific role and domain.

Hard rules:
- If role-specific experience is below the JD's stated minimum, fitScore is at most 3.
- If the business model/domain is a fundamental mismatch, fitScore is at most 3.
- If both are true, fitScore is at most 2.
- missingSkills may only be empty for a same-domain, same-seniority match. For any cross-domain application you MUST list concrete gaps.

Return STRICT JSON only — no preamble, no markdown, no code fences. Emit the analytical fields first and fitScore LAST, so the score follows from the analysis:
{
  "roleExperienceYears": number,
  "totalExperienceYears": number,
  "experienceGap": "one-line description of any gap, or 'none'",
  "domainMatch": "e.g. 'B2B SaaS -> consumer marketplace: weak'",
  "matchedSkills": [],
  "missingSkills": [],
  "resumeTweaks": [],
  "summary": "2-3 sentences",
  "verdict": "strong fit | partial fit | weak fit",
  "fitScore": 1-5 integer (1 = weak/irrelevant, 3 = partial, 5 = strong same-domain same-level match)
}`;

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

  const maxAttempts = 2; // initial try + one retry on 429
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

  const cacheKey = CACHE_PREFIX + (url || "unknown");

  if (!force) {
    const cached = await chrome.storage.local.get(cacheKey);
    if (cached[cacheKey]) {
      return { ...cached[cacheKey], ok: true, cached: true };
    }
  }

  const r = truncate(resume);
  const j = truncate(jobDescription);
  const messages = buildPrompt(r.text, j.text);

  const out = await callGemini({ apiKey: geminiApiKey, model: geminiModel, messages });
  if (!out.ok) return out;

  const payload = {
    result: out.result,
    rateLimit: out.rateLimit,
    usage: out.usage,
    truncated: { resume: r.truncated, jobDescription: j.truncated },
    url,
    title,
    analyzedAt: Date.now(),
    cached: false
  };

  await chrome.storage.local.set({ [cacheKey]: payload });
  return { ...payload, ok: true };
}

async function getCache(url) {
  const cacheKey = CACHE_PREFIX + (url || "unknown");
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
    getCache(msg.url)
      .then(sendResponse)
      .catch(() => sendResponse({ ok: false, cached: false }));
    return true;
  }
});
