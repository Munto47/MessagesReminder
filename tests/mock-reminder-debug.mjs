import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encryptResponseForTest } from "../crypto-utils.js";
import {
  buildStableMessageFingerprint,
  createStateStore,
  resolveEncryptedParts,
  runPoll,
} from "../poller.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function createServer(handler) {
  const server = http.createServer(handler);
  return {
    server,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      });
      const address = server.address();
      return `http://127.0.0.1:${address.port}`;
    },
    async close() {
      await new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

function encryptPayload(payload) {
  const { encryptedFlag, encryptedData } = encryptResponseForTest(payload);
  return { encryptedFlag, encryptedData };
}

async function readStateFile(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

const originalEnv = { ...process.env };
const stateFiles = [];

const baselineRows = [
  {
    id: "2045323763259809793",
    schoolId: 10406,
    fromUserId: "1000000000000343174",
    fromUserName: "姚宇翔",
    fromUserAvatar: "1872454640621387778",
    businessId: "2045323763129786370",
    messageType: 2,
    messageBusinessType: 0,
    messageTitle: "活动 签退",
    messageContent: "您已成功签退活动：振兴杯（观众）",
    userId: "1000000000000343174",
    messageStatus: 0,
    link: null,
    createTime: "2026-04-18 10:09:20",
  },
  {
    id: "2045321430740238342",
    schoolId: 10406,
    fromUserId: "1000000000000343174",
    fromUserName: "姚宇翔",
    fromUserAvatar: "1872454640621387778",
    businessId: "2045311239208890369",
    messageType: 2,
    messageBusinessType: 0,
    messageTitle: "活动开始",
    messageContent: "您参与的振兴杯（观众）活动已经开始",
    userId: "1000000000000343174",
    messageStatus: 1,
    link: null,
    createTime: "2026-04-18 10:00:04",
  },
  {
    id: "2045321096481849346",
    schoolId: 10406,
    fromUserId: "1835944781623697417",
    fromUserName: "宋秉强",
    fromUserAvatar: "1824130502071164929",
    businessId: "2044091913529290754",
    messageType: 2,
    messageBusinessType: 0,
    messageTitle: "活动结束签退",
    messageContent: "振兴杯（观众）,活动结束签退",
    userId: "1000000000000343174",
    messageStatus: 0,
    link: null,
    createTime: "2026-04-18 09:58:44",
  },
  {
    id: "2045321095928156161",
    schoolId: 10406,
    fromUserId: "1835944781623697417",
    fromUserName: "宋秉强",
    fromUserAvatar: "1824130502071164929",
    businessId: "2044091913529290754",
    messageType: 2,
    messageBusinessType: 0,
    messageTitle: "活动开始签退",
    messageContent: "振兴杯（观众）,活动开始签退",
    userId: "1000000000000343174",
    messageStatus: 0,
    link: null,
    createTime: "2026-04-18 09:58:44",
  },
  {
    id: "2045312204733476865",
    schoolId: 10406,
    fromUserId: "1835962026984472585",
    fromUserName: "周智杰",
    fromUserAvatar: "1824130502071164929",
    businessId: "2045061120249151490",
    messageType: 2,
    messageBusinessType: 0,
    messageTitle: "活动开始签到",
    messageContent: "三瑞智能科技股份有限公司讲座,活动开始签到",
    userId: "1000000000000343174",
    messageStatus: 0,
    link: null,
    createTime: "2026-04-18 09:23:24",
  },
];

const updatedRows = [
  {
    id: "2045325000000000001",
    schoolId: 10406,
    fromUserId: "1835944781623697417",
    fromUserName: "宋秉强",
    fromUserAvatar: "1824130502071164929",
    businessId: "2044091913529290754",
    messageType: 2,
    messageBusinessType: 0,
    messageTitle: "活动开始签退",
    messageContent: "振兴杯（观众）,活动开始签退",
    userId: "1000000000000343174",
    messageStatus: 0,
    link: null,
    createTime: "2026-04-18 10:12:00",
  },
  ...baselineRows,
];

try {
  const messageResponses = [
    {
      code: 200,
      msg: "ok",
      total: baselineRows.length,
      rows: baselineRows,
    },
    {
      code: 200,
      msg: "ok",
      total: updatedRows.length,
      rows: updatedRows,
    },
    {
      code: 200,
      msg: "ok",
      total: updatedRows.length,
      rows: [...updatedRows].reverse(),
    },
  ];
  let messageRequestCount = 0;
  const notifications = [];

  const messageServer = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/messages") {
      if (req.headers.authorization !== "Bearer mock-token") {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ code: 401, msg: "bad token" }));
        return;
      }
      const payload =
        messageResponses[Math.min(messageRequestCount, messageResponses.length - 1)];
      messageRequestCount += 1;
      const { encryptedFlag, encryptedData } = encryptPayload(payload);
      res.writeHead(200, {
        "Content-Type": "application/json",
        "encrypt-flag": encryptedFlag,
      });
      res.end(JSON.stringify({ data: encryptedData }));
      return;
    }

    if (url.pathname === "/unparseable") {
      const { encryptedFlag, encryptedData } = encryptPayload({
        code: 200,
        data: { unexpected: { ok: true } },
      });
      res.writeHead(200, {
        "Content-Type": "application/json",
        "encrypt-flag": encryptedFlag,
      });
      res.end(JSON.stringify({ data: encryptedData }));
      return;
    }

    if (url.pathname === "/unauthorized") {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: 401, msg: "expired" }));
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });

  const notifyServer = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (req.method !== "POST" || !url.pathname.endsWith(".send")) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
      return;
    }
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      notifications.push({
        title: form.get("title"),
        desp: form.get("desp"),
        path: url.pathname,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: 0, message: "ok" }));
    });
  });

  const [messageBaseUrl, notifyBaseUrl] = await Promise.all([
    messageServer.listen(),
    notifyServer.listen(),
  ]);

  process.env.API_BASE_URL = `${messageBaseUrl}/messages`;
  process.env.API_REQUEST_PLAIN = "pageNum=1&pageSize=20";
  process.env.API_BEARER_TOKEN = "mock-token";
  process.env.SERVERCHAN_SENDKEY = "debug-sendkey";
  process.env.SERVERCHAN_BASE_URL = notifyBaseUrl;
  process.env.KEYWORD = "活动开始签到|活动开始签退";
  process.env.REQUEST_TIMEOUT_MS = "5000";
  process.env.NOTIFY_TIMEOUT_MS = "5000";
  delete process.env.API_URL;
  delete process.env.API_REQUEST_ENCRYPT_FLAG;
  delete process.env.POLL_DEBUG_BODY;
  delete process.env.POLL_DEBUG_HEADERS;
  delete process.env.POLL_DEBUG_PARSE;

  const stateFile = path.join(__dirname, "..", "data", "mock-reminder-debug-state.json");
  stateFiles.push(stateFile);
  await fs.rm(stateFile, { force: true });
  process.env.STATE_FILE = stateFile;

  const stateStore = createStateStore(stateFile);
  const firstResult = await runPoll(stateStore);
  assert.equal(firstResult.ok, true);
  assert.equal(firstResult.matchedPath, "rows");
  assert.equal(firstResult.sentNotifications, 0);
  assert.equal(notifications.length, 0);

  const stateAfterFirstPoll = await readStateFile(stateFile);
  assert.equal(stateAfterFirstPoll.initialScanDone, true);
  assert.equal(stateAfterFirstPoll.lastMessageId, baselineRows[0].id);
  assert.equal(stateAfterFirstPoll.seenMessageFingerprints.length, 0);
  console.log("PASS: baseline skipped");

  const secondResult = await runPoll(stateStore);
  assert.equal(secondResult.ok, true);
  assert.equal(secondResult.matchedPath, "rows");
  assert.equal(secondResult.sentNotifications, 1);
  assert.equal(notifications.length, 1);
  assert.match(notifications[0].desp, /ID: 2045325000000000001/);
  assert.match(notifications[0].desp, /命中关键词: 活动开始签退/);
  assert.match(notifications[0].desp, /振兴杯（观众）,活动开始签退/);
  console.log("PASS: multi-keyword message notified");

  const thirdResult = await runPoll(stateStore);
  assert.equal(thirdResult.ok, true);
  assert.equal(notifications.length, 1);
  console.log("PASS: reordered fallback message not re-notified");

  const sameFingerprintA = buildStableMessageFingerprint({
    title: "A",
    content: "B",
    createTime: "2026-04-18T09:00:00Z",
  });
  const sameFingerprintB = buildStableMessageFingerprint({
    content: "B",
    createTime: "2026-04-18T09:00:00Z",
    title: "A",
  });
  assert.equal(sameFingerprintA, sameFingerprintB);
  console.log("PASS: stable fingerprint ignores object key order");

  const bodyWrapped = encryptPayload({ code: 200, data: { records: [] } });
  const extractedFromBody = resolveEncryptedParts({
    headers: {},
    data: JSON.stringify({
      encryptFlag: bodyWrapped.encryptedFlag,
      data: bodyWrapped.encryptedData,
    }),
  });
  assert.equal(extractedFromBody.encryptedFlag, bodyWrapped.encryptedFlag);
  assert.equal(extractedFromBody.encryptedData, bodyWrapped.encryptedData);

  const extractedFromHeader = resolveEncryptedParts({
    headers: { "encrypt-flag": bodyWrapped.encryptedFlag },
    data: JSON.stringify({ data: bodyWrapped.encryptedData }),
  });
  assert.equal(extractedFromHeader.encryptedFlag, bodyWrapped.encryptedFlag);
  assert.equal(extractedFromHeader.encryptedData, bodyWrapped.encryptedData);
  console.log("PASS: encrypted parts resolved from header/body");

  const parseFailStateFile = path.join(__dirname, "..", "data", "mock-reminder-parse-fail-state.json");
  stateFiles.push(parseFailStateFile);
  await fs.rm(parseFailStateFile, { force: true });
  process.env.API_BASE_URL = `${messageBaseUrl}/unparseable`;
  process.env.STATE_FILE = parseFailStateFile;
  const parseFailStore = createStateStore(parseFailStateFile);
  const parseFailResult = await runPoll(parseFailStore);
  assert.equal(parseFailResult.ok, true);
  assert.equal(parseFailResult.parseSucceeded, false);
  const parseFailState = await parseFailStore.read();
  assert.equal(parseFailState.initialScanDone, false);
  console.log("PASS: parse failure does not advance baseline");

  const topLevelRowsStateFile = path.join(__dirname, "..", "data", "mock-reminder-top-level-rows-state.json");
  stateFiles.push(topLevelRowsStateFile);
  await fs.rm(topLevelRowsStateFile, { force: true });
  process.env.STATE_FILE = topLevelRowsStateFile;
  const topLevelRowsStore = createStateStore(topLevelRowsStateFile);
  const topLevelRowsPayload = encryptPayload({
    code: 200,
    msg: "ok",
    total: 1,
    rows: [
      { id: "2045312204733476865", messageTitle: "活动开始签到", messageContent: "讲座活动开始签到" },
    ],
  });
  const topLevelRowsResult = await runPoll(topLevelRowsStore, {
    httpClient: {
      async get() {
        return {
          status: 200,
          headers: { "encrypt-flag": topLevelRowsPayload.encryptedFlag },
          data: topLevelRowsPayload.encryptedData,
        };
      },
    },
  });
  assert.equal(topLevelRowsResult.ok, true);
  assert.equal(topLevelRowsResult.parseSucceeded, true);
  assert.equal(topLevelRowsResult.matchedPath, "rows");
  assert.equal(topLevelRowsResult.notifyCandidates, 1);
  console.log("PASS: top-level rows message list parsed");

  const unauthorizedStateFile = path.join(__dirname, "..", "data", "mock-reminder-unauthorized-state.json");
  stateFiles.push(unauthorizedStateFile);
  await fs.rm(unauthorizedStateFile, { force: true });
  process.env.API_BASE_URL = `${messageBaseUrl}/unauthorized`;
  process.env.STATE_FILE = unauthorizedStateFile;
  const unauthorizedStore = createStateStore(unauthorizedStateFile);
  const unauthorizedResult = await runPoll(unauthorizedStore, {
    notifier: async () => false,
  });
  assert.equal(unauthorizedResult.ok, false);
  assert.equal(unauthorizedResult.reason, "unauthorized");
  const unauthorizedState = await unauthorizedStore.read();
  assert.equal(unauthorizedState.lastTokenAlertAt, null);
  console.log("PASS: failed token alert does not enter cooldown");

  await Promise.all([messageServer.close(), notifyServer.close()]);
} catch (err) {
  console.error("FAIL:", err?.stack || err);
  process.exitCode = 1;
} finally {
  for (const [key, value] of Object.entries(originalEnv)) {
    process.env[key] = value;
  }
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) {
      delete process.env[key];
    }
  }
  for (const filePath of stateFiles) {
    await fs.rm(filePath, { force: true }).catch(() => {});
  }
}
