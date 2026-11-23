// check_tool_table.js —— 工具表 ↔ 实现一致性闸门(零依赖)。
//
// 追的是一类"文档说有能力/说不用权限, 实现却不是"的漂移:
//   1. 每个 register(...) 的工具都必须在 bridge/README 的「工具一览」表里出现
//      (v1.1.1 加的 chain_replay/console_read/console_clear 曾长期漏在表外);
//   2. 表里点名但代码没有的"工具"要显式进白名单(否则就是文档吹牛);
//   3. 表格"需要 --allow-control"列(✓)必须与 tools.js 里是否调 controlGuard 严格一致 ——
//      标错会让用户/模型以为不需权限, 真调时被 forbidden 打回。
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "bridge", "src", "tools.js"), "utf8");
const README = fs.readFileSync(path.join(ROOT, "bridge", "README.md"), "utf8");

const fail = [];
const ok = (name, cond, got) => {
  if (cond) console.log("  OK " + name);
  else { fail.push(name); console.log("FAIL " + name + " → " + JSON.stringify(got)); }
};

// ---- 实现侧 ----
const names = [...SRC.matchAll(/\bregister\("([a-z_]+)"/g)].map((m) => m[1]);
const guarded = {};   // tool -> method
names.forEach((n, i) => {
  const start = SRC.indexOf(`register("${n}"`);
  const end = i + 1 < names.length ? SRC.indexOf(`register("${names[i + 1]}"`) : SRC.length;
  const g = SRC.slice(start, end).match(/controlGuard\("([a-z.]+)"\)/);
  if (g) guarded[n] = g[1];
});

// ---- 文档侧: 只认表格行 | `name` ... | ---- 
const secStart = README.indexOf("## 工具一览");
const secEnd = README.indexOf("\n## ", secStart + 3);
const section = README.slice(secStart, secEnd > 0 ? secEnd : README.length);
// 列必须按表头名字定位: 表格已不止一列带 ✓(控制/结构化), 再"整行找 ✓"就会互相误判。
const headerLine = section.split(/\r?\n/).find((l) => /^\|\s*工具\s*\|/.test(l)) || "";
const header = headerLine.split("|").map((c) => c.trim());
const colControl = header.findIndex((h) => h.includes("--allow-control"));
const colStructured = header.findIndex((h) => h.includes("结构化"));
ok("表头有'需要 --allow-control'列", colControl > 1, header);
ok("表头有'结构化返回'列", colStructured > 1, header);

const rows = section.split(/\r?\n/).filter((l) => /^\|\s*`/.test(l));
const documented = [];
const docGuarded = {};
const docStructured = {};
for (const row of rows) {
  const cells = row.split("|").map((c) => c.trim());
  const toolCell = cells[1] || "";
  for (const m of toolCell.matchAll(/`([a-z_]+)`/g)) {
    documented.push(m[1]);
    docGuarded[m[1]] = /✓/.test(cells[colControl] || "");
    docStructured[m[1]] = /✓/.test(cells[colStructured] || "");
  }
}

ok("表格行数 > 0", rows.length > 0, rows.length);
const missingInDoc = names.filter((n) => !documented.includes(n));
ok("所有工具都在文档表里", missingInDoc.length === 0, missingInDoc);

const NOT_TOOLS = new Set(["annotations"]);   // 段落里的术语, 不是工具名
const docNotImpl = documented.filter((n) => !names.includes(n) && !NOT_TOOLS.has(n));
ok("文档表没有'有文档无实现'的工具", docNotImpl.length === 0, docNotImpl);

const mislabel = [];
for (const n of names) {
  if (!(n in docGuarded)) continue;
  const impl = !!guarded[n];
  const doc = docGuarded[n];
  if (impl !== doc) mislabel.push({ tool: n, implNeedsControl: impl, docMarksControl: doc });
}
ok("'需要 --allow-control' 列与实现一致", mislabel.length === 0, mislabel);

// 结构化列: 实现里 block 出现 structured( 或 structuredContent: 就得标 ✓, 反之不许标
const structuralMislabel = [];
for (const n of names) {
  if (!(n in docStructured)) continue;
  const start = SRC.indexOf(`register("${n}"`);
  const end = names.indexOf(n) + 1 < names.length ? SRC.indexOf(`register("${names[names.indexOf(n) + 1]}"`) : SRC.length;
  const block = SRC.slice(start, end);
  const impl = /return structured\(|structuredContent:/.test(block);
  if (impl !== docStructured[n]) structuralMislabel.push({ tool: n, implStructured: impl, docMarksStructured: docStructured[n] });
}
ok("'结构化返回' 列与实现一致", structuralMislabel.length === 0, structuralMislabel);

ok("执行器覆盖到回归/控制台三类", ["chain_replay", "console_read", "console_clear"].every((n) => names.includes(n)),
  names.filter((n) => /chain|console/.test(n)));

console.log(fail.length ? `=== tool table FAIL: ${fail.length} ===` : `=== tool table PASS (${names.length} 工具 / ${rows.length} 行) ===`);
process.exit(fail.length ? 1 : 0);
