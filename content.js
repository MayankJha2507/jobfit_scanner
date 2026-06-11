// JobFit content script — scrapes the job description from the active page.
// Injected on demand via chrome.scripting.executeScript. Guards against
// duplicate listener registration when re-injected into the same page.
(() => {
  if (window.__jobfitInjected) return;
  window.__jobfitInjected = true;

  // Per-site selector map. Add new sites by adding an entry here.
  // Each value is an ordered list of CSS selectors tried in turn.
  const SITE_SELECTORS = {
    "linkedin.com": [
      ".jobs-description__content",
      ".jobs-description-content__text",
      "#job-details",
      ".jobs-box__html-content",
      "article.jobs-description__container",
      ".description__text"
    ],
    "indeed.com": [
      "#jobDescriptionText",
      ".jobsearch-JobComponent-description",
      ".jobsearch-BodyContainer"
    ],
    "wellfound.com": [
      "[class*='JobDescription']",
      "[data-test='JobDescription']",
      "section[class*='description']"
    ]
  };

  function siteKey() {
    const host = location.hostname;
    return Object.keys(SITE_SELECTORS).find((k) => host.includes(k)) || null;
  }

  function cleanText(raw) {
    if (!raw) return "";
    return raw
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .split("\n")
      .map((l) => l.trim())
      .filter((l, i, arr) => l.length > 0 || (arr[i - 1] && arr[i - 1].length > 0))
      .join("\n")
      .trim();
  }

  function isVisible(el) {
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  // Fallback: walk candidate containers and pick the one with the most
  // visible text, ignoring nav/header/footer/script-heavy nodes.
  function largestVisibleTextBlock() {
    const candidates = document.querySelectorAll(
      "article, section, main, div[class*='description'], div[class*='content'], div"
    );
    let best = null;
    let bestLen = 0;
    candidates.forEach((el) => {
      if (!isVisible(el)) return;
      if (el.closest("nav, header, footer, aside")) return;
      // Skip containers that are mostly other block children (too generic).
      const text = (el.innerText || "").trim();
      if (text.length < 200) return;
      // Prefer nodes whose own text density is high.
      const childTextLen = Array.from(el.children).reduce(
        (sum, c) => sum + ((c.innerText || "").length),
        0
      );
      const ownLen = text.length - childTextLen;
      const score = text.length + ownLen; // bias toward leaf-ish text blocks
      if (score > bestLen) {
        bestLen = score;
        best = el;
      }
    });
    return best ? cleanText(best.innerText) : "";
  }

  function scrape() {
    const key = siteKey();
    let text = "";
    let usedFallback = false;
    let matchedSelector = null;

    if (key) {
      for (const sel of SITE_SELECTORS[key]) {
        const el = document.querySelector(sel);
        if (el && isVisible(el)) {
          const t = cleanText(el.innerText);
          if (t.length > 80) {
            text = t;
            matchedSelector = sel;
            break;
          }
        }
      }
    }

    if (!text || text.length < 80) {
      const fb = largestVisibleTextBlock();
      if (fb.length > text.length) {
        text = fb;
        usedFallback = true;
        matchedSelector = null;
      }
    }

    return {
      text,
      url: location.href,
      title: document.title,
      site: key || location.hostname,
      usedFallback,
      matchedSelector,
      ok: text.length >= 80
    };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === "JOBFIT_SCRAPE") {
      try {
        sendResponse(scrape());
      } catch (e) {
        sendResponse({ ok: false, text: "", error: String(e) });
      }
    }
    return true;
  });
})();
