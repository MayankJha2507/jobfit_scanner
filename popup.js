// JobFit popup controller.

const els = {
  status: document.getElementById("status"),
  result: document.getElementById("result"),
  error: document.getElementById("error"),
  scoreCircle: document.getElementById("scoreCircle"),
  scoreNum: document.getElementById("scoreNum"),
  verdict: document.getElementById("verdict"),
  meta: document.getElementById("meta"),
  summary: document.getElementById("summary"),
  matchedList: document.getElementById("matchedList"),
  missingList: document.getElementById("missingList"),
  tweaksList: document.getElementById("tweaksList"),
  notes: document.getElementById("notes"),
  quota: document.getElementById("quota"),
  analyzeBtn: document.getElementById("analyzeBtn"),
  reanalyzeBtn: document.getElementById("reanalyzeBtn"),
  settingsBtn: document.getElementById("settingsBtn")
};

let scraped = null; // { text, url, title, usedFallback }
let busy = false; // lock against concurrent/rapid requests

const SUPPORTED = ["linkedin.com", "indeed.com", "wellfound.com"];

function show(el) { el.classList.remove("hidden"); }
function hide(el) { el.classList.add("hidden"); }

function colorFor(score) {
  if (score >= 75) return "green";
  if (score >= 50) return "amber";
  return "red";
}

function setStatus(text) {
  els.status.textContent = text;
  show(els.status);
}

function showError(message) {
  els.error.textContent = message;
  show(els.error);
  hide(els.status);
}

function renderQuota(rateLimit) {
  if (!rateLimit) { els.quota.textContent = ""; return; }
  const parts = [];
  if (rateLimit.remainingRequests != null) parts.push(rateLimit.remainingRequests + " req left");
  if (rateLimit.remainingTokens != null) parts.push(rateLimit.remainingTokens + " tok left");
  els.quota.textContent = parts.length ? "Groq: " + parts.join(" · ") : "";
}

function renderChips(ul, items) {
  ul.innerHTML = "";
  if (!items || !items.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "none";
    ul.appendChild(li);
    return;
  }
  items.forEach((it) => {
    const li = document.createElement("li");
    li.textContent = it;
    ul.appendChild(li);
  });
}

function renderResult(payload) {
  const r = payload.result;
  const color = colorFor(r.fitScore);

  els.scoreNum.textContent = r.fitScore;
  els.scoreCircle.className = "score-circle " + color;
  els.verdict.textContent = r.verdict;
  els.verdict.className = "verdict " + color;

  const bits = [];
  if (payload.cached) bits.push("cached");
  if (payload.analyzedAt) bits.push(new Date(payload.analyzedAt).toLocaleString());
  els.meta.textContent = bits.join(" · ");

  els.summary.textContent = r.summary || "";
  renderChips(els.matchedList, r.matchedSkills);
  renderChips(els.missingList, r.missingSkills);

  els.tweaksList.innerHTML = "";
  (r.resumeTweaks || []).forEach((t) => {
    const li = document.createElement("li");
    li.textContent = t;
    els.tweaksList.appendChild(li);
  });

  const notes = [];
  if (payload.truncated?.resume) notes.push("Resume was truncated to fit limits.");
  if (payload.truncated?.jobDescription) notes.push("Job description was truncated to fit limits.");
  if (scraped?.usedFallback) notes.push("Used fallback text extraction — verify the scraped section.");
  els.notes.textContent = notes.join(" ");

  renderQuota(payload.rateLimit);

  hide(els.status);
  hide(els.error);
  show(els.result);
  hide(els.analyzeBtn);
  show(els.reanalyzeBtn);
}

function friendlyError(resp) {
  switch (resp.errorType) {
    case "no_key":
      return "No Groq API key set. Click Settings to add one.";
    case "no_resume":
      return "No resume saved. Click Settings to paste or upload yours.";
    case "scrape_failed":
      return "Couldn't read a job description from this page. Open a job posting and try again.";
    case "rate_limited":
      return resp.error || "Rate limited by Groq. Wait a moment and retry.";
    case "token_limit":
      return "Token limit exceeded. Your resume or the job post may be too long.";
    case "parse_error":
      return "The model returned an unreadable response. Try Re-analyze.";
    default:
      return resp.error || "Something went wrong. Try again.";
  }
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function scrapeActivePage() {
  const tab = await getActiveTab();
  if (!tab || !tab.id) throw new Error("No active tab.");
  const host = (() => { try { return new URL(tab.url).hostname; } catch { return ""; } })();
  if (!SUPPORTED.some((s) => host.includes(s))) {
    throw new Error("This page isn't a supported job site (LinkedIn, Indeed, Wellfound).");
  }

  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
  const resp = await chrome.tabs.sendMessage(tab.id, { type: "JOBFIT_SCRAPE" });
  if (!resp || !resp.ok) throw new Error("Couldn't read a job description from this page.");
  return resp;
}

async function runAnalyze(force) {
  if (busy) return;
  busy = true;
  els.analyzeBtn.disabled = true;
  els.reanalyzeBtn.disabled = true;
  setStatus(force ? "Analyzing with Groq…" : "Analyzing…");
  hide(els.error);

  try {
    const resp = await chrome.runtime.sendMessage({
      type: "JOBFIT_ANALYZE",
      payload: {
        jobDescription: scraped.text,
        url: scraped.url,
        title: scraped.title,
        force
      }
    });
    if (resp.ok) {
      renderResult(resp);
    } else {
      showError(friendlyError(resp));
      // Keep buttons usable so the user can retry.
      show(els.analyzeBtn);
      if (scraped) els.analyzeBtn.disabled = false;
    }
  } catch (e) {
    showError("Unexpected error: " + String(e.message || e));
  } finally {
    busy = false;
    els.analyzeBtn.disabled = !scraped;
    els.reanalyzeBtn.disabled = false;
  }
}

async function init() {
  els.settingsBtn.addEventListener("click", () => chrome.runtime.openOptionsPage());
  els.analyzeBtn.addEventListener("click", () => runAnalyze(true));
  els.reanalyzeBtn.addEventListener("click", () => runAnalyze(true));

  try {
    scraped = await scrapeActivePage();
  } catch (e) {
    showError(String(e.message || e));
    return;
  }

  els.analyzeBtn.disabled = false;

  // Show cached result if we already analyzed this URL — no API call.
  const cached = await chrome.runtime.sendMessage({ type: "JOBFIT_GET_CACHE", url: scraped.url });
  if (cached && cached.ok) {
    renderResult(cached);
  } else {
    setStatus("Ready. Click Analyze to score this job against your resume.");
  }
}

init();
