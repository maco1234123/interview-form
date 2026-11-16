export const requiredFields = [
  "sheetName", "managerName", "xUrl", "targetName", "meetingDate", "meetingTime",
  "firstContactDate", "replyDate", "tool"
];

const RESERVED_X_PATHS = ["i", "home", "intent", "search", "messages", "settings", "share"];

export function normalizeUrl(value) {
  const input = String(value ?? "").trim();
  if (!input) return "";
  return /^https?:\/\//i.test(input) ? input : `https://${input}`;
}

/** XプロフィールURL（または @ID）から小文字のIDを取り出す。判定できなければ空文字 */
export function extractXId(value) {
  const s = String(value ?? "").trim();
  if (!s) return "";
  const m = s.match(/^(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter)\.com\/(@?[A-Za-z0-9_]{1,15})(?:[/?#]|$)/i);
  if (m) {
    const id = m[1].replace(/^@/, "");
    return RESERVED_X_PATHS.includes(id.toLowerCase()) ? "" : id.toLowerCase();
  }
  return /^@?[A-Za-z0-9_]{1,15}$/.test(s) ? s.replace(/^@/, "").toLowerCase() : "";
}

export function validateInterview(data, now = new Date()) {
  const errors = {};
  for (const field of requiredFields) {
    if (!String(data[field] ?? "").trim()) errors[field] = "必須項目を入力してください";
  }
  if (data.tool && !["LINE", "Discord"].includes(data.tool)) errors.tool = "LINEかDiscordを選択してください";
  if (data.meetingDate && data.meetingTime && new Date(`${data.meetingDate}T${data.meetingTime}:00`) < now) {
    errors.meetingDate = "面談日時は現在以降を指定してください";
  }
  for (const key of ["xUrl", "discordInviteUrl"]) {
    if (data[key]) {
      try {
        const parsed = new URL(normalizeUrl(data[key]));
        if (!parsed.hostname || !["http:", "https:"].includes(parsed.protocol)) errors[key] = "有効なURLを入力してください";
      } catch {
        errors[key] = "有効なURLを入力してください";
      }
    }
  }
  if (data.xUrl && !errors.xUrl && !extractXId(data.xUrl) && !extractXId(data.targetId)) {
    errors.targetId = "URLから対象者IDを判定できません。対象者IDを入力してください";
  }
  return errors;
}

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

export function formatMeeting(date, time) {
  const [y, m, d] = String(date).split("-").map(Number);
  const w = WEEKDAYS[new Date(y, m - 1, d).getDay()];
  return `${y}/${String(m).padStart(2, "0")}/${String(d).padStart(2, "0")}(${w}) ${time}`;
}

const slash = value => String(value ?? "").replaceAll("-", "/");

export function makeShareText(data) {
  const id = extractXId(data.xUrl) || extractXId(data.targetId);
  const lines = [
    "【面談確定】",
    `担当者：${data.managerName}`,
    `使用アカウント：${data.sheetName}`,
    `対象者：${data.targetName}${id ? `（@${id}）` : ""}`,
    `X：${normalizeUrl(data.xUrl)}`,
    `面談日時：${formatMeeting(data.meetingDate, data.meetingTime)}`,
    `初回送信日：${slash(data.firstContactDate)}`,
    `返信日：${slash(data.replyDate)}`,
    `使用ツール：${data.tool}`
  ];
  if (data.tool === "Discord") {
    if (String(data.discordUsername ?? "").trim()) lines.push(`Discordユーザー名：${data.discordUsername.trim()}`);
    if (String(data.discordInviteUrl ?? "").trim()) lines.push(`招待URL：${normalizeUrl(data.discordInviteUrl)}`);
  }
  if (String(data.notes ?? "").trim()) lines.push(`備考：${data.notes.trim()}`);
  return lines.join("\n");
}

export function lineShareUrl(text) {
  return `https://line.me/R/share?text=${encodeURIComponent(text)}`;
}

export function duplicateKey(data) {
  return `${extractXId(data.xUrl) || extractXId(data.targetId)}|${String(data.targetName ?? "").trim().toLowerCase()}`;
}

/** 送信用ペイロード。最終送信日・ステータスは含めない */
export function buildPayload(data, token) {
  return {
    action: "register",
    token,
    sheetName: data.sheetName,
    managerName: String(data.managerName ?? "").trim(),
    targetId: extractXId(data.targetId) ? `@${extractXId(data.targetId)}` : "",
    targetName: String(data.targetName ?? "").trim(),
    xUrl: normalizeUrl(data.xUrl),
    meetingDate: data.meetingDate,
    meetingTime: data.meetingTime,
    firstContactDate: data.firstContactDate,
    replyDate: data.replyDate,
    tool: data.tool,
    notes: String(data.notes ?? "").trim()
  };
}

export const REQUEST_TIMEOUT_MS = 60000;

async function postJson(endpoint, body, fetchImpl, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  let timedOut = false;
  const timer = controller ? setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs) : null;
  try {
    let response;
    try {
      // text/plain にして CORS プリフライトを避ける（Apps Script Web アプリ向け）
      response = await fetchImpl(endpoint, {
        method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify(body),
        redirect: "follow", signal: controller?.signal
      });
    } catch {
      throw new Error(timedOut
        ? "通信がタイムアウトしました。登録されたか不明なため、共有文は生成しません。もう一度送信すると、登録済みの場合は「既に登録されています」と表示されます。"
        : "通信に失敗しました。登録されたか不明なため、共有文は生成しません。電波を確認してもう一度送信してください（登録済みなら重複として表示されます）。");
    }
    let result;
    try {
      result = await response.json();
    } catch {
      throw new Error("保存結果を確認できませんでした。共有文は生成されません。");
    }
    return { response, result };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function submitInterview(data, endpoint, token, fetchImpl = fetch, timeoutMs = REQUEST_TIMEOUT_MS) {
  if (!endpoint) throw new Error("保存先が未設定です。接続設定が必要です。");
  if (!token) throw new Error("合言葉が未入力です。");
  const { response, result } = await postJson(endpoint, buildPayload(data, token), fetchImpl, timeoutMs);
  if (result?.code === "DUPLICATE") throw new Error(result.message || "同じ対象者が既に登録されています。");
  if (!response.ok || result?.success !== true || !result.recordId) {
    throw new Error(result?.message || "保存結果を確認できませんでした。共有文は生成されません。");
  }
  return result;
}

export async function fetchSheets(endpoint, token, fetchImpl = fetch) {
  const { response, result } = await postJson(endpoint, { action: "sheets", token }, fetchImpl);
  if (!response.ok || result?.success !== true || !Array.isArray(result.sheets)) {
    throw new Error(result?.message || "担当者一覧を取得できませんでした。");
  }
  return result.sheets;
}
