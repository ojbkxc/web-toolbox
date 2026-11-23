// check_bridge_annotations.js —— MCP 工具注解契约(零依赖, 源码级走查):
//   1. ANNOTATIONS 表与 register("...") 注册集**互为子集**(漏一个 = 客户端无处判断副作用);
//   2. readOnlyHint 必须是布尔; destructiveHint=true 时 readOnlyHint 必须 false(语义自洽);
//   3. 走控制白名单的工具不得标只读 —— 已复核的读例外只有 page.snapshot / page.screenshot /
//      page.wait(读 DOM/画面, 但需要 debugger attach, 因此仍在 --allow-control 之后);
//   4. 不走控制闸门的工具必须标只读(否则客户端会为一次纯读弹确认);
//   5. tool→method 映射必须落在 bridge-protocol 的 READ_METHODS ∪ CONTROL_METHODS 白名单内。
// 为什么要这层: 注解是**协议层**承诺, 写错了客户端就按错的假设自动放行 —— 比不写更危险。
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const ROOT = path.resolve(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "bridge", "src", "tools.js"), "utf8");
const protocol = require(path.join(ROOT, "bridge-protocol.js"));

const fail = [];
const ok = (name, cond, got) => {
  if (cond) console.log("  OK " + name);
  else { fail.push(name); console.log("FAIL " + name + " → " + JSON.stringify(got)); }
};

// ---- 解析 ANNOTATIONS 表 ----
const tableBlock = SRC.slice(SRC.indexOf("const ANNOTATIONS = {"), SRC.indexOf("};", SRC.indexOf("const ANNOTATIONS = {")));
const table = {};
for (const m of tableBlock.matchAll(/^\s{2}([a-z_]+):\s*\{([^}]*)\},?$/gm)) {
  const body = m[2];
  const get = (k) => {
    const mm = body.match(new RegExp(k + ":\\s*(true|false)"));
    return mm ? mm[1] === "true" : undefined;
  };
  table[m[1]] = {
    readOnlyHint: get("readOnlyHint"),
    destructiveHint: get("destructiveHint"),
    idempotentHint: get("idempotentHint"),
    openWorldHint: get("openWorldHint"),
  };
}

// ---- 解析注册的工具块 ----
const names = [...SRC.matchAll(/\bregister\("([a-z_]+)"/g)].map((m) => m[1]);
const blocks = {};
names.forEach((n, i) => {
  const start = SRC.indexOf(`register("${n}"`);
  const end = i + 1 < names.length ? SRC.indexOf(`register("${names[i + 1]}"`) : SRC.length;
  blocks[n] = SRC.slice(start, end);
});
const guarded = {};
for (const [n, b] of Object.entries(blocks)) {
  const g = b.match(/controlGuard\("([a-z.]+)"\)/);
  if (g) guarded[n] = g[1];
}

ok("注册工具数与注解表一致", names.length === Object.keys(table).length && names.length >= 20,
  { tools: names.length, annotated: Object.keys(table).length });
ok("没有重复注册名", new Set(names).size === names.length, names.length - new Set(names).size);
ok("没有重复注解项", Object.keys(table).length === new Set(Object.keys(table)).size);

const missingAnn = names.filter((n) => !table[n]);
const orphanAnn = Object.keys(table).filter((n) => !names.includes(n));
ok("每个工具都有注解(无遗漏)", missingAnn.length === 0, missingAnn);
ok("注解表无孤儿项(无拼写漂移)", orphanAnn.length === 0, orphanAnn);

// ---- 语义自洽 ----
for (const [n, a] of Object.entries(table)) {
  ok(`${n}.readOnlyHint 是布尔`, typeof a.readOnlyHint === "boolean", a.readOnlyHint);
  if (a.destructiveHint === true) {
    ok(`${n} 破坏性 ⇒ 非只读`, a.readOnlyHint === false, a);
  }
}

// ---- 只读例外表(必须显式列出, 新增例外要改这里 + 说明) ----
const READONLY_CONTROL_EXCEPTIONS = {
  "page.snapshot": "读 DOM 结构, 不改页面",
  "page.screenshot": "读画面像素, 不改页面",
  "page.wait": "只等条件, 不改页面",
};

for (const [tool, method] of Object.entries(guarded)) {
  const a = table[tool];
  if (!a) continue;
  if (READONLY_CONTROL_EXCEPTIONS[method]) {
    ok(`${tool} 读例外标只读(${method})`, a.readOnlyHint === true, a);
  } else {
    ok(`${tool} 走控制闸门 ⇒ 不得标只读(${method})`, a.readOnlyHint === false, a);
  }
}
const unguardedRead = names.filter((n) => !guarded[n] && n !== "page_snapshot");
const notReadOnly = unguardedRead.filter((n) => table[n] && table[n].readOnlyHint !== true);
ok("不碰控制闸门的工具都标只读", notReadOnly.length === 0, notReadOnly);

// ---- tool→method 必须落在协议白名单 ----
const READ = protocol.READ_METHODS, CTRL = protocol.CONTROL_METHODS;
const outside = Object.entries(guarded).filter(([, m]) => !CTRL.includes(m) && !READ.includes(m));
ok("控制方法都在协议白名单内", outside.length === 0, outside);
ok("控制闸门工具都用了控制方法", Object.values(guarded).every((m) => CTRL.includes(m)),
  Object.values(guarded).filter((m) => !CTRL.includes(m)));

// ---- 关键工具的口径抽样(防有人把破坏性工具改回只读) ----
ok("net_list 只读", table.net_list && table.net_list.readOnlyHint === true, table.net_list);
ok("page_click 破坏性", table.page_click && table.page_click.destructiveHint === true, table.page_click);
ok("page_eval 破坏性(可执行任意 JS)", table.page_eval && table.page_eval.destructiveHint === true, table.page_eval);
ok("chain_replay 破坏性(会真打后端)", table.chain_replay && table.chain_replay.destructiveHint === true, table.chain_replay);
ok("export_jmx 只读(纯变换)", table.export_jmx && table.export_jmx.readOnlyHint === true, table.export_jmx);

console.log(fail.length ? `=== bridge annotations FAIL: ${fail.length} ===` : "=== bridge annotations PASS ===");
process.exit(fail.length ? 1 : 0);
