// JobFit settings page. Module so it can import the pdf.js ESM build.
import * as pdfjsLib from "./vendor/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("vendor/pdf.worker.min.mjs");

const DEFAULT_MODEL = "openai/gpt-oss-120b";

const els = {
  apiKey: document.getElementById("apiKey"),
  model: document.getElementById("model"),
  resume: document.getElementById("resume"),
  resumeFile: document.getElementById("resumeFile"),
  fileStatus: document.getElementById("fileStatus"),
  saveBtn: document.getElementById("saveBtn"),
  confirm: document.getElementById("confirm"),
  revealKey: document.getElementById("revealKey")
};

function setConfirm(msg, isError) {
  els.confirm.textContent = msg;
  els.confirm.classList.toggle("err", !!isError);
  if (msg) setTimeout(() => { els.confirm.textContent = ""; }, 4000);
}

async function load() {
  const { groqApiKey, groqModel, resume } = await chrome.storage.local.get([
    "groqApiKey",
    "groqModel",
    "resume"
  ]);
  if (groqApiKey) els.apiKey.value = groqApiKey;
  els.model.value = groqModel || DEFAULT_MODEL;
  if (resume) els.resume.value = resume;
}

async function extractDocx(file) {
  const arrayBuffer = await file.arrayBuffer();
  const result = await window.mammoth.extractRawText({ arrayBuffer });
  return result.value || "";
}

async function extractPdf(file) {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  let out = "";
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const strings = content.items.map((it) => it.str);
    out += strings.join(" ") + "\n\n";
  }
  return out.trim();
}

els.resumeFile.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  els.fileStatus.textContent = "Parsing " + file.name + "…";
  try {
    let text = "";
    const name = file.name.toLowerCase();
    if (name.endsWith(".docx")) {
      text = await extractDocx(file);
    } else if (name.endsWith(".pdf")) {
      text = await extractPdf(file);
    } else {
      throw new Error("Unsupported file type. Use .docx or .pdf.");
    }
    if (!text.trim()) throw new Error("No text found in the file.");
    els.resume.value = text;
    els.fileStatus.textContent = "Loaded " + file.name + " (" + text.length + " chars).";
  } catch (err) {
    els.fileStatus.textContent = "Failed: " + String(err.message || err);
  } finally {
    els.resumeFile.value = ""; // allow re-uploading the same file
  }
});

els.revealKey.addEventListener("click", () => {
  const showing = els.apiKey.type === "text";
  els.apiKey.type = showing ? "password" : "text";
  els.revealKey.textContent = showing ? "Show" : "Hide";
});

els.saveBtn.addEventListener("click", async () => {
  const groqApiKey = els.apiKey.value.trim();
  const groqModel = els.model.value.trim() || DEFAULT_MODEL;
  const resume = els.resume.value.trim();

  if (!groqApiKey) { setConfirm("Add a Groq API key before saving.", true); return; }
  if (!resume) { setConfirm("Add your resume before saving.", true); return; }

  await chrome.storage.local.set({ groqApiKey, groqModel, resume });
  setConfirm("Saved.");
});

load();
