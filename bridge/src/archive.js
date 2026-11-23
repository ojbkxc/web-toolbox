// archive.js —— 可选的长归档: 扩展推来的条目流式追加到本地 JSONL。
//
// 为什么需要: 扩展侧 chrome.storage.local 只有 10MB, 靠 3000 条上限硬扛。
// 这里多存一份(不挪走扩展里的), 让 AI 能回看更长的历史。
// 设计: 按天一个文件, 追加写, 单行一条 JSON。不写索引 —— 需要查询时由 MCP 侧扫描。
//
// 隐私: 只落扩展推上来的内容, 与扩展里的数据同源同口径, 不做额外外发。
// 清理: keepDays > 0 时, init() 会删掉比"今天 - keepDays"更早的 harvest-YYYY-MM-DD.jsonl。
// 默认 0 = 不清理 —— 删数据是不可逆动作, 必须用户显式要。

import fs from "node:fs";
import path from "node:path";

export class Archive {
  constructor(dir, { keepDays = 0 } = {}) {
    this.dir = dir;
    this.enabled = false;
    this.stream = null;
    this.day = null;
    this.keepDays = keepDays;
  }

  async init() {
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      this.enabled = true;
      if (this.keepDays > 0) this.pruned = this.prune(this.keepDays);
      return true;
    } catch {
      this.enabled = false;
      return false;
    }
  }

  /**
   * 删除超过保留期的日归档。只认 harvest-YYYY-MM-DD.jsonl 这个名字, 其它文件一律不动。
   * @param {number} keepDays >0
   * @returns {{removed: string[], kept: number}}
   */
  prune(keepDays = this.keepDays, { dryRun = false } = {}) {
    const removed = [];
    let kept = 0;
    if (!(keepDays > 0)) return { removed, kept };
    const cutoff = new Date(Date.now() - keepDays * 24 * 3600 * 1000).toISOString().slice(0, 10);
    let names = [];
    try { names = fs.readdirSync(this.dir); } catch { return { removed, kept }; }
    for (const name of names) {
      const m = /^harvest-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name);
      if (!m) continue;
      if (m[1] < cutoff) {
        if (dryRun) { removed.push(name); continue; }
        try { fs.unlinkSync(path.join(this.dir, name)); removed.push(name); }
        catch { kept++; }
      } else kept++;
    }
    return { removed, kept };
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
