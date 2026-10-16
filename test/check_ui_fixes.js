// check_ui_fixes.js —— 侧栏 UI 细节修复走查(v1.0.94)。
// 背景(用户实测报告): 复选框点击效果与所见不符、清洗后计数陈旧、勾选丢滚动位置、
// 误点退出勾选模式静默清空。根因与钉子:
//   A1 格式卡片: label 隐式关联 checkbox(浏览器原生转发勾选) + 代码手动翻转 = 双翻转
//      互相抵消, 点卡片文字高亮切换了而 checkbox 实际没变。修法: 删手动翻转, change 同步。
//   A2 cleanVisible 删条目(含前置)后只 renderList, 漏调 updatePreludeUi →
//      导出页"识别到 N 条登录前置"计数陈旧。
//   A3 renderList 全量重建列表, 不保 scrollTop → 勾选/清洗后视口跳回顶部。
//   A4 退出勾选模式静默清空全部勾选(勾几十条的实打实丢失), 无确认。
//   B  popup stamp 竞态: .jmx 引用与 .csv 下载文件名两次独立 stamp() 跨秒错位
//      → JMeter 静默 0 采样器。修法: 一次 stamp 两处复用(行为级回归在 e2e_popup 3d3)。
const fs = require("fs");
const vm = require("vm");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const assert = (cond, msg) => { if (!cond) { console.log("FAIL: " + msg); process.exit(1); } console.log("  OK " + msg); };

const sideJs = fs.readFileSync(ROOT + "/sidepanel/sidepanel.js", "utf8");
const popupJs = fs.readFileSync(ROOT + "/popup/popup.js", "utf8");

function fnBody(src, name) {
  const m = src.match(new RegExp("function " + name + "\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}"));
  assert(!!m, "能提取 " + name + " 函数体");
  return m[0];
}

// ================= A1 格式卡片: change 同步, 无手动翻转 =================
const fmtSeg = sideJs.match(/\(function initFmtCards\(\)\s*\{[\s\S]*?\}\)\(\);/);
assert(!!fmtSeg, "能提取 initFmtCards IIFE");
assert(!fmtSeg[0].includes("cb.checked = !cb.checked"), "A1: 不再手动翻转 checked(与 label 原生转发双翻转抵消的根因已除)");
assert(!/addEventListener\("click"/.test(fmtSeg[0]), "A1: 不再挂 click 监听/stopPropagation(label 转发原生可达)");
assert(fmtSeg[0].includes('cb.addEventListener("change"'), "A1: checkbox 挂 change 监听");
assert(fmtSeg[0].includes('c.classList.toggle("checked", cb.checked)'), "A1: change 回调按实际 checked 同步卡片高亮");

// A1 行为级: vm 跑 initFmtCards, 模拟浏览器原生勾选(change 触发) → 高亮跟随
const toggleCalls = [];
const changeCbs = [];
const mkCard = (i) => ({
  querySelector: () => ({ checked: false, addEventListener: (ev, fn) => { if (ev === "change") changeCbs[i] = { card: i, fn }; } }),
  classList: { toggle: (cls, on) => toggleCalls.push([i, cls, on]) },
});
const cards = [mkCard(0), mkCard(1), mkCard(2)];
const sb1 = { document: { querySelectorAll: () => cards } };
vm.createContext(sb1);
new vm.Script(fmtSeg[0]).runInContext(sb1);
assert(changeCbs.filter(Boolean).length === 3, "A1: 3 个格式卡片各挂上 change 监听");

// 场景: 卡片 0 的 checkbox 被浏览器勾上 → change → toggle("checked", true)
// mock 里 checkbox.checked 在闭包 cb 上, 回调读 cb.checked —— 让卡片 0 的 cb 可控:
// 重新构造, cb 引用暴露到 changeCbs
const toggleCalls2 = [];
const cbs2 = [];
const mkCbCard = (i) => {
  const cb = { checked: false, addEventListener: (ev, fn) => { if (ev === "change") cbs2[i] = fn; } };
  return { querySelector: () => cb, classList: { toggle: (cls, on) => toggleCalls2.push([i, cls, on]) } };
};
const cards2 = [mkCbCard(0), mkCbCard(1)];
const sb2 = { document: { querySelectorAll: () => cards2 } };
vm.createContext(sb2);
new vm.Script(fmtSeg[0]).runInContext(sb2);
// 浏览器语义: 用户点卡片 → label 转发 → checkbox.checked 翻转一次 → change 触发
// (修复后代码不再二次翻转, checked 终值即用户所见)
const cbOf = (i) => cards2[i].querySelector(); // 同一 cb 对象
cbOf(0).checked = true;  cbs2[0]();  // 勾上 → change → 高亮应加
cbOf(0).checked = false; cbs2[0]();  // 取消 → change → 高亮应除
cbOf(1).checked = true;  cbs2[1]();  // 卡片 1 勾上 → 高亮加
assert(toggleCalls2.length === 3, "A1: 3 次 change 各触发一次高亮同步");
assert(toggleCalls2[0][1] === "checked" && toggleCalls2[0][2] === true, "A1: 勾选 → 高亮添加(所见即所得)");
assert(toggleCalls2[1][1] === "checked" && toggleCalls2[1][2] === false, "A1: 取消 → 高亮移除");
assert(toggleCalls2[2][0] === 1 && toggleCalls2[2][2] === true, "A1: 各卡片独立同步");

// ================= A2 清洗后刷新导出页计数 =================
const cleanSrc = fnBody(sideJs, "cleanVisible");
assert(cleanSrc.includes("updatePreludeUi();"), "A2: cleanVisible 尾部调 updatePreludeUi(前置计数同步, 内部连带 updateCsvUi)");

// ================= A3 renderList 保留滚动位置 =================
const renderSrc = fnBody(sideJs, "renderList");
assert(/const keepScroll = list\.scrollTop \|\| 0/.test(renderSrc), "A3: renderList 开头保存 scrollTop");
assert(/list\.scrollTop = keepScroll;/.test(renderSrc), "A3: renderList 结尾恢复 scrollTop");
const savePos = renderSrc.indexOf("const keepScroll");
const appendPos = renderSrc.indexOf("list.appendChild(frag)");
const restorePos = renderSrc.indexOf("list.scrollTop = keepScroll;");
assert(restorePos > appendPos && appendPos > savePos, "A3: 恢复在 appendChild 之后(内容先恢复才能滚回原位)");

// ================= A4 退出勾选模式先确认 =================
const pickSrc = fnBody(sideJs, "togglePickMode");
assert(pickSrc.includes("confirm("), "A4: 退出勾选模式有 confirm 拦截");
assert(/pickMode && pickIds\.size && !confirm/.test(pickSrc), "A4: 只在退出且有勾选时拦(进入/空勾选不拦)");

// A4 行为级: vm 跑 togglePickMode 四场景
function runPickMode(confirmRet, mode, ids) {
  let confirmN = 0;
  const sb = {
    $: (id) => ({ classList: { toggle() {} }, textContent: "", style: {} }),
    confirm: () => { confirmN++; return confirmRet; },
    pickMode: mode, pickIds: new Set(ids),
    persistPickIds() {}, updateScopeHint() {}, updateTrimUi() {}, renderList() {},
  };
  vm.createContext(sb);
  new vm.Script(pickSrc + "\n(function(){ togglePickMode(); this.__out = { mode: pickMode, size: pickIds.size }; })()").runInContext(sb);
  return { confirmN, out: sb.__out };
}
let r = runPickMode(false, true, [1, 2]);
assert(r.confirmN === 1 && r.out.mode === true && r.out.size === 2, "A4: 退出有勾选+取消 → 不退出, 勾选保留(confirm×1)");
r = runPickMode(true, true, [1, 2]);
assert(r.confirmN === 1 && r.out.mode === false && r.out.size === 0, "A4: 退出有勾选+确认 → 退出, 勾选清空");
r = runPickMode(true, true, []);
assert(r.confirmN === 0 && r.out.mode === false, "A4: 无勾选退出 → 不确认直接退出");
r = runPickMode(true, false, []);
assert(r.confirmN === 0 && r.out.mode === true, "A4: 进入模式 → 不确认");

// ================= B: popup stamp 竞态已除(源码形态) =================
assert(!popupJs.includes("csvFileName: `data_${stamp()}.csv`"), "B: 不再有独立 stamp() 生成 csvFileName(竞态源头)");
assert(!popupJs.includes("name: `data_${stamp()}.csv`"), "B: CSV 下载文件名不再独立 stamp()");
assert(popupJs.includes("const csvName = `data_${ts}.csv`"), "B: 一次 stamp 缓存 csvName, 引用与下载同源");
assert(popupJs.includes("csvFileName: csvName") && popupJs.includes("name: csvName"), "B: .jmx 引用与 .csv 下载共用同一 csvName");

console.log("PASS check_ui_fixes");