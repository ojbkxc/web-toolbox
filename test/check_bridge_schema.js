// check_bridge_schema.js —— 工具 schema 可读性契约(零依赖, 源码级)。
//
// 对标参考仓库的做法: 每个 schema 字段都带 .describe() —— MCP 客户端把描述喂给模型,
// 没有描述的字段等于让模型猜参数含义(参考仓库还有专门的 eslint 规则管 schema 形态)。
//
// 断言:
//   1. 每个 register(...) 的 inputSchema 顶层字段都必须有 .describe(;
//   2. 顶层 spread 只允许已知的共享 shape(filterShape —— 其字段已带描述);
//   3. 每个工具都有非空 title 与 description(客户端列表里直接展示给模型);
//   4. 带 structuredContent 的工具必须有 outputSchema, 反之亦然(否则 SDK 要么丢弃要么拒)。
// 注意: outputSchema 字段不要求 describe(不面向模型), 但必须与 structured() 返回值同源。
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "bridge", "src", "tools.js"), "utf8");

const fail = [];
const ok = (name, cond, got) => {
  if (cond) console.log("  OK " + name);
  else { fail.push(name); console.log("FAIL " + name + " → " + JSON.stringify(got)); }
};

const names = [...SRC.matchAll(/\bregister\("([a-z_]+)"/g)].map((m) => m[1]);
ok("工具数 >= 20", names.length >= 20, names.length);

function region(block, key) {
  const i = block.indexOf(key + ":");
  if (i < 0) return "";
  const open = block.indexOf("{", i);
  let depth = 0, j = open;
  for (; j < block.length; j++) {
    if (block[j] === "{") depth++;
    else if (block[j] === "}") { depth--; if (!depth) break; }
  }
  return block.slice(open, j + 1);
}

const ALLOWED_SPREADS = new Set(["filterShape"]);
const missingDesc = [];
const badSpreads = [];
const noTitle = [];
const noDesc = [];

for (let i = 0; i < names.length; i++) {
  const start = SRC.indexOf(`register("${names[i]}"`);
  const end = i + 1 < names.length ? SRC.indexOf(`register("${names[i + 1]}"`) : SRC.length;
  const block = SRC.slice(start, end);

  const title = block.match(/title:\s*"([^"]*)"/);
  if (!title || !title[1].trim()) noTitle.push(names[i]);
  const desc = block.match(/description:\s*\n?\s*"([^"]{0,40})/);
  if (!desc || desc[1].trim().length < 4) noDesc.push(names[i]);

  const input = region(block, "inputSchema");
  if (!input) { missingDesc.push(`${names[i]}: <无 inputSchema>`); continue; }
  for (const line of input.split(/\r?\n/)) {
    const sp = line.match(/^      \.\.\.(\w+)/);
    if (sp) {
      if (!ALLOWED_SPREADS.has(sp[1])) badSpreads.push(`${names[i]}: ...${sp[1]}`);
      continue;
    }
    const m = line.match(/^      ([A-Za-z_][A-Za-z0-9_]*):\s*(.+)$/);
    if (!m) continue;
    if (!/\.describe\(/.test(m[2])) missingDesc.push(`${names[i]}.${m[1]}`);
  }
}

ok("inputSchema 字段全部有 describe", missingDesc.length === 0, missingDesc);

// 形态约束(借参考仓库 @local/enforce-zod-schema 的思路): 模型需要的是"短、可填"的参数,
// z.any()/z.record() 会让 schema 失去约束力(客户端只能看到"随便什么"), 目前一个都没有,
// 用断言把它保持住。
const looseFields = [];
for (let i = 0; i < names.length; i++) {
  const start = SRC.indexOf(`register("${names[i]}"`);
  const end = i + 1 < names.length ? SRC.indexOf(`register("${names[i + 1]}"`) : SRC.length;
  const block = SRC.slice(start, end);
  const input = region(block, "inputSchema");
  for (const line of input.split(/\r?\n/)) {
    if (/^\s{6}[A-Za-z_][A-Za-z0-9_]*:\s*z\.(any|record|unknown|lazy)\(/.test(line)) looseFields.push(`${names[i]}: ${line.trim()}`);
  }
}
ok("inputSchema 不用 z.any()/z.record()/z.unknown()/z.lazy()(参数要有约束)", looseFields.length === 0, looseFields);
ok("顶层 spread 只来自已描述的共享 shape", badSpreads.length === 0, badSpreads);
ok("每个工具都有 title", noTitle.length === 0, noTitle);
ok("每个工具都有 description", noDesc.length === 0, noDesc);

// structuredContent / outputSchema 成对
const withOutput = names.filter((n) => {
  const start = SRC.indexOf(`register("${n}"`);
  const end = names.indexOf(n) + 1 < names.length ? SRC.indexOf(`register("${names[names.indexOf(n) + 1]}"`) : SRC.length;
  return /outputSchema:/.test(SRC.slice(start, end));
});
const structuredTools = [...SRC.matchAll(/return structured\(/g)].length;
ok("structured() 调用数 > 0 且都有对应 outputSchema", structuredTools > 0 && structuredTools <= withOutput.length,
  { structuredTools, withOutput });
ok("至少四个工具接了 outputSchema", withOutput.length >= 4, withOutput);

// 共享 shape 自身字段也要有描述(filterShape 是唯一允许的 spread 源)
const filterShapeBlock = SRC.slice(SRC.indexOf("const filterShape = {"), SRC.indexOf("};", SRC.indexOf("const filterShape = {")));
const fsFields = [...filterShapeBlock.matchAll(/^\s{2}([a-z_]+):\s*(.+)$/gm)];
ok("filterShape 字段全部有 describe", fsFields.length > 0 && fsFields.every((m) => /\.describe\(/.test(m[2])), fsFields.map((m) => m[1]));

console.log(fail.length ? `=== bridge schema FAIL: ${fail.length} ===` : `=== bridge schema PASS (${names.length} 工具) ===`);
process.exit(fail.length ? 1 : 0);
