// archive.js —— 可选的长归档: 扩展推来的条目流式追加到本地 JSONL。
//
// 为什么需要: 扩展侧 chrome.storage.local 只有 10MB, 靠 3000 条上限硬扛。
// 这里多存一份(不挪走扩展里的), 便于事后按天手工翻查。
// 设计: 按天一个文件, 追加写, 单行一条 JSON。不写索引。
// ⚠ **只写不读**(v1.1.79 明确): MCP 侧目前**没有**归档查询工具, 工具面只拿到
//   { append, close, stats }。所以"AI 能回看更长历史"目前不成立 —— 要读请直接看
//   <archive-dir>/harvest-YYYY-MM-DD.jsonl(每行 {batchId, archivedAt, entry})。
//   补查询工具是个产品决策(会改工具计数与文档/闸门), 留待明确要求再做。
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

  /**
   * 归档现状(只读聚合): 有没有在写、写了多少、最后一天是哪天。
   * 为什么需要: 开了 --archive-dir 却无从判断它是否在工作 —— 用户只能去翻目录。
   * 只读文件名与行数, 不解析内容(不做索引是本文件的既定设计)。
   * @returns {{dir: string, enabled: boolean, files: number, bytes: number, lines: number, days: string[], latest: string|null}}
   */
  stats() {
    const out = { dir: this.dir, enabled: this.enabled, files: 0, bytes: 0, lines: 0, days: [], latest: null };
    let names = [];
    try { names = fs.readdirSync(this.dir); } catch { return out; }
    for (const name of names) {
      const m = /^harvest-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name);
      if (!m) continue;
      out.files++;
      out.days.push(m[1]);
      try {
        const p = path.join(this.dir, name);
        out.bytes += fs.statSync(p).size;
        // 行数 = 换行符数(不 JSON.parse 全文, 大文件也不心疼)
        const text = fs.readFileSync(p, "utf8");
        let n = 0; for (let i = 0; i < text.length; i++) if (text[i] === "\n") n++;
        out.lines += n;
      } catch { /* 读不了就只统计文件数 */ }
    }
    out.days.sort();
    out.latest = out.days.length ? out.days[out.days.length - 1] : null;
    return out;
  }

  close() {
    if (this.stream) {
      try { this.stream.end(); } catch { /* ignore */ }
      this.stream = null;
    }
  }
}
