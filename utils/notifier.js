import axios from "axios";

const DEFAULT_SERVERCHAN_BASE_URL = "https://sctapi.ftqq.com";

function buildServerChanUrl(sendkey, baseUrl) {
  const root = String(baseUrl || DEFAULT_SERVERCHAN_BASE_URL).trim().replace(/\/+$/, "");
  return `${root}/${encodeURIComponent(String(sendkey).trim())}.send`;
}

/**
 * 通用推送：默认走 Server酱³ HTTP API。
 * 失败仅 console.error，不向调用方抛错，避免拖垮主进程。
 *
 * @param {string} title
 * @param {string} content - 对应 Server酱 的 desp
 * @param {{ baseUrl?: string, httpClient?: typeof axios }} [options]
 * @returns {Promise<boolean>}
 */
export async function sendNotification(title, content, options = {}) {
  const sendkey = process.env.SERVERCHAN_SENDKEY;
  if (!sendkey || !String(sendkey).trim()) {
    console.error("[notifier] SERVERCHAN_SENDKEY 未设置，跳过推送:", title);
    return false;
  }

  const httpClient = options.httpClient ?? axios;
  const url = buildServerChanUrl(
    sendkey,
    options.baseUrl ?? process.env.SERVERCHAN_BASE_URL
  );

  try {
    const body = new URLSearchParams();
    body.set("title", String(title ?? ""));
    body.set("desp", String(content ?? ""));

    const res = await httpClient.post(url, body.toString(), {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: Number(process.env.NOTIFY_TIMEOUT_MS) || 20000,
      validateStatus: () => true,
    });

    if (res.status < 200 || res.status >= 300) {
      console.error(
        "[notifier] Server酱 返回非成功状态:",
        res.status,
        typeof res.data === "string" ? res.data : JSON.stringify(res.data)
      );
      return false;
    }
    return true;
  } catch (err) {
    console.error("[notifier] Server酱 请求失败:", err?.message || err);
    return false;
  }
}
