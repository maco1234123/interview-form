import { extractXId, fetchSheets, lineShareUrl, makeShareText, submitInterview, validateInterview } from "./form.js";
import { writeEndpoint } from "./config.js";

const $ = s => document.querySelector(s);
const form = $("#interview-form");
const el = form.elements;
const submitButton = $("#submit-button");
const result = $("#result");
const notice = $("#notice");
const tokenInput = $("#token");
const shareCard = $("#share-card");
const shareText = $("#share-text");
let submitting = false;

const store = {
  get(k) { try { return localStorage.getItem(k) || ""; } catch { return ""; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* 保存できない環境では無視 */ } }
};

function showNotice(text) {
  notice.textContent = text;
  notice.classList.toggle("hidden", !text);
}

function fillSheets(names) {
  const current = el.sheetName.value || store.get("sheetName");
  const placeholder = names.length ? "選択してください" : "合言葉を入力すると表示されます";
  el.sheetName.replaceChildren(new Option(placeholder, ""), ...names.map(n => new Option(n, n)));
  if (names.includes(current)) el.sheetName.value = current;
}

function cachedSheets() {
  try { const v = JSON.parse(store.get("sheets") || "[]"); return Array.isArray(v) ? v.filter(n => typeof n === "string") : []; } catch { return []; }
}

function hideShare() {
  shareCard.classList.add("hidden");
  shareText.value = "";
}

function updateSubmitState() {
  submitButton.disabled = submitting || !writeEndpoint || !tokenInput.value.trim();
}

async function loadSheets() {
  if (!writeEndpoint || !tokenInput.value.trim()) return;
  if (!cachedSheets().length) showNotice("担当者一覧を読み込んでいます…");
  try {
    const sheets = await fetchSheets(writeEndpoint, tokenInput.value.trim());
    store.set("sheets", JSON.stringify(sheets));
    fillSheets(sheets);
    showNotice("");
  } catch (error) {
    showNotice(cachedSheets().length ? `${error.message}（前回の一覧を表示しています）` : error.message);
  }
}

fillSheets(cachedSheets());
tokenInput.value = store.get("token");
el.managerName.value = store.get("managerName");
if (!writeEndpoint) showNotice("保存先が未設定のため、まだ登録できません。");
updateSubmitState();
loadSheets();

tokenInput.addEventListener("change", () => { store.set("token", tokenInput.value.trim()); updateSubmitState(); loadSheets(); });
tokenInput.addEventListener("input", updateSubmitState);

el.tool.addEventListener("change", () => {
  const discord = el.tool.value === "Discord";
  document.querySelectorAll(".discord-field").forEach(f => f.classList.toggle("hidden", !discord));
});

el.xUrl.addEventListener("change", () => {
  const id = extractXId(el.xUrl.value);
  if (id && !el.targetId.value.trim()) el.targetId.value = `@${id}`;
});

// 入力が変わったら前回の共有文は無効にする
form.addEventListener("input", () => { if (!submitting) hideShare(); });

form.addEventListener("submit", async event => {
  event.preventDefault();
  if (submitting) return;
  const data = Object.fromEntries(new FormData(form));
  const errors = validateInterview(data);
  if (Object.keys(errors).length) {
    const [field, message] = Object.entries(errors)[0];
    result.textContent = message;
    el[field]?.focus?.();
    return;
  }
  submitting = true;
  hideShare();
  updateSubmitState();
  result.textContent = "シートに登録しています…";
  try {
    const saved = await submitInterview(data, writeEndpoint, tokenInput.value.trim());
    store.set("sheetName", data.sheetName);
    store.set("managerName", data.managerName.trim());
    const text = makeShareText(data);
    shareText.value = text;
    $("#line-button").href = lineShareUrl(text);
    $("#share-button").classList.toggle("hidden", !navigator.share);
    shareCard.classList.remove("hidden");
    result.textContent = `登録しました（${saved.recordId}）。共有文を利用できます。`;
    shareCard.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    result.textContent = `登録できませんでした：${error.message}`;
  } finally {
    submitting = false;
    updateSubmitState();
  }
});

$("#copy-button").addEventListener("click", async () => {
  if (!shareText.value) return;
  try {
    await navigator.clipboard.writeText(shareText.value);
  } catch {
    shareText.focus();
    shareText.setSelectionRange(0, shareText.value.length);
    document.execCommand("copy");
  }
  result.textContent = "共有文をコピーしました。";
});

$("#share-button").addEventListener("click", async () => {
  if (!shareText.value || !navigator.share) return;
  try { await navigator.share({ text: shareText.value }); } catch { /* キャンセル時は何もしない */ }
});

$("#reset-button").addEventListener("click", () => {
  const keep = { sheetName: el.sheetName.value, managerName: el.managerName.value };
  form.reset();
  el.sheetName.value = keep.sheetName;
  el.managerName.value = keep.managerName;
  document.querySelectorAll(".discord-field").forEach(f => f.classList.add("hidden"));
  hideShare();
  result.textContent = "";
  window.scrollTo({ top: 0, behavior: "smooth" });
});
