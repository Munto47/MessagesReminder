import "dotenv/config";
import crypto from "crypto";
import axios from "axios";
import cron from "node-cron";
import { MessageStateStore } from "./utils/state.js";
import { sendNotification } from "./utils/notifier.js";

import { decryptResponse, encryptRequest } from "./crypto-utils.js";

const KEYWORD = "活动开始签到";

function envNum(name, fallback) {
  const v = process.env[name];
  if (v == null || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(name) {
  const v = process.env[name];
  if (v == null || v === "") return false;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
}

function jsonPreview(value, maxLen = 2400) {
  try {
    const s = JSON.stringify(value);
    if (s.length <= maxLen) return s;
    return `${s.slice(0, maxLen)}…(共 ${s.length} 字符)`;
  } catch {
    return String(value).slice(0, maxLen);
  }
}

/** axios 响应头值可能是 string 或 string[] */
function headerValue(v) {
  if (v == null) return "";
  if (Array.isArray(v)) return String(v[0] ?? "").trim();
  return String(v).trim();
}

/**
 * 从响应头中解析 encrypt-flag（兼容大小写、连字符、下划线及常见别名）。
 * @param {string} [overrideName] - 来自环境变量 ENCRYPT_FLAG_HEADER 的显式头名
 */
function extractEncryptFlagFromHeaders(headers, overrideName) {
  if (!headers || typeof headers !== "object") return "";
  if (overrideName && String(overrideName).trim()) {
    const want = String(overrideName).trim().toLowerCase();
    for (const [k, val] of Object.entries(headers)) {
      if (String(k).toLowerCase() === want) {
        const v = headerValue(val);
        if (v) return v;
      }
    }
  }
  const exact = [
    "encrypt-flag",
    "encryptflag",
    "encrypt_flag",
    "x-encrypt-flag",
    "x-encryptflag",
    "encrypt-flag-v2",
  ];
  const lowerKeyToVal = new Map();
  for (const [k, val] of Object.entries(headers)) {
    lowerKeyToVal.set(String(k).toLowerCase(), headerValue(val));
  }
  for (const name of exact) {
    const v = lowerKeyToVal.get(name);
    if (v) return v;
  }
  for (const [k, val] of Object.entries(headers)) {
    const kl = String(k).toLowerCase();
    if (kl.includes("encrypt") && kl.includes("flag") && headerValue(val)) {
      return headerValue(val);
    }
  }
  return "";
}

/**
 * 从 JSON 包装响应中取密文（部分接口把 flag / data 都放在 body 里）。
 */
function extractEncryptFromJsonBody(parsed) {
  if (!parsed || typeof parsed !== "object") return { flag: "", data: "" };
  const flag =
    parsed.encryptFlag ??
    parsed["encrypt-flag"] ??
    parsed.encrypt_flag ??
    parsed.encryptflag ??
    "";
  const data =
    (typeof parsed.data === "string" ? parsed.data : null) ??
    (typeof parsed.encryptedData === "string" ? parsed.encryptedData : null) ??
    (typeof parsed.result === "string" ? parsed.result : null) ??
    (typeof parsed.payload === "string" ? parsed.payload : null) ??
    (typeof parsed.body === "string" ? parsed.body : null) ??
    (typeof parsed.ciphertext === "string" ? parsed.ciphertext : null) ??
    "";
  return { flag: flag ? String(flag).trim() : "", data: data ? String(data).trim() : "" };
}

/**
 * 统一得到 encrypt-flag 与密文字符串（与 decryptResponse 约定一致）。
 */
function resolveEncryptedParts(res) {
  const overrideFlagHeader = process.env.ENCRYPT_FLAG_HEADER?.trim();
  const fromHeaders = extractEncryptFlagFromHeaders(
    res.headers,
    overrideFlagHeader
  );
  const raw = res.data;

  if (raw == null) {
    return { encryptedFlag: "", encryptedData: "" };
  }

  if (typeof raw === "string") {
    const t = raw.trim();
    if (t.startsWith("{") || t.startsWith("[")) {
      try {
        const parsed = JSON.parse(raw);
        const fromJson = extractEncryptFromJsonBody(parsed);
        return {
          encryptedFlag: fromHeaders || fromJson.flag,
          encryptedData: fromJson.data || raw,
        };
      } catch {
        return { encryptedFlag: fromHeaders, encryptedData: raw };
      }
    }
    return { encryptedFlag: fromHeaders, encryptedData: raw };
  }

  if (typeof raw === "object") {
    const fromJson = extractEncryptFromJsonBody(raw);
    return {
      encryptedFlag: fromHeaders || fromJson.flag,
      encryptedData: fromJson.data || "",
    };
  }

  return {
    encryptedFlag: fromHeaders,
    encryptedData: String(raw),
  };
}

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36 Edg/147.0.0.0";

/**
 * 构造拉取消息用的请求头：Bearer、浏览器 UA、以及「请求侧」encrypt-flag（重放或动态加密）。
 * @param {{ encryptFlag?: string }} [overrides] - 若传入 encryptFlag，优先使用（动态请求加密时每轮新生成）
 */
function buildPollRequestHeaders(overrides = {}) {
  const token = String(process.env.API_BEARER_TOKEN ?? "").trim();
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: process.env.HTTP_ACCEPT?.trim() || "*/*",
    "User-Agent": process.env.HTTP_USER_AGENT?.trim() || DEFAULT_USER_AGENT,
    "X-Client-Type": process.env.HTTP_X_CLIENT_TYPE?.trim() || "app",
    Connection: "keep-alive",
  };

  if (overrides.encryptFlag != null && String(overrides.encryptFlag).trim() !== "") {
    headers["encrypt-flag"] = String(overrides.encryptFlag).trim();
  } else if (process.env.API_REQUEST_ENCRYPT_FLAG?.trim()) {
    headers["encrypt-flag"] = process.env.API_REQUEST_ENCRYPT_FLAG.trim();
  }

  let referer = process.env.API_REFERER?.trim();
  if (!referer) {
    const baseHint =
      process.env.API_BASE_URL?.trim() || process.env.API_URL?.trim();
    if (baseHint) {
      try {
        referer = new URL(baseHint).origin + "/";
      } catch {
        /* ignore */
      }
    }
  }
  if (referer) {
    headers.Referer = referer;
  }

  return headers;
}

/** 将 params 密文拼到列表接口 base URL 上（不含 params= 的那段） */
function buildUrlWithParamsBase(baseUrl, paramsQueryValue) {
  const b = String(baseUrl).trim();
  const join = b.includes("?") ? "&" : "?";
  return `${b}${join}params=${paramsQueryValue}`;
}

/**
 * 待加密内容只能是「查询串 / JSON 文本」本身；URL 上的 params= 由 buildUrlWithParamsBase 单独拼接，勿写进明文。
 */
function normalizePlaintextForEncrypt(s) {
  const t = String(s).trimStart();
  if (/^params\s*=/i.test(t)) {
    console.warn(
      "[poll] API_REQUEST_PLAIN 不应以「params=」开头（该前缀只出现在 URL 里，加密的是等号后的参数体）。已自动去掉此前缀；请改为例如 pageNum=1&pageSize=10。"
    );
    return t.replace(/^params\s*=\s*/i, "").trimStart();
  }
  return String(s);
}

/**
 * 待加密明文：优先 API_REQUEST_PLAIN_JSON（紧凑 JSON 字符串），否则 API_REQUEST_PLAIN；
 * 若设 API_REQUEST_PLAIN_FORMAT=json，则将 API_REQUEST_PLAIN 先 JSON.parse 再 JSON.stringify。
 * API_REQUEST_PLAIN 显式设为空字符串时返回 ""（用于测试后端默认分页）。
 * 未设置 API_REQUEST_PLAIN 且未设置 API_REQUEST_PLAIN_JSON 时返回 null。
 * @returns {string | null}
 */
function resolveRequestPlaintext() {
  const rawJson = process.env.API_REQUEST_PLAIN_JSON?.trim();
  if (rawJson) {
    try {
      return normalizePlaintextForEncrypt(JSON.stringify(JSON.parse(rawJson)));
    } catch (e) {
      console.error("[poll] API_REQUEST_PLAIN_JSON 解析失败:", e.message);
      return null;
    }
  }
  const hasPlainKey = Object.prototype.hasOwnProperty.call(
    process.env,
    "API_REQUEST_PLAIN"
  );
  if (!hasPlainKey) return null;

  const fmt = process.env.API_REQUEST_PLAIN_FORMAT?.trim().toLowerCase();
  const plain = process.env.API_REQUEST_PLAIN;
  if (fmt === "json") {
    try {
      const s = String(plain).trim();
      if (s === "") return "";
      return normalizePlaintextForEncrypt(JSON.stringify(JSON.parse(s)));
    } catch (e) {
      console.error("[poll] API_REQUEST_PLAIN 在 json 模式下解析失败:", e.message);
      return null;
    }
  }
  return normalizePlaintextForEncrypt(String(plain));
}

/** API_PARAMS_ENCODING：plus=仅替换 + 为 %2B；uri=整段 Base64 做 encodeURIComponent */
function resolveParamsEncoding() {
  const v = process.env.API_PARAMS_ENCODING?.trim().toLowerCase();
  if (v === "uri" || v === "encode" || v === "encodeURIComponent") return "uri";
  return "plus";
}

/**
 * 解析本次轮询要请求的 URL 与请求头。
 * - 动态加密：同时配置 API_BASE_URL + 明文（见 resolveRequestPlaintext），每轮 encryptRequest。
 * - 静态重放：仅配置 API_URL（可含旧 params），请求头可用 API_REQUEST_ENCRYPT_FLAG。
 * @returns {{ url: string, headers: Record<string, string> } | null}
 */
function resolvePollRequest() {
  const base = process.env.API_BASE_URL?.trim();
  const plain = resolveRequestPlaintext();
  const staticUrl = process.env.API_URL?.trim();

  // 明文仅含 pageNum=… 或 JSON 等，不含 params=；params= 仅出现在下方 buildUrlWithParamsBase
  if (base && plain !== null) {
    const enc = resolveParamsEncoding();
    const { encryptFlag, paramsQueryValue } = encryptRequest(
      String(plain),
      undefined,
      { paramsEncoding: enc }
    );
    const url = buildUrlWithParamsBase(base, paramsQueryValue);
    return { url, headers: buildPollRequestHeaders({ encryptFlag }) };
  }

  if (staticUrl) {
    return { url: staticUrl, headers: buildPollRequestHeaders() };
  }

  return null;
}

/** 判断是否拿到的是 Nginx/网关返回的 SPA 首页 HTML，而非 API 数据 */
function isLikelyHtmlGatewayResponse(res) {
  const ct = String(res.headers["content-type"] ?? "").toLowerCase();
  if (ct.includes("text/html")) return true;
  const body = res.data;
  if (typeof body !== "string") return false;
  const head = body.trim().slice(0, 64).toLowerCase();
  return head.startsWith("<!doctype") || head.startsWith("<html");
}

function getMessageText(msg) {
  if (msg == null || typeof msg !== "object") return "";
  const parts = [
    msg.title,
    msg.content,
    msg.message,
    msg.text,
    msg.body,
    msg.desc,
    msg.summary,
  ].filter((x) => x != null && String(x).trim() !== "");
  return parts.map((x) => String(x)).join("\n");
}

function pickMessageId(msg, index) {
  const raw = msg?.id ?? msg?.messageId ?? msg?.msgId ?? msg?._id;
  if (raw != null && String(raw) !== "") return String(raw);
  const text = getMessageText(msg);
  const t = msg?.createTime ?? msg?.time ?? msg?.timestamp ?? msg?.create_time ?? "";
  const h = crypto
    .createHash("sha256")
    .update(`${t}\n${text}`)
    .digest("hex")
    .slice(0, 24);
  return `synthetic:${h}:${index}`;
}

/** 从解密后的对象中尽量取出消息数组；matchedPath 便于排查结构不匹配 */
const MESSAGE_LIST_CANDIDATES = [
  { path: "data.list", fn: (d) => d?.data?.list },
  { path: "data.records", fn: (d) => d?.data?.records },
  { path: "data.items", fn: (d) => d?.data?.items },
  { path: "data.rows", fn: (d) => d?.data?.rows },
  {
    path: "data (顶层为数组)",
    fn: (d) => (Array.isArray(d?.data) ? d.data : null),
  },
  { path: "result.list", fn: (d) => d?.result?.list },
  { path: "result.records", fn: (d) => d?.result?.records },
  { path: "result.items", fn: (d) => d?.result?.items },
  { path: "result.rows", fn: (d) => d?.result?.rows },
  { path: "list", fn: (d) => d?.list },
  { path: "records", fn: (d) => d?.records },
  { path: "items", fn: (d) => d?.items },
];

function extractMessagesResult(decrypted) {
  for (const { path, fn } of MESSAGE_LIST_CANDIDATES) {
    const c = fn(decrypted);
    if (Array.isArray(c)) return { messages: c, matchedPath: path };
  }
  return { messages: [], matchedPath: null };
}

function compareIdDesc(a, b) {
  const na = /^\d+$/.test(a);
  const nb = /^\d+$/.test(b);
  if (na && nb) {
    if (BigInt(a) === BigInt(b)) return 0;
    return BigInt(a) < BigInt(b) ? -1 : 1;
  }
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function idGreaterThan(candidate, baseline) {
  if (baseline == null || baseline === "") return true;
  return compareIdDesc(candidate, baseline) > 0;
}

function maxId(a, b) {
  if (a == null || a === "") return b;
  if (b == null || b === "") return a;
  return compareIdDesc(a, b) >= 0 ? a : b;
}

async function maybeAlertTokenExpired(stateStore) {
  const cooldown = envNum("TOKEN_ALERT_COOLDOWN_MS", 3600000);
  const now = Date.now();
  const s = await stateStore.read();
  if (
    s.lastTokenAlertAt != null &&
    now - s.lastTokenAlertAt < cooldown
  ) {
    return;
  }
  await sendNotification(
    "Token已过期，请及时更新",
    "第三方消息接口返回 401/未授权，请更新 .env 中的 API_BEARER_TOKEN 后重启服务。"
  );
  await stateStore.write({ lastTokenAlertAt: now });
}

async function runPoll(stateStore) {
  const token = process.env.API_BEARER_TOKEN;

  const resolved = resolvePollRequest();
  if (!resolved) {
    console.error(
      "[poll] 未配置有效接口地址：请设置 API_URL（静态重放），或同时设置 API_BASE_URL + API_REQUEST_PLAIN（动态加密请求）"
    );
    return;
  }
  const { url: apiUrl, headers: pollHeaders } = resolved;

  if (token == null || String(token).trim() === "") {
    console.error("[poll] 未配置 API_BEARER_TOKEN，跳过本轮");
    return;
  }

  const timeout = envNum("REQUEST_TIMEOUT_MS", 20000);

  let res;
  try {
    res = await axios.get(apiUrl, {
      headers: pollHeaders,
      responseType: "text",
      timeout,
      validateStatus: () => true,
    });
    if (envBool("POLL_DEBUG_BODY")) {
      const raw = res.data;
      const preview =
        typeof raw === "string"
          ? raw.slice(0, 800)
          : JSON.stringify(raw).slice(0, 800);
      console.log("【调试】HTTP状态码:", res.status);
      console.log(
        "【调试】响应头键:",
        Object.keys(res.headers || {}).sort().join(", ")
      );
      console.log("【调试】响应体预览:", preview);
    }
  } catch (err) {
    console.error("[poll] 请求失败（已忽略，下一轮继续）:", err?.message || err);
    return;
  }

  if (res.status === 401 || res.status === 403) {
    console.error("[poll] 未授权:", res.status);
    await maybeAlertTokenExpired(stateStore);
    return;
  }

  if (res.status < 200 || res.status >= 300) {
    console.error("[poll] 非预期 HTTP 状态:", res.status);
    if (res.status === 500) {
      console.error(
        "[poll] 500 排查：1) 试设 API_PARAMS_ENCODING=uri（避免 params 里 /、= 破坏 query）；2) 明文可能需为 JSON，试 API_REQUEST_PLAIN_JSON={\"pageNum\":1,\"pageSize\":20} 或 API_REQUEST_PLAIN_FORMAT=json；3) 动态加密时请注释 API_REQUEST_ENCRYPT_FLAG；4) 对照浏览器 Network 里加密前的原文。"
      );
    }
    return;
  }

  if (isLikelyHtmlGatewayResponse(res)) {
    console.error(
      "[poll] 当前响应为 HTML 网页（常见于地址填错、或请求加密与 params 不匹配被网关退回首页）。请检查：1) 使用动态加密时 API_BASE_URL + API_REQUEST_PLAIN 是否正确；2) 静态重放时 API_URL 是否含有效 params，且 API_REQUEST_ENCRYPT_FLAG 与 params 为同一次抓包；3) 可选 API_REFERER、HTTP_USER_AGENT。POLL_DEBUG_BODY=1 可查看响应预览。"
    );
    return;
  }

  const { encryptedFlag, encryptedData } = resolveEncryptedParts(res);

  if (envBool("POLL_DEBUG_HEADERS")) {
    const keys = res.headers && typeof res.headers === "object"
      ? Object.keys(res.headers).sort().join(", ")
      : "";
    console.log("[poll] debug response header keys:", keys);
  }

  if (!encryptedFlag || encryptedData == null || String(encryptedData).trim() === "") {
    console.error(
      "[poll] 缺少 encrypt-flag 或密文响应体，无法解密。可设置 POLL_DEBUG_HEADERS=1 查看响应头键名；若 flag 仅在 JSON 内，请确认 body 含 encryptFlag/data 等字段。"
    );
    return;
  }

  let decrypted;
  try {
    decrypted = decryptResponse(String(encryptedFlag), String(encryptedData));
  } catch (err) {
    console.error("[poll] 解密失败:", err?.message || err);
    return;
  }

  const parseDebug = envBool("POLL_DEBUG_PARSE");
  if (parseDebug) {
    const root = decrypted && typeof decrypted === "object" ? decrypted : null;
    console.log(
      "[poll] parse: 解密成功，根对象类型:",
      decrypted === null ? "null" : typeof decrypted
    );
    if (root && !Array.isArray(root)) {
      console.log("[poll] parse: 根对象键名:", Object.keys(root).join(", "));
      if (root.data != null && typeof root.data === "object" && !Array.isArray(root.data)) {
        console.log("[poll] parse: data 键名:", Object.keys(root.data).join(", "));
      }
    }
  }

  const { messages, matchedPath } = extractMessagesResult(decrypted);
  const state = await stateStore.read();
  const lastId = state.lastMessageId;
  const allowNotify = state.initialScanDone === true;

  const enriched = messages.map((msg, idx) => ({
    msg,
    id: pickMessageId(msg, idx),
  }));
  enriched.sort((a, b) => compareIdDesc(a.id, b.id));

  let newMax = lastId;
  let notifyCandidates = 0;
  for (const { msg, id } of enriched) {
    newMax = maxId(newMax, id);

    if (!idGreaterThan(id, lastId)) continue;

    const text = getMessageText(msg);
    if (!text.includes(KEYWORD)) continue;

    notifyCandidates += 1;

    if (!allowNotify) continue;

    await sendNotification("新消息提醒", `${KEYWORD}\n\nID: ${id}\n\n${text}`);
  }

  const patch = { initialScanDone: true };
  if (newMax != null && newMax !== lastId) {
    patch.lastMessageId = newMax;
  }

  if (parseDebug) {
    console.log(
      "[poll] parse: 列表匹配路径:",
      matchedPath ?? "(未匹配 — 请根据下方键名在 index.js 的 MESSAGE_LIST_CANDIDATES 中补充)"
    );
    console.log("[poll] parse: 消息条数:", messages.length);
    if (messages.length > 0) {
      const sample = messages[0];
      console.log(
        "[poll] parse: 首条消息键名:",
        sample && typeof sample === "object"
          ? Object.keys(sample).join(", ")
          : typeof sample
      );
      console.log(
        "[poll] parse: 首条 pickMessageId:",
        pickMessageId(messages[0], 0)
      );
    }
    console.log("[poll] parse: 上轮 lastMessageId:", lastId ?? "(空)");
    console.log("[poll] parse: 本轮计算 newMax:", newMax ?? "(空)");
    console.log(
      "[poll] parse: 是否写入 lastMessageId:",
      patch.lastMessageId !== undefined,
      patch.lastMessageId !== undefined ? `→ ${patch.lastMessageId}` : ""
    );
    if (patch.lastMessageId === undefined) {
      if (messages.length === 0) {
        console.log(
          "[poll] parse: 未写入原因: 未解析到任何消息数组（newMax 保持为 lastId）。"
        );
        if (decrypted != null && typeof decrypted === "object") {
          console.log("[poll] parse: 解密对象预览:", jsonPreview(decrypted));
        }
      } else {
        console.log(
          "[poll] parse: 未写入原因: newMax 与 lastMessageId 相同（无新 ID）。"
        );
      }
    }
    console.log(
      "[poll] parse: initialScanDone 上轮:",
      state.initialScanDone,
      "→ 本轮写入: true"
    );
    console.log(
      "[poll] parse: 关键词匹配且 id > lastId 的条数:",
      notifyCandidates,
      `（关键词: ${KEYWORD}）`
    );
    if (!allowNotify && notifyCandidates > 0) {
      console.log(
        "[poll] parse: 首轮不推送（initialScanDone 曾为 false），已跳过 Server酱"
      );
    }
  }

  await stateStore.write(patch);
}

async function main() {
  const statePath =
    process.env.STATE_FILE?.trim() || "./data/last_state.json";
  const stateStore = new MessageStateStore(statePath);

  let inFlight = false;
  const tick = async () => {
    if (inFlight) {
      console.warn("[tick] 上一轮尚未结束，跳过本次触发");
      return;
    }
    inFlight = true;
    try {
      await runPoll(stateStore);
    } catch (err) {
      console.error("[tick] 本轮处理异常（已捕获）:", err?.message || err);
    } finally {
      inFlight = false;
    }
  };

  await tick();

  const job = cron.schedule(
    "*/1 * * * *",
    () => {
      tick();
    },
    { timezone: process.env.CRON_TZ || "Asia/Shanghai" }
  );

  const shutdown = () => {
    try {
      job.stop();
    } catch (_) {
      /* ignore */
    }
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.log(
    "[main] 已启动：每 1 分钟轮询一次，STATE_FILE=%s",
    statePath
  );
}

main().catch((err) => {
  console.error("[main] 启动失败:", err);
  process.exit(1);
});
