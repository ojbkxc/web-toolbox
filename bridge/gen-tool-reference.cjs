// docs/tool-reference.md 由 tools.js **生成**而非手写 —— 手写必然漂移(R9 已实证)。
// 生成器: 逐工具抽出 name/title/description/输入参数(含 describe)/注解/结构化标记,
// 按四层分组输出。闸门对比生成产物与入库文件:**逐字节一致**, 否则提示重新生成。
const fs = require("fs");
const path = require("path");
const ROOT = "D:/GitHub/web-toolbox";
const src = fs.readFileSync(path.join(ROOT, "bridge", "src", "tools.js"), "utf8");

// 抽 annotation 表
const annBlock = src.slice(src.indexOf("const ANNOTATIONS = {"), src.indexOf("};", src.indexOf("const ANNOTATIONS = {")));
const ann = {};
for (const m of annBlock.matchAll(/^\s{2}([a-z_]+):\s*\{([^}]*)\},?$/gm)) {
  const body = m[2];
  const get = (k) => (body.match(new RegExp(k + ":\\s*(true|false)")) || [])[1] === "true";
  ann[m[1]] = { ro: get("readOnlyHint"), de: get("destructiveHint") };
}

// 工具块
const names = [...src.matchAll(/\bregister\("([^"]+)"/g)].map((m) => m[1]);
const tools = names.map((n, i) => {
  const start = src.indexOf(`register("${n}"`);
  const end = i + 1 < names.length ? src.indexOf(`register("${names[i + 1]}"`) : src.length;
  const block = src.slice(start, end);
  const title = (block.match(/title:\s*"([^"]*)"/) || [])[1] || n;
  const desc = (block.match(/description:\s*(?:"([^"]*)"|\n?\s*"([^"]*)")/) || [])[1] || "";
  const isControl = /controlGuard\("/.test(block);
  const isStructured = /return structured\(|structuredContent:/.test(block);
  // 参数: inputSchema 顶层字段 + describe
  const params = [];
  const io = block.indexOf("inputSchema:");
  if (io >= 0) {
    const open = block.indexOf("{", io);
    let depth = 0, j = open;
    for (; j < block.length; j++) {
      if (block[j] === "{") depth++;
      else if (block[j] === "}") { depth--; if (!depth) break; }
    }
    const region = block.slice(open, j + 1);
    for (const line of region.split(/\r?\n/)) {
      const sp = line.match(/^      \.\.\.(\w+)/);
      if (sp) { params.push({ spread: sp[1] }); continue; }
      const fm = line.match(/^      ([A-Za-z_][\w]*):\s*(.+)$/);
      if (!fm) continue;
      const d = (fm[2].match(/describe\("([^"]*)"\)/) || [])[1] || "";
      const opt = /\.optional\(\)/.test(fm[2]) ? "?" : "";
      const type = (fm[2].match(/^z\.(\w+)/) || [])[1] || "";
      params.push({ name: fm[1] + opt, type, d });
    }
  }
  return { n, title, desc, isControl, isStructured, params, a: ann[n] || {} };
});

// 分组
const groups = [
  ["状态与抓包(只读)", ["bridge_status", "net_list", "net_get", "net_hosts", "tab_list"]],
  ["导出与关联(只读)", ["export_har", "export_jmx", "export_python", "correlate"]],
  ["控制台", ["console_read", "console_clear"]],
  ["录制控制", ["rec_start", "rec_stop"]],
  ["标签页", ["tab_navigate", "tab_activate", "tab_close"]],
  ["页面操作", ["page_snapshot", "page_click", "page_type", "page_press", "page_hover", "page_select", "page_scroll", "page_wait", "page_screenshot", "page_eval"]],
  ["回归", ["chain_replay"]],
];

const L = [];
L.push("# 工具参考(Tool Reference)");
L.push("");
L.push("> 本文件由 \`node bridge/gen-tool-reference.js > docs/tool-reference.md\` **生成**, 不要手改。");
L.push("> 源头是 \`bridge/src/tools.js\`(name/title/描述/参数/注解), 漂移会在 \`check_doc_counts\` 闸门红。");
L.push("");
for (const [g, ns] of groups) {
  L.push(`## ${g}`);
  L.push("");
  for (const n of ns) {
    const t = tools.find((x) => x.n === n);
    if (!t) continue;
    L.push(`### \`${n}\``);
    L.push("");
    L.push(t.title + (t.desc ? " — " + t.desc : ""));
    L.push("");
    // 参数表
    if (t.params.length) {
      L.push("| 参数 | 类型 | 说明 |");
      L.push("|---|---|---|");
      for (const p of t.params) {
        if (p.spread) {
          L.push("| ..." + p.spread + " | | 通用过滤(见 net_list 的过滤参数) |");
        } else {
          L.push("| `" + p.name + "` | " + p.type + " | " + p.d + " |");
        }
      }
      L.push("");
    }
    // 标记行
    const marks = [];
    if (t.a.ro) marks.push("只读");
    if (t.a.de) marks.push("破坏性");
    if (t.isControl) marks.push("需 \`--allow-control\`");
    if (t.isStructured) marks.push("结构化返回");
    if (marks.length) { L.push("> " + marks.join(" · ")); L.push(""); }
  }
}
L.push("");

fs.writeFileSync(path.join(ROOT, "docs", "tool-reference.md"), L.join("\n") + "\n");
console.log("生成完成:", tools.length, "工具,", L.length, "行");