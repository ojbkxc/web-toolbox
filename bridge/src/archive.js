// archive.js —— 可选的长归档: 扩展推来的条目流式追加到本地 JSONL。
//
// 为什么需要: 扩展侧 chrome.storage.local 只有 10MB, 靠 3000 条上限硬扛。
// 这里多存一份(不挪走扩展里的), 让 AI 能回看更长的历史。
// 设计: 按天一个文件, 追加写, 单行一条 JSON。不写索引 —— 需要查询时由 MCP 侧扫描。
//
// 隐私: 只落扩展推上来的内容, 与扩展里的数据同源同口径, 不做额外外发。

import fs from "node:fs";
import path from "node:path";

export class Archive {
  constructor(dir) {
    this.dir = dir;
    this.enabled = false;
    this.stream = null;
    this.day = null;
  }

  async init() {
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      this.enabled = true;
      return true;
    } catch {
      this.enabled = false;
      return false;
    }
  }

  _fileFor(day) {
    return path.join(this.dir, `harvest-${day}.jsonl`);
  }

  append(entries, { batchId } = {}) {
    if (!this.enabled || !Array.isArray(entries) || !entries.length) return 0;
    const day = new Date().toISOString().slice(0, 10);
    if (day !== this.day) {
      if (this.stream) { try { this.stream.end(); } catch { /* ignore */ } }
      this.day = day;
      this.stream = fs.createWriteStream(this._fileFor(day), { flags: "a", mode: 0o600 });
    }
    let n = 0;
    for (const e of entries) {
      try {
        this.stream.write(JSON.stringify({ batchId: batchId || null, archivedAt: new Date().toISOString(), entry: e }) + "\n");
        n++;
      } catch {
        break; // 磁盘满等情况: 停下, 不拖累主流程
      }
    }
    return n;
  }

  close() {
    if (this.stream) {
      try { this.stream.end(); } catch { /* ignore */ }
      this.stream = null;
    }
  }
}
