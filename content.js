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
      "#job-details",
      ".jobs-description__content .jobs-box__html-content",
      ".jobs-description-content__text",
      ".jobs-description__content",
      ".jobs-box__html-content",
      "article.jobs-description__container",
      ".jobs-description",
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

  // Decide if the page is rendered light or dark by sampling the first
  // opaque background color walking up from <body>.
  function detectPageTheme() {
    let el = document.body || document.documentElement;
    let bg = "";
    while (el) {
      const c = window.getComputedStyle(el).backgroundColor;
      if (c && !/rgba?\(0, 0, 0, 0\)|transparent/.test(c)) {
        bg = c;
        break;
      }
      el = el.parentElement;
    }
    const nums = bg.match(/\d+/g);
    if (!nums || nums.length < 3) return "light";
    const [r, g, b] = nums.map(Number);
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    return luminance < 128 ? "dark" : "light";
  }

  const MIN_JD_CHARS = 120;

  // Anchor on a stable section heading (e.g. "About the job") and pull the
  // description that follows it. Survives LinkedIn class-name churn.
  const HEADING_LABELS = ["about the job", "job description", "about the role", "the role"];

  function extractByHeading() {
    const heads = document.querySelectorAll("h1, h2, h3, h4, [role='heading']");
    for (const h of heads) {
      if (!isVisible(h)) continue;
      const label = (h.innerText || "").trim().toLowerCase();
      if (!HEADING_LABELS.includes(label)) continue;

      // Collect the text of the elements that follow the heading.
      const parts = [];
      let node = h.nextElementSibling;
      while (node) {
        if (isVisible(node)) {
          const t = (node.innerText || "").trim();
          if (t) parts.push(t);
        }
        node = node.nextElementSibling;
      }
      let body = cleanText(parts.join("\n"));

      // Fallback: the heading's container minus the heading text itself.
      if (body.length < MIN_JD_CHARS && h.parentElement && isVisible(h.parentElement)) {
        body = cleanText((h.parentElement.innerText || "").replace(h.innerText, ""));
      }
      if (body.length >= MIN_JD_CHARS) return body;
    }
    return "";
  }

  function scrape() {
    const key = siteKey();
    let text = "";
    let usedFallback = false;
    let matchedSelector = null;
    let reason = "";

    if (key) {
      // On a supported site, trust ONLY the job-specific selectors. The generic
      // largest-text-block fallback grabs the job LIST on split-view pages,
      // which is identical for every posting — so we never use it here.
      for (const sel of SITE_SELECTORS[key]) {
        const el = document.querySelector(sel);
        if (el && isVisible(el)) {
          const t = cleanText(el.innerText);
          if (t.length > MIN_JD_CHARS) {
            text = t;
            matchedSelector = sel;
            break;
          }
        }
      }

      // Selectors missed — anchor on the "About the job" heading instead.
      if (!text) {
        const anchored = extractByHeading();
        if (anchored.length >= MIN_JD_CHARS) {
          text = anchored;
          matchedSelector = "heading:about-the-job";
        }
      }

      if (!text) {
        reason =
          "Couldn't find the job description on this page. Open the full job " +
          "posting (click the job so its details expand on the right) and try again.";
      }
    } else {
      // Unknown host: best-effort generic extraction.
      const fb = largestVisibleTextBlock();
      if (fb.length > MIN_JD_CHARS) {
        text = fb;
        usedFallback = true;
      } else {
        reason = "Couldn't read a job description from this page.";
      }
    }

    return {
      text,
      url: location.href,
      title: document.title,
      site: key || location.hostname,
      usedFallback,
      matchedSelector,
      reason,
      pageTheme: detectPageTheme(),
      ok: text.length >= MIN_JD_CHARS
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
