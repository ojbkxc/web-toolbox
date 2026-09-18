// 扫描同页串联 script 的顶层声明撞名(解析期 SyntaxError 会杀整个后续文件)。
// 用法: node scan_conflicts.js <html绝对路径> <script根目录>
// 默认扫 sidepanel; 也可扫 popup(quickExport 加入后新增 6 个同页文件)。
const fs = require("fs");
const ROOT = require('path').resolve(__dirname, '..');
const path = require("path");

function topLevelDecls(src) {
  const names = new Map();
  let depth = 0, i = 0, line = 1;
  const isWord = (c) => /[A-Za-z0-9_$]/.test(c);
  while (i < src.length) {
    const c = src[i];
    if (c === "\n") { line++; i++; continue; }
    if (c === "{") { depth++; i++; continue; }
    if (c === "}") { depth--; i++; continue; }
    if (c === '"' || c === "'" || c === "`") {
      const q = c; i++;
      while (i < src.length && src[i] !== q) {
        if (src[i] === "\\") i++;
        if (src[i] === "\n") line++;
        i++;
      }
      i++; continue;
    }
    if (c === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) { if (src[i] === "\n") line++; i++; }
      i += 2; continue;
    }
    if (depth === 0 && isWord(c)) {
      let j = i, w = "";
      while (j < src.length && isWord(src[j])) { w += src[j]; j++; }
      const before = src.slice(Math.max(0, i - 24), i);
      const isDecl =
        /(?:^|\n|\s|;|\))(?:const|let|var|class)\s+$/.test(before) ||
        /(?:^|\n|\s|;)\s*function\s+$/.test(before) ||
        /^function\s*$/.test(before.trim());
      if (isDecl) {
        if (!names.has(w)) names.set(w, []);
        names.get(w).push(line);
      }
      i = j; continue;
    }
    i++;
  }
  return names;
}

const targets = process.argv.length > 2
  ? [{ html: process.argv[2], root: process.argv[3] }]
  : [
      { html: ROOT + "/sidepanel/sidepanel.html", root: ROOT + "/sidepanel" },
      { html: ROOT + "/popup/popup.html", root: ROOT + "/popup" },
    ];

let conflicts = 0;
for (const t of targets) {
  const html = fs.readFileSync(t.html, "utf8");
  const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
  const all = new Map();
  for (const rel of scripts) {
    const fp = path.resolve(t.root, rel);
    const src = fs.readFileSync(fp, "utf8");
    for (const [name, lines] of topLevelDecls(src)) {
      if (!all.has(name)) all.set(name, []);
      for (const ln of lines) all.get(name).push(path.basename(path.dirname(fp)) + "/" + path.basename(fp) + ":" + ln);
    }
  }
  for (const [name, locs] of [...all].sort()) {
    const filesSet = new Set(locs.map((l) => l.split("/")[1].split(":")[0]));
    if (filesSet.size > 1) {
      conflicts++;
      console.log("CONFLICT " + name + " -> " + locs.join(" | "));
    }
  }
}
console.log(conflicts ? "=== " + conflicts + " 个撞名 ===" : "=== 无撞名(sidepanel+popup) ===");
process.exit(conflicts ? 1 : 0);
