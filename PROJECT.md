# MessagesReminder 项目说明

## 1. 项目简介

MessagesReminder 是一个运行在 Node.js 上的**常驻服务**：按固定周期请求第三方**加密消息列表接口**，在本地解密响应后，根据**关键词**筛选「新消息」，并通过 **Server酱（Server酱³）** 推送到微信等渠道。

典型场景：学校或活动平台的消息中心接口使用 **RSA + AES** 与前端约定加解密，本仓库内置与前端一致的加解密逻辑（见 `decrypt-response.mjs`），在服务端完成轮询与提醒，无需浏览器。

---

## 2. 核心能力

| 能力 | 说明 |
|------|------|
| 请求侧加密 | 支持「动态明文加密」（每轮新 `encrypt-flag` + `params`）或「静态抓包 URL 重放」。 |
| 响应解密 | 从响应头或 JSON 中取 `encrypt-flag` 与密文体，用内置私钥流程解密为 JSON。 |
| 消息列表解析 | 从解密结果中按多种常见路径（如 `data.records`、`data.list` 等）提取数组；可扩展 `MESSAGE_LIST_CANDIDATES`。 |
| 新消息判定 | 为每条消息生成稳定 `id`，与本地 `lastMessageId` 比较；仅当 id **大于** 已记录值时视为新消息。 |
| 关键词提醒 | 默认关键词为 **「活动开始签到」**（常量 `KEYWORD`，可在 `index.js` 中修改）。 |
| 首轮不刷屏 | 首次成功拉取后设置 `initialScanDone`，避免把历史消息一次性全部推送。 |
| Token 告警 | 接口返回 401/403 时经 Server酱 提示更新 Token，并受 `TOKEN_ALERT_COOLDOWN_MS` 节流。 |

---

## 3. 技术栈与运行要求

- **运行时**：Node.js **≥ 18**（`package.json` 中 `engines`）。
- **依赖**：`axios`、`dotenv`、`node-cron`；加解密基于 Node `crypto`。
- **网络**：需能访问消息接口域名与 Server酱 API（`sctapi.ftqq.com`）。
- **磁盘**：需在项目目录（或 `STATE_FILE` 指定路径）**可写**，用于 `last_state.json`。

---

## 4. 仓库结构（主要文件）

| 路径 | 作用 |
|------|------|
| `index.js` | 入口：轮询、cron、解密、解析、提醒与状态更新。 |
| `decrypt-response.mjs` | 请求加密 `encryptRequest`、响应解密 `decryptResponse` 及 RSA/AES 实现。 |
| `crypto-utils.js` | 对 `decrypt-response.mjs` 的再导出。 |
| `utils/state.js` | 本地 JSON 状态读写（原子写入）。 |
| `utils/notifier.js` | Server酱 HTTP 推送。 |
| `data/` | 默认存放 `last_state.json`（勿将含隐私的状态文件提交到公开仓库）。 |
| `.env` / `.env.example` | 环境变量；**`.env` 不应入库**。 |

---

## 5. 配置说明（环境变量）

配置从 **`.env`** 加载（`import "dotenv/config"`）。以下按重要性分组；完整示例见 `.env.example`。

### 5.1 接口与鉴权（必填项）

- **`API_BEARER_TOKEN`**：HTTP `Authorization: Bearer <token>` 中的 **token 本体**（不要带 `Bearer ` 前缀）。
- **方式 A（动态加密，推荐长期使用）**  
  - **`API_BASE_URL`**：列表接口 URL，**不含** `?params=`。  
  - **`API_REQUEST_PLAIN`** 或 **`API_REQUEST_PLAIN_JSON`**：加密前的明文，须与前端一致；**不要**写成 `params=pageNum=1&...`，只能是参数体（如 `pageNum=1&pageSize=10`）或 JSON。  
  - 可选 **`API_PARAMS_ENCODING`**：`plus`（默认）或 `uri`（整段 Base64 再 `encodeURIComponent`）。  
- **方式 B（静态重放）**  
  - **`API_URL`**：浏览器 Network 中复制的**完整 URL**（含 `params=` 密文）。  
  - 可选 **`API_REQUEST_ENCRYPT_FLAG`**：与本次 `params` **同一次抓包**的请求头 `encrypt-flag`（与**响应**里用于解密的 `encrypt-flag` 不是同一用途）。

**注意**：若同时配置了方式 A 所需项与有效明文，逻辑会优先走动态加密；仅重放时请避免误开 `API_BASE_URL` + 明文。

### 5.2 推送与状态

- **`SERVERCHAN_SENDKEY`**：Server酱³ 的 SendKey；未配置则只打日志、不推送。  
- **`STATE_FILE`**：状态文件路径，默认 `./data/last_state.json`。

### 5.3 可选 HTTP / 调试

- **`API_REFERER`**、`HTTP_USER_AGENT`**、`HTTP_ACCEPT`**、`HTTP_X_CLIENT_TYPE`**：与网关或风控对齐时使用。  
- **`REQUEST_TIMEOUT_MS`**、`NOTIFY_TIMEOUT_MS`**、`TOKEN_ALERT_COOLDOWN_MS`**。  
- **`POLL_DEBUG_BODY`**、`POLL_DEBUG_HEADERS`**、`POLL_DEBUG_PARSE`**：调试日志（生产环境建议关闭）。  
- **`ENCRYPT_FLAG_HEADER`**：响应中加密标记头名非 `encrypt-flag` 时使用。  
- **`CRON_TZ`**：定时任务时区，默认 `Asia/Shanghai`。

---

## 6. 本地运行

```bash
npm install
# 复制 .env.example 为 .env 并填写
npm start
```

开发时可使用 `npm run dev`（Node `--watch`）。

---

## 7. 部署到阿里云（重要）

本项目是 **长时间运行的单进程 + 内置定时器**，**不适合**作为「无状态、秒级 HTTP 函数」直接替换；在阿里云上应以 **能 7×24 运行 Node 的环境**为主。

### 7.1 推荐形态

| 形态 | 说明 |
|------|------|
| **轻量应用服务器** | 成本低、流程简单，适合个人或小流量。 |
| **云服务器 ECS** | 与轻量类似，网络与规格选型更灵活。 |

容器服务（ACK / 单机 Docker）亦可：需保证 **容器常驻**、**持久化或挂载** `STATE_FILE` 所在目录。

**不推荐**：仅静态网站托管、对象存储；**函数计算 FC** 需改造为「定时触发 + 单次拉取」模式，与本项目当前「进程内 cron」模型不一致，运维成本更高。

### 7.2 网络与安全组

- 本服务**默认不监听 HTTP 端口**（无对外 Web 接口），**无需**为业务开放 80/443。  
- 安全组建议仅开放 **SSH（22）**，且尽量限制来源 IP；通过 SSH 维护进程与日志。  
- 确保出站可访问：**消息接口 HTTPS**、**Server酱 API**（`sctapi.ftqq.com`）。

### 7.3 服务器环境

1. 安装 **Node.js ≥ 18**（可用 nvm、NodeSource 等）。  
2. 将代码同步到服务器（`git clone` 或 `scp`）；**勿**将含密钥的 `.env` 提交到公开 Git。  
3. 在服务器创建 **`.env`**（可从 `.env.example` 复制），填入生产环境 Token、URL、SendKey 等。  
4. 执行 `npm ci --omit=dev` 或 `npm install --omit=dev` 安装依赖。  
5. 确认 `STATE_FILE` 路径可写（默认 `./data/`）。

### 7.4 进程守护（必做）

SSH 断开后 `npm start` 会退出，必须使用 **进程管理**：

**方案 A：PM2（常用）**

```bash
npm install -g pm2
cd /path/to/MessagesReminder
pm2 start index.js --name messages-reminder
pm2 save
pm2 startup   # 按屏幕提示执行一条命令，实现开机自启
```

查看日志：`pm2 logs messages-reminder`。

**方案 B：systemd**

编写 `User` 为非 root、`WorkingDirectory` 指向项目目录、`ExecStart=/usr/bin/node .../index.js` 的 unit，`systemctl enable --now`。

### 7.5 时区与定时

- 代码中 cron 使用 **`CRON_TZ` 环境变量**（未设置时默认为 `Asia/Shanghai`）。  
- 建议服务器系统时区与预期一致（如 `timedatectl set-timezone Asia/Shanghai`），或与 `.env` 中 `CRON_TZ` 统一，避免「每分钟轮询」与本地理解偏差。

### 7.6 上线后运维要点

| 项目 | 说明 |
|------|------|
| **密钥与 `.env`** | 权限建议 `chmod 600 .env`；轮换 Token / SendKey 后重启进程。 |
| **状态文件** | `last_state.json` 记录游标与首轮标记；迁移服务器时可拷贝该文件以保持「已读」连续性。 |
| **日志** | 通过 PM2 / systemd 采集；生产环境关闭 `POLL_DEBUG_*`，减少敏感信息落盘。 |
| **监控** | 可配合云监控或简单脚本检测进程存活；接口连续失败时检查 Token 与网络。 |

### 7.7 阿里云上常见补充项（按需）

- **域名 / 证书**：本服务不对外提供 HTTP，一般**不需要**绑定域名。  
- **备份**：定期备份 `STATE_FILE` 与 `.env`（加密保管）。  
- **费用**：轻量/ECS 按规格与带宽计费；出站流量访问公网 API 通常计入实例带宽。

---

## 8. 提醒逻辑摘要

1. 启动后立即执行一轮拉取，之后**每分钟**（cron 表达式 `*/1 * * * *`）执行一轮。  
2. 解密成功后从 JSON 中取消息列表，为每条消息计算 `id`，与 `lastMessageId` 比较。  
3. 仅当 **id 新于** `lastMessageId`、且拼接正文中包含 **关键词**、且 **`initialScanDone` 已为 true**（即非首次成功轮询）时，发送 Server酱。  
4. 每轮结束更新状态：`initialScanDone` 置为 `true`；若列表最大 id 变化则更新 `lastMessageId`。

修改关键词：编辑 `index.js` 中的 `KEYWORD`。

---

## 9. 故障排查提示

- **HTTP 500**：尝试 `API_PARAMS_ENCODING=uri`、改用 JSON 明文（`API_REQUEST_PLAIN_JSON`）等（见运行日志中的 `[poll] 500 排查`）。  
- **解密失败**：确认响应头/体与前端约定一致；可临时开启 `POLL_DEBUG_BODY`。  
- **`lastMessageId` 不更新**：多为列表路径未匹配，开启 `POLL_DEBUG_PARSE`，按解密对象结构扩展 `MESSAGE_LIST_CANDIDATES`。  
- **无推送**：检查 `SERVERCHAN_SENDKEY`、是否处于首轮、关键词是否命中。

---

## 10. 许可与免责

使用第三方接口与推送服务时，请遵守各平台用户协议与频率限制；本项目按原样提供，使用者自行承担合规与安全责任。
