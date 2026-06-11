// JobFit background service worker (MV3, module).
// Owns the Groq API call so requests aren't blocked by page CORS.

const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";
const DEFAULT_MODEL = "llama-3.3-70b-versatile";
const CHAR_BUDGET = 6000; // per-field cap before sending
const MAX_TOKENS = 800; // completion is small JSON
const CACHE_PREFIX = "jobfit_cache_v2_";

function truncate(text, budget = CHAR_BUDGET) {
  const clean = (text || "").trim();
  if (clean.length <= budget) return { text: clean, truncated: false };
  return { text: clean.slice(0, budget), truncated: true };
}

function buildPrompt(resume, jobDescription) {
  return [
    {
      role: "system",
      content:
        "You are a precise technical recruiter. Compare a candidate's resume " +
        "against a job description and assess fit. Respond with STRICT JSON " +
        "only — no prose, no markdown, no code fences. Use exactly this shape:\n" +
        '{"fitScore":1-5,"verdict":"strong fit | partial fit | weak fit",' +
        '"seniorityFit":"underqualified | well-matched | overqualified",' +
        '"seniorityNote":"","matchedSkills":[],"missingSkills":[],' +
        '"resumeTweaks":[],"summary":""}\n' +
        "fitScore is an integer 1 (poor) to 5 (excellent) for SKILLS/DOMAIN " +
        "fit only. verdict must be one of the three exact strings.\n" +
        "seniorityFit compares the candidate's experience LEVEL against the " +
        "level the role targets. Judge by years of experience, scope, and " +
        "title: 'overqualified' means the candidate is more senior than the " +
        "role (e.g. a Senior applying to an Associate/Junior role), " +
        "'underqualified' means the role expects more seniority than the " +
        "resume shows, 'well-matched' means the levels align. seniorityNote " +
        "is one short sentence explaining the level comparison.\n" +
        "matchedSkills/missingSkills/resumeTweaks are short string arrays. " +
        "summary is 1-3 sentences."
    },
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
      seniorityFit: normalizeSeniority(parsed.seniorityFit),
      seniorityNote: typeof parsed.seniorityNote === "string" ? parsed.seniorityNote : "",
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

function normalizeSeniority(s) {
  const v = String(s || "").toLowerCase();
  if (v.includes("over")) return "overqualified";
  if (v.includes("under")) return "underqualified";
  return "well-matched";
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

async function callGroq({ apiKey, model, messages }) {
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
    const res = await fetch(GROQ_ENDPOINT, {
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
          "Rate limited by Groq." +
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
        error: "Groq API error (" + res.status + ")" + (detail ? ": " + detail : "")
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
  const { groqApiKey, groqModel, resume } = await chrome.storage.local.get([
    "groqApiKey",
    "groqModel",
    "resume"
  ]);

  if (!groqApiKey) {
    return { ok: false, errorType: "no_key", error: "No Groq API key set. Open Settings to add one." };
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

  const out = await callGroq({ apiKey: groqApiKey, model: groqModel, messages });
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
