export const INTERVIEW_TYPES = {
  "ライバー": "《ライバー面談確定》",
  "ライバー＆マネージャー": "《ライバー&マネージャー面談確定》",
  "マネージャー": "《マネージャー面談確定》"
};

export const requiredFields = [
  "interviewType", "sheetName", "managerName", "xUrl", "targetName", "meetingDate", "meetingTime",
  "firstContactDate", "replyDate", "lastSentDate", "tool"
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
  if (data.interviewType && !INTERVIEW_TYPES[data.interviewType]) errors.interviewType = "面談種別を選択してください";
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

/** 共有文用の日時（例：11/15(日)14:00〜）。入力された暦日から曜日を求めるので端末のタイムゾーンに左右されない */
export function formatMeeting(date, time) {
  const [y, m, d] = String(date).split("-").map(Number);
  const w = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${m}/${d}(${w})${time}〜`;
}

export function withHonorific(name) {
  const s = String(name ?? "").trim();
  return s.endsWith("様") ? s : `${s}様`;
}

export function makeShareText(data) {
  // ブロック内は改行のみ、ブロック間は空行1行
  const toolBlock = ["使用ツール"];
  if (data.tool === "Discord") {
    toolBlock.push("discord");
    const user = String(data.discordUsername ?? "").trim();
    const invite = String(data.discordInviteUrl ?? "").trim();
    if (user) toolBlock.push("ユーザー名", user);
    if (invite) toolBlock.push("招待URL", normalizeUrl(invite));
  } else {
    toolBlock.push("LINE");
  }
  const blocks = [
    [INTERVIEW_TYPES[data.interviewType] ?? "《面談確定》"],
    [formatMeeting(data.meetingDate, data.meetingTime), withHonorific(data.targetName), normalizeUrl(data.xUrl)],
    toolBlock,
    ["連絡アカ", String(data.sheetName ?? "").trim()],
    ["よろしくお願いします！"]
  ];
  return blocks.map(b => b.join("\n")).join("\n\n");
}

export function lineShareUrl(text) {
  return `https://line.me/R/share?text=${encodeURIComponent(text)}`;
}

export function duplicateKey(data) {
  return `${extractXId(data.xUrl) || extractXId(data.targetId)}|${String(data.targetName ?? "").trim().toLowerCase()}`;
}

/** 送信用ペイロード。ステータス・使用アカウント・番号は含めない（sheetName は登録先の指定にのみ使う） */
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
    lastSentDate: data.lastSentDate,
    tool: data.tool,
    notes: String(data.notes ?? "").trim()
  };
}

export const REQUEST_TIMEOUT_MS = 60000;

/** 登録の1回目の待ち時間と、再確認（同じ送信IDでの再送）の待ち時間・間隔 */
export const REGISTER_TIMEOUTS_MS = [30000, 20000, 20000, 20000];
export const RECHECK_DELAYS_MS = [1000, 3000, 5000];

/** サーバーが「登録していない」と確定して返すコード（この場合だけ「登録失敗」と表示する） */
export const DEFINITE_FAILURE_CODES = [
  "INVALID", "UNAUTHORIZED", "DUPLICATE", "INVALID_SHEET", "CONFLICT", "NO_EMPTY_ROW", "BAD_REQUEST", "REQUEST_ID_MISMATCH", "DRY_RUN"
];

/** kind: "failed"（登録されていないと確定）／"unknown"（登録されたか確認できない。失敗とは限らない） */
export class RegistrationError extends Error {
  constructor(message, kind, code = "") {
    super(message);
    this.kind = kind;
    this.code = code;
  }
}

/** 送信ごとの一意なID（同じ登録操作の再送では同じIDを使い、二重登録を防ぐ） */
export function newRequestId(cryptoImpl = globalThis.crypto) {
  if (cryptoImpl?.randomUUID) return `req-${cryptoImpl.randomUUID().replace(/-/g, "")}`;
  const bytes = new Uint8Array(16);
  cryptoImpl.getRandomValues(bytes);
  return `req-${Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("")}`;
}

/** 入力内容の指紋（同じ内容の再送かどうかの判定用） */
export function dataFingerprint(data) {
  const keys = ["sheetName", "managerName", "xUrl", "targetName", "targetId", "meetingDate", "meetingTime",
    "firstContactDate", "replyDate", "lastSentDate", "tool", "notes"];
  return JSON.stringify(keys.map(k => String(data[k] ?? "").trim()));
}

/**
 * 1回分の通信。応答が読めた場合は { response, result }、
 * 通信断・タイムアウト・読めない応答の場合は { lost: "timeout" | "network" | "unreadable" } を返す（例外にしない）。
 */
async function postOnce(endpoint, body, fetchImpl, timeoutMs) {
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
      return { lost: timedOut ? "timeout" : "network" };
    }
    try {
      return { response, result: await response.json() };
    } catch {
      return { lost: timedOut ? "timeout" : "unreadable" };
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function postJson(endpoint, body, fetchImpl, timeoutMs = REQUEST_TIMEOUT_MS) {
  const r = await postOnce(endpoint, body, fetchImpl, timeoutMs);
  if (r.lost === "timeout") throw new Error("通信がタイムアウトしました。電波の良い場所でもう一度お試しください。");
  if (r.lost === "network") throw new Error("通信に失敗しました。電波を確認してもう一度お試しください。");
  if (r.lost) throw new Error("応答を確認できませんでした。もう一度お試しください。");
  return r;
}

const LOST_TEXT = {
  timeout: "応答がありませんでした（タイムアウト）",
  network: "通信が切れました",
  unreadable: "応答を読み取れませんでした",
  busy: "サーバーが他の登録を処理中でした",
  server: "サーバーで一時的なエラーが起きました"
};

const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * 登録する。通信が切れた・応答が無い場合は「失敗」と決めつけず、同じ送信IDで再確認する
 * （サーバーは同じ送信IDの登録を二重に書かず、登録済みならその結果を返す）。
 * - 成功を確認できた場合だけ結果を返す（共有文はこの場合だけ出す）
 * - 登録されていないと確定した場合は RegistrationError(kind: "failed")
 * - 最後まで確認できなかった場合は RegistrationError(kind: "unknown")
 *
 * options: requestId（必須推奨）, recheck（最初から再確認として送る）, onState(state, attempt),
 *          timeouts, delays, sleep
 */
export async function submitInterview(data, endpoint, token, fetchImpl = fetch, options = {}) {
  if (!endpoint) throw new RegistrationError("保存先が未設定です。接続設定が必要です。", "failed", "CONFIG");
  if (!token) throw new RegistrationError("合言葉が未入力です。", "failed", "CONFIG");
  const {
    requestId = newRequestId(), recheck = false, onState = () => {},
    timeouts = REGISTER_TIMEOUTS_MS, delays = RECHECK_DELAYS_MS, sleep = defaultSleep
  } = options;
  const started = Date.now();
  let lastReason = "network";
  for (let attempt = 0; attempt < timeouts.length; attempt++) {
    const checking = recheck || attempt > 0;
    if (attempt > 0) {
      onState("checking", attempt);
      await sleep(delays[Math.min(attempt - 1, delays.length - 1)] ?? 0);
    } else {
      onState(checking ? "checking" : "sending", attempt);
    }
    const body = { ...buildPayload(data, token), requestId, ...(checking ? { retry: true } : {}) };
    const r = await postOnce(endpoint, body, fetchImpl, timeouts[attempt]);
    if (r.lost) { lastReason = r.lost; continue; }
    const { response, result } = r;
    if (response.ok && result?.success === true && result.recordId) {
      return { ...result, requestId, attempts: attempt + 1, clientMs: Date.now() - started };
    }
    const code = result?.code ?? "";
    if (code === "BUSY") { lastReason = "busy"; continue; }
    if (code === "VERIFY_FAILED") {
      throw new RegistrationError(`${result.message || "書き込み後の確認に失敗しました。"}（${result.recordId || "登録先"}を確認してください）`, "unknown", code);
    }
    if (DEFINITE_FAILURE_CODES.includes(code)) {
      throw new RegistrationError(result.message || "登録できませんでした。", "failed", code);
    }
    lastReason = "server"; // ERROR・不明な応答は登録されたか分からないので再確認する
  }
  throw new RegistrationError(
    `${LOST_TEXT[lastReason] || LOST_TEXT.network}。登録されたかどうか確認できていません（失敗とは限りません）。電波の良い場所で「登録状況を確認」を押してください。同じ登録が二重になることはありません。`,
    "unknown", lastReason
  );
}

export async function fetchSheets(endpoint, token, fetchImpl = fetch) {
  const { response, result } = await postJson(endpoint, { action: "sheets", token }, fetchImpl);
  if (!response.ok || result?.success !== true || !Array.isArray(result.sheets)) {
    throw new Error(result?.message || "担当者一覧を取得できませんでした。");
  }
  return result.sheets;
}
