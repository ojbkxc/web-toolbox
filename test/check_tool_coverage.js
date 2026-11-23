// check_tool_coverage.js —— MCP 工具的行为级覆盖闸门(v1.1.47)
//
// 背景(R58 实测): 27 个工具里有 **13 个零测试提及** —— rec_start/rec_stop/tab_navigate/
// page_type/page_press/page_hover/page_select/page_scroll/page_wait/tab_activate/tab_close/
// page_screenshot/page_eval。它们只靠"工具表闸门"证明存在, 没有任何一条测试证明
// "工具 → 协议 → 扩展"这三段是通的(参数是否被工具层吞掉、返回值形态对不对, 全都不知道)。
//
// 本闸门要求: **每个工具都必须在 bridge/smoke.mjs 里被真调过一次**(不是 README 提及、不是
// annotations 静态断言)。smoke 是端到端层(真起 bridge + 真 MCP stdio + 假扩展), 只有它能证明三段打通。
//
// 判定口径: 在 smoke.mjs 里找 `callTool("<name>"` 或 `call("<name>"` / `J("<name>"`(后者是本节
// 定义的短别名)。只认这几种调用形态, 避免"文档里提了一句"被算成覆盖。
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");

let fails = 0;
const ok = (name, cond, got) => {
  if (cond) console.log("  OK " + name);
  else { fails++; console.log("FAIL " + name + " → " + JSON.stringify(got)); }
};

const toolsSrc = fs.readFileSync(path.join(ROOT, "bridge", "src", "tools.js"), "utf8");
const tools = [...toolsSrc.matchAll(/\bregister\("([a-z_]+)"/g)].map((m) => m[1]);
const smoke = fs.readFileSync(path.join(ROOT, "bridge", "smoke.mjs"), "utf8");

// 判定口径: 调用形态必须**不在注释行里**才算覆盖(注释里的 callTool("ghost") 是文档, 不是调用)。
const CALL_FORMS = (n) => [
  new RegExp(`(?<!//[^\\n]*)callTool\\(\\s*"${n}"`),
  new RegExp(`(?<!//[^\\n]*)\\b(?:call|J)\\(\\s*"${n}"`),
];

// 逐行扫: 跳过整行注释(行首 //), 行内注释只在 "//" 之前的部分匹配
function isCovered(src, name) {
  for (const line of src.split(/\r?\n/)) {
    const code = line.split("//")[0];
    if (new RegExp(`callTool\\(\\s*"${name}"`).test(code)) return true;
    if (new RegExp(`\\b(?:call|J)\\(\\s*"${name}"`).test(code)) return true;
  }
  return false;
}

const uncovered = tools.filter((n) => !isCovered(smoke, n));
ok(`27 个工具全部在 smoke 里被真调过(${tools.length} 个已扫)`, uncovered.length === 0, uncovered);

// 控制类工具(需要 --allow-control)必须在**开了开关**的环境里调 —— 否则测的是 forbidden 分支
const guarded = [];
tools.forEach((n) => {
  const i = toolsSrc.indexOf(`register("${n}"`);
  const end = toolsSrc.indexOf('register("', i + 10);
  const block = toolsSrc.slice(i, end > 0 ? end : toolsSrc.length);
  if (/controlGuard\("/.test(block)) guarded.push(n);
});
// smoke 里 [8] 块用 --allow-control 启动(startBridge(["--allow-control"]))
ok("smoke 里存在 --allow-control 启动的分支(控制类工具不是只测 forbidden)",
  /startBridge\(\[\s*"--allow-control"\s*\]\)/.test(smoke), "未见 --allow-control 启动");
ok(`控制类工具数 >= 13(${guarded.length})`, guarded.length >= 13, guarded.length);

// 反向: smoke 里调的工具名必须在实现里存在(防拼错导致假覆盖)
const calledInSmoke = [...smoke.matchAll(/\b(?:callTool|call|J)\(\s*"([a-z_]+)"/g)].map((m) => m[1]);
const phantom = [...new Set(calledInSmoke)].filter((n) => !tools.includes(n));
ok("smoke 调用的工具名都真实存在(无幻影调用)", phantom.length === 0, phantom);

// 自证: 覆盖判定必须能分辨"真调用"与"文档提及"
{
  const probeSmoke = [
    'await mcp.callTool("net_list", {});',
    'const J = (n) => n; J("page_type", {});',
    '// callTool("ghost_tool") in a comment',
    'const doc = "net_get 很常用";',
  ].join("\n");
  const hit = (n) => isCovered(probeSmoke, n);
  ok("闸门自证: callTool/call/J 三种真调用都算覆盖", hit("net_list") && hit("page_type"), { net_list: hit("net_list"), page_type: hit("page_type") });
  ok("闸门自证: 注释里的调用与纯文档提及不算覆盖", !hit("ghost_tool") && !hit("net_get"), { ghost: hit("ghost_tool"), net_get: hit("net_get") });
}

console.log(fails ? `=== tool coverage FAIL: ${fails} ===` : `=== tool coverage PASS (${tools.length} 工具 / smoke 真调) ===`);
process.exit(fails ? 1 : 0);