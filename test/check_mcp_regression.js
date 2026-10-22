// check_mcp_regression —— MCP 回归能力工具(v1.1.1)
// 覆盖: 三个新工具注册 / 控制白名单放行与拦截 / chain_replay 汇总组装
//       / console 读写转发 / 协议方法表一致性
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log("  OK " + msg); }
  else { fail++; console.log("  FAIL " + msg); }
}

const toolsSrc = fs.readFileSync(path.join(ROOT, "bridge/src/tools.js"), "utf8");
const protoSrc = fs.readFileSync(path.join(ROOT, "bridge-protocol.js"), "utf8");
const bcSrc = fs.readFileSync(path.join(ROOT, "bridge-client.js"), "utf8");
const bgSrc = fs.readFileSync(path.join(ROOT, "background.js"), "utf8");

// ---------- 工具注册 ----------
assert(/registerTool\("chain_replay"/.test(toolsSrc), "d1. chain_replay 工具已注册");
assert(/registerTool\("console_read"/.test(toolsSrc), "d2. console_read 工具已注册");
assert(/registerTool\("console_clear"/.test(toolsSrc), "d3. console_clear 工具已注册");

// ---------- 控制守卫 ----------
assert(/controlGuard\("chain\.replay"\)/.test(toolsSrc), "d4. chain_replay 走控制守卫");
assert(/controlGuard\("console\.clear"\)/.test(toolsSrc), "d5. console_clear 走控制守卫");
// console_read 是只读, 不应走 controlGuard(否则未开 --allow-control 时读不到日志)
const readBlock = toolsSrc.slice(toolsSrc.indexOf('registerTool("console_read"'), toolsSrc.indexOf('registerTool("console_clear"'));
assert(!/controlGuard/.test(readBlock), "d6. console_read 不要求管理权限(只读)");

// ---------- 协议方法表与实现一致 ----------
const protoHas = (m) => new RegExp(`"${m.replace(/\./g, "\\.")}"`).test(protoSrc);
const clientHas = (m) => new RegExp(`case "${m.replace(/\./g, "\\.")}":`).test(bcSrc);
for (const m of ["chain.replay", "console.read", "console.clear"]) {
  assert(protoHas(m), `d7.${m} 在协议方法表`);
  assert(clientHas(m), `d8.${m} 在扩展分发实现`);
}
// 反向: 协议里登记的方法必须在扩展侧有实现(防"登记了但没人接")
const declared = [...protoSrc.matchAll(/"(chain|console)\.(\w+)"/g)].map((x) => `${x[1]}.${x[2]}`);
const missing = [...new Set(declared)].filter((m) => !clientHas(m));
assert(missing.length === 0, "d9. 协议登记的方法全部有扩展侧实现" + (missing.length ? `(缺 ${missing.join(",")})` : ""));

// ---------- chain_replay 组装逻辑 ----------
assert(/verdict:\s*r\.verdict/.test(toolsSrc), "d10. 结果只回传判定字段(不传完整响应体)");
assert(/summary:/.test(toolsSrc) && /failed:/.test(toolsSrc), "d11. 回传含汇总与失败明细");
assert(/applyFilter\(all,\s*args\s*\|\|\s*\{\}\)\.map\(\(e\)\s*=>\s*e\.id\)/.test(toolsSrc), "d12. 未给 ids 时按过滤词圈定(与侧栏语义一致)");

// ---------- 扩展侧实现细节 ----------
assert(/case "chain\.replay":/.test(bcSrc), "d13. 扩展侧 chain.replay 分发在");
assert(/__toolboxReplay/.test(bcSrc) && /runChain/.test(bcSrc), "d14. 复用 replay.js 的 runChain(单源)");
assert(/__toolboxConsole/.test(bcSrc), "d15. console 读走 background 暴露的接口");
assert(/globalThis\.__toolboxConsole\s*=/.test(bgSrc), "d16. background 暴露 __toolboxConsole");
assert(/importScripts\("replay\.js"/.test(bgSrc), "d17. service worker 加载 replay.js");
// 防御: 不能 importScripts common.js(与 background.js 的 KEY_DOMAINS 重复声明)
assert(!/importScripts\("common\.js"/.test(bgSrc), "d18. 不 importScripts common.js(避免全局 const 撞车)");
assert(/typeof isSkipHeader === "undefined"/.test(fs.readFileSync(path.join(ROOT, "replay.js"), "utf8")), "d19. replay.js 自带 isSkipHeader 兜底");

// ---------- 侧栏页面能力与 MCP 同源 ----------
assert(/dispatch:\s*bridgeDispatch/.test(bcSrc), "d20. 侧栏与 MCP 共用 bridgeDispatch 单源");
assert(!/function\s+\w*[Ss]mokeOnce/.test(bcSrc), "d21. 未把冒烟硬搬进桥接(避免第二套实现)");

console.log(`\n=== check_mcp_regression: ${fail === 0 ? "PASS" : "FAIL"} (${pass}/${pass + fail}) ===`);
process.exit(fail === 0 ? 0 : 1);
