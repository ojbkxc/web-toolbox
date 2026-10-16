// check_unmatched_hint.js —— 部分漏录诊断提示走查(v1.0.92)。
// 背景: unmatchedHosts 之前只在 count===0(空列表)时才显示, count>0 时用户完全不知道
// 有请求被域名过滤(典型: 配了 ics.midea.com 录到查询, 但登录走 signin.midea.com 漏录)。
// 本走查钉死: ① HTML 有提示条 DOM  ② JS 有 updateUnmatchedHint 函数 + refreshState 调用
//  ③ popup 也有 unmatched 提示  ④ 函数逻辑: count>0+unmatched→显示, 其余→隐藏
const fs = require("fs");
const vm = require("vm");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const assert = (cond, msg) => { if (!cond) { console.log("FAIL: " + msg); process.exit(1); } console.log("  OK " + msg); };

const sideHtml = fs.readFileSync(ROOT + "/sidepanel/sidepanel.html", "utf8");
const sideJs = fs.readFileSync(ROOT + "/sidepanel/sidepanel.js", "utf8");
const popupHtml = fs.readFileSync(ROOT + "/popup/popup.html", "utf8");
const popupJs = fs.readFileSync(ROOT + "/popup/popup.js", "utf8");

// ================= ① sidepanel HTML: 提示条 DOM =================
assert(sideHtml.includes('id="unmatchedHint"'), "sidepanel.html 有 #unmatchedHint 提示条");
assert(sideHtml.includes('id="unmatchedCount"'), "sidepanel.html 有 #unmatchedCount 计数位");
assert(sideHtml.includes('id="unmatchedList"'), "sidepanel.html 有 #unmatchedList 域名列表位");
assert(sideHtml.includes('去 ⚙ 配置加上'), "提示条含引导文案(去配置)");

// ================= ② sidepanel JS: 函数定义 + refreshState 调用 =================
assert(sideJs.includes("function updateUnmatchedHint(info)"), "sidepanel.js 定义 updateUnmatchedHint 函数");
assert(sideJs.includes("updateUnmatchedHint(info)"), "refreshState 调用 updateUnmatchedHint");
// 核心判定: count > 0 才显示(之前只在 count===0 的空态分支里显示)
assert(/info\.count.*>.*0/.test(sideJs) || /\(info\.count \|\| 0\) > 0/.test(sideJs), "判定含 count > 0 条件(诊断盲区修复核心)");

// ================= ③ popup HTML + JS: unmatched 提示 =================
assert(popupHtml.includes('id="unmatchedHint"'), "popup.html 有 #unmatchedHint 提示元素");
assert(popupJs.includes("unmatched"), "popup.js 引用 unmatched 变量");
assert(popupJs.includes("unmatchedHint"), "popup.js 操作 #unmatchedHint 元素");
assert(/unmatched\.join/.test(popupJs), "popup.js 拼接 unmatched 域名列表显示");

// ================= ④ 函数逻辑: vm realm 模拟 DOM 测试各场景 =================
const elements = new Map();
const mkEl = (id) => {
  if (elements.has(id)) return elements.get(id);
  const el = { id, style: { display: "" }, textContent: "" };
  elements.set(id, el);
  return el;
};
const $ = (id) => mkEl(id);
const REC_ON = "recording";
const REC_PAUSED = "paused";
const REC_IDLE = "idle";

// 从 sidepanel.js 提取 updateUnmatchedHint 函数体并在 vm 中运行
const fnMatch = sideJs.match(/function updateUnmatchedHint\(info\)\s*\{[\s\S]*?\n\}/);
assert(fnMatch, "能从源码提取 updateUnmatchedHint 函数体");

const sandbox = { $, REC_ON, REC_PAUSED, REC_IDLE, console };
vm.createContext(sandbox);
const fn = new vm.Script(fnMatch[0] + "; this.updateUnmatchedHint = updateUnmatchedHint;").runInContext(sandbox);

function testHint(desc, info, expectShow) {
  for (const el of elements.values()) el.style.display = "none";
  fn(info);
  const shown = $("unmatchedHint").style.display !== "none";
  assert(shown === expectShow, desc + " → " + (expectShow ? "显示" : "隐藏"));
}

// 场景 1: 录到 5 条 + 有 2 个域被过滤 → 显示(诊断盲区修复核心场景)
testHint("count=5 + unmatched=[signin×3, api×1] + recState=recording",
  { recState: REC_ON, count: 5, unmatched: ["signin.midea.com×3", "10.3.14.59×1"] }, true);

// 场景 2: 空列表 + 有 unmatched → 不显示(空列表走 updateEmptyHint, 不重复)
testHint("count=0 + unmatched=[x×1] + recState=recording",
  { recState: REC_ON, count: 0, unmatched: ["x×1"] }, false);

// 场景 3: 录到 5 条 + 无 unmatched → 不显示(全部录上了, 无需提示)
testHint("count=5 + unmatched=[] + recState=recording",
  { recState: REC_ON, count: 5, unmatched: [] }, false);

// 场景 4: 录到 5 条 + 有 unmatched + 暂停 → 显示(暂停时也该看到漏录线索)
testHint("count=5 + unmatched=[x×1] + recState=paused",
  { recState: REC_PAUSED, count: 5, unmatched: ["x×1"] }, true);

// 场景 5: 录到 5 条 + 有 unmatched + idle → 不显示(没在录制, 提示无意义)
testHint("count=5 + unmatched=[x×1] + recState=idle",
  { recState: REC_IDLE, count: 5, unmatched: ["x×1"] }, false);

// 场景 6: unmatched 字段缺失(旧版 background.js 兼容) → 不显示
testHint("count=5 + unmatched=undefined + recState=recording",
  { recState: REC_ON, count: 5 }, false);

// 场景 7: 显示时内容正确填充
fn({ recState: REC_ON, count: 10, unmatched: ["signin.midea.com×8", "10.112.219.15×2"] });
assert(String($("unmatchedCount").textContent) == 2, "提示条 unmatchedCount 填充域数 2");
assert($("unmatchedList").textContent.includes("signin.midea.com"), "提示条 unmatchedList 含被过滤域名");

console.log("PASS check_unmatched_hint");