// JobFit popup controller.

const els = {
  status: document.getElementById("status"),
  result: document.getElementById("result"),
  error: document.getElementById("error"),
  recommend: document.getElementById("recommend"),
  recommendTitle: document.getElementById("recommendTitle"),
  recommendSub: document.getElementById("recommendSub"),
  scoreCircle: document.getElementById("scoreCircle"),
  scoreNum: document.getElementById("scoreNum"),
  verdict: document.getElementById("verdict"),
  seniority: document.getElementById("seniority"),
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

// Score is 1-5 (skills/domain fit).
function colorFor(score) {
  if (score >= 4) return "green";
  if (score >= 3) return "amber";
  return "red";
}

// Apply recommendation combines skills fit (1-5) with seniority alignment,
// so an overqualified candidate isn't told to apply to a junior role.
function recommendation(score, seniority) {
  if (seniority === "overqualified") {
    return {
      title: "You may be over-leveled",
      sub: "Your experience exceeds this role — apply only if a step down or a change of focus appeals to you.",
      cls: "amber"
    };
  }
  if (seniority === "underqualified") {
    if (score >= 4) {
      return {
        title: "A reach on experience",
        sub: "Skills line up, but the role expects more seniority than your resume shows.",
        cls: "amber"
      };
    }
    return {
      title: "Likely too senior a role",
      sub: "This role expects more experience than your resume demonstrates.",
      cls: "red"
    };
  }
  // Levels align — go by skills fit.
  if (score >= 5) {
    return { title: "Apply — you'd be a top applicant", sub: "Strong match on skills and level.", cls: "green" };
  }
  if (score >= 4) {
    return { title: "Worth applying", sub: "Good match — tailor your resume to the gaps first.", cls: "green" };
  }
  if (score >= 3) {
    return { title: "Apply if you're interested", sub: "Partial match — close the missing skills to stand out.", cls: "amber" };
  }
  if (score >= 2) {
    return { title: "A stretch — apply only if keen", sub: "Several key requirements aren't covered by your resume.", cls: "amber" };
  }
  return { title: "Probably skip this one", sub: "Weak match on the core requirements.", cls: "red" };
}

const SENIORITY_LABEL = {
  overqualified: { text: "Over-leveled for this role", cls: "over" },
  underqualified: { text: "Below this role's level", cls: "under" },
  "well-matched": { text: "Level matches", cls: "match" }
};

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

  const rec = recommendation(r.fitScore, r.seniorityFit);
  els.recommend.className = "recommend " + rec.cls;
  els.recommendTitle.textContent = rec.title;
  els.recommendSub.textContent = rec.sub;

  els.scoreNum.textContent = r.fitScore;
  els.scoreCircle.className = "score-circle " + color;
  els.verdict.textContent = r.verdict;
  els.verdict.className = "verdict " + color;

  const sen = SENIORITY_LABEL[r.seniorityFit];
  if (sen) {
    els.seniority.textContent = r.seniorityNote ? sen.text + " — " + r.seniorityNote : sen.text;
    els.seniority.className = "seniority " + sen.cls;
  } else {
    els.seniority.className = "seniority hidden";
  }

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
    if (scraped.pageTheme === "light" || scraped.pageTheme === "dark") {
      document.documentElement.setAttribute("data-theme", scraped.pageTheme);
    }
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
