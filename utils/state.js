import fs from "fs/promises";
import path from "path";

const defaultState = () => ({
  lastMessageId: null,
  lastTokenAlertAt: null,
  /** 首次成功拉取并完成基线后设为 true，避免第一次把历史消息全部推送 */
  initialScanDone: false,
});

/**
 * 读写本地 JSON 状态（最新消息 ID、Token 告警时间等）。
 * 写入使用临时文件 + rename，降低异常断电时文件损坏概率。
 */
export class MessageStateStore {
  /**
   * @param {string} filePath - 绝对路径或相对于 cwd 的路径
   */
  constructor(filePath) {
    this.filePath = path.resolve(filePath);
  }

  async ensureDir() {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
  }

  /**
   * @returns {Promise<{ lastMessageId: string | null, lastTokenAlertAt: number | null, initialScanDone: boolean }>}
   */
  async read() {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const data = JSON.parse(raw);
      return {
        ...defaultState(),
        lastMessageId:
          data.lastMessageId != null ? String(data.lastMessageId) : null,
        lastTokenAlertAt:
          typeof data.lastTokenAlertAt === "number"
            ? data.lastTokenAlertAt
            : null,
        initialScanDone: Boolean(data.initialScanDone),
      };
    } catch (e) {
      if (e && (e.code === "ENOENT" || e.code === "ENOTDIR")) {
        return defaultState();
      }
      throw e;
    }
  }

  /**
   * @param {Partial<{ lastMessageId: string | null, lastTokenAlertAt: number | null, initialScanDone: boolean }>} patch
   */
  async write(patch) {
    await this.ensureDir();
    const prev = await this.read();
    const next = { ...prev, ...patch };
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(next, null, 2), "utf8");
    await fs.rename(tmp, this.filePath);
  }
}
