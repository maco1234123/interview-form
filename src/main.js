import {
  dataFingerprint, extractXId, fetchSheets, lineShareUrl, makeShareText, newRequestId, submitInterview, validateInterview
} from "./form.js";
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
const statusBox = $("#status");
const statusTitle = $("#status-title");
const recheckButton = $("#recheck-button");
let submitting = false;
let doneFingerprint = ""; // 登録完了を確認できた入力内容（同じ内容の再送を防ぐ）
let lastShare = "";

const STATUS_TITLES = {
  sending: "登録中…",
  checking: "登録状況を確認中…",
  done: "登録完了",
  failed: "登録失敗",
  unknown: "登録状況を確認できませんでした",
  invalid: "入力を確認してください"
};

function setStatus(state, message = "") {
  if (!state) { statusBox.classList.add("hidden"); delete statusBox.dataset.state; result.textContent = ""; return; }
  statusBox.dataset.state = state;
  statusTitle.textContent = STATUS_TITLES[state] || "";
  result.textContent = message;
  statusBox.classList.remove("hidden");
}

const store = {
  get(k) { try { return localStorage.getItem(k) || ""; } catch { return ""; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* 保存できない環境では無視 */ } },
  remove(k) { try { localStorage.removeItem(k); } catch { /* 無視 */ } }
};

// 結果を確認できていない登録（画面の再読み込み・アプリ切り替え後も同じ送信IDで確認できるよう端末に保存。6時間で破棄）
const PENDING_TTL_MS = 6 * 60 * 60 * 1000;
function loadPending() {
  try {
    const p = JSON.parse(store.get("pending") || "null");
    if (p && p.requestId && p.data && Date.now() - p.at < PENDING_TTL_MS) return p;
  } catch { /* 壊れていれば破棄 */ }
  store.remove("pending");
  return null;
}
function savePending(p) { store.set("pending", JSON.stringify(p)); }
function clearPending() { store.remove("pending"); recheckButton.classList.add("hidden"); }

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
  submitButton.textContent = submitting ? "登録中…" : "シートに登録";
  recheckButton.disabled = submitButton.disabled;
  form.classList.toggle("is-busy", submitting);
  form.setAttribute("aria-busy", String(submitting));
}

function showShare(data, message) {
  const text = makeShareText(data);
  lastShare = text;
  shareText.value = text;
  $("#line-button").href = lineShareUrl(text);
  $("#share-button").classList.toggle("hidden", !navigator.share);
  shareCard.classList.remove("hidden");
  setStatus("done", message);
  shareCard.scrollIntoView({ behavior: "smooth", block: "start" });
}

function restoreForm(data) {
  for (const [k, v] of Object.entries(data)) {
    const field = el[k];
    if (!field || typeof field.value !== "string" || field instanceof RadioNodeList) continue;
    if (k === "sheetName" && ![...field.options].some(o => o.value === v)) field.append(new Option(v, v));
    field.value = v;
  }
  document.querySelectorAll(".discord-field").forEach(f => f.classList.toggle("hidden", el.tool.value !== "Discord"));
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

// 入力が変わったら前回の共有文・結果表示は無効にする（確認待ちの表示と「登録状況を確認」は残す）
form.addEventListener("input", () => {
  if (submitting) return;
  hideShare();
  if (["done", "failed", "invalid"].includes(statusBox.dataset.state)) setStatus("");
});

async function register(data, { recheck = false } = {}) {
  if (submitting) return; // 連打・二重送信の防止
  const fingerprint = dataFingerprint(data);
  if (fingerprint === doneFingerprint && lastShare) {
    showShare(data, "この内容は登録済みです（再送していません）。共有文を利用できます。");
    return;
  }
  // 同じ内容で結果を確認できていない登録があれば、同じ送信IDで確認する（サーバー側で二重登録しない）
  let pending = loadPending();
  const reuse = !!pending && pending.fingerprint === fingerprint;
  if (!reuse) {
    pending = { requestId: newRequestId(), fingerprint, data, at: Date.now() };
    savePending(pending);
  }
  submitting = true;
  hideShare();
  recheckButton.classList.add("hidden");
  updateSubmitState();
  const started = performance.now();
  try {
    const saved = await submitInterview(data, writeEndpoint, tokenInput.value.trim(), fetch, {
      requestId: pending.requestId,
      recheck: recheck || reuse,
      onState: state => setStatus(state, state === "sending"
        ? "シートに書き込んでいます。画面を閉じずにお待ちください。"
        : "応答を確認できなかったため、登録されたかどうかを確認しています。この間に二重登録されることはありません。")
    });
    clearPending();
    doneFingerprint = fingerprint;
    store.set("sheetName", data.sheetName);
    store.set("managerName", String(data.managerName ?? "").trim());
    const secs = ((performance.now() - started) / 1000).toFixed(1);
    const note = saved.replayed || saved.alreadyRegistered ? "（前回の送信で登録済みでした）" : "";
    showShare(data, `${saved.recordId} に登録しました${note}。共有文を利用できます。（${secs}秒）`);
  } catch (error) {
    if (error.kind === "failed") {
      clearPending();
      setStatus("failed", error.message);
    } else {
      // 登録されたか分からない：失敗と断定せず、同じ送信IDで確認できるようにする
      setStatus("unknown", error.message);
      recheckButton.classList.remove("hidden");
    }
  } finally {
    submitting = false;
    updateSubmitState();
  }
}

form.addEventListener("submit", event => {
  event.preventDefault();
  if (submitting) return;
  const data = Object.fromEntries(new FormData(form));
  const errors = validateInterview(data);
  if (Object.keys(errors).length) {
    const [field, message] = Object.entries(errors)[0];
    const label = el[field]?.closest?.("label")?.firstChild?.textContent?.trim();
    setStatus("invalid", label ? `${label}：${message}` : message);
    el[field]?.focus?.();
    return;
  }
  register(data);
});

recheckButton.addEventListener("click", () => {
  if (submitting) return;
  const pending = loadPending();
  if (!pending) { recheckButton.classList.add("hidden"); setStatus(""); return; }
  restoreForm(pending.data); // 確認するのは前回送った内容
  register(pending.data, { recheck: true });
});

// 前回の登録結果を確認できていなければ、再読み込み後も確認できるようにする
const pendingAtLoad = loadPending();
if (pendingAtLoad) {
  restoreForm(pendingAtLoad.data);
  setStatus("unknown", "前回の登録が完了したか確認できていません。「登録状況を確認」を押してください（二重登録にはなりません）。");
  recheckButton.classList.remove("hidden");
}

$("#copy-button").addEventListener("click", async () => {
  if (!shareText.value) return;
  try {
    await navigator.clipboard.writeText(shareText.value);
  } catch {
    shareText.focus();
    shareText.setSelectionRange(0, shareText.value.length);
    document.execCommand("copy");
  }
  setStatus("done", "共有文をコピーしました。");
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
  doneFingerprint = "";
  lastShare = "";
  setStatus("");
  window.scrollTo({ top: 0, behavior: "smooth" });
});
