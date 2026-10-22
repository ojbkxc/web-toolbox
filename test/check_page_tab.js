// check_page_tab —— 侧栏「页面」页签 + pageDispatch 转发白名单
// 覆盖: 方法白名单(只放行 page.*/tab.* 只读与交互) / 桥接未加载时的明确报错
//       / 转发成功路径的参数透传 / HTML 与 JS 接线
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");
let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log("  OK " + msg); }
  else { fail++; console.log("  FAIL " + msg); }
}

const bgSrc = fs.readFileSync(path.join(ROOT, "background.js"), "utf8");
const store = new Map();
const chromeStub = {
  runtime: { onInstalled: { addListener() {} }, onMessage: { addListener() {} }, onStartup: { addListener() {} }, getManifest: () => ({ version: "1.1.0" }) },
  storage: {
    local: {
      QUOTA_BYTES: 10485760,
      get: (keys, cb) => { const r = {}; for (const k of [].concat(keys)) if (store.has(k)) r[k] = store.get(k); cb && cb(r); return Promise.resolve(r); },
      set: (o, cb) => { for (const k of Object.keys(o)) store.set(k, o[k]); cb && cb(); return Promise.resolve(); },
      remove: (keys, cb) => { for (const k of [].concat(keys)) store.delete(k); cb && cb(); return Promise.resolve(); },
    },
    onChanged: { addListener() {} },
  },
  debugger: { attach: () => Promise.resolve(), detach: () => Promise.resolve(), sendCommand: () => Promise.resolve({}), onEvent: { addListener() {} }, onDetach: { addListener() {} } },
  tabs: { onRemoved: { addListener() {} }, query: () => Promise.resolve([]) },
  alarms: { create() {}, clear() {}, onAlarm: { addListener() {} } },
  action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
  permissions: { contains: (p, cb) => cb(true) },
};
const ctx = { chrome: chromeStub, console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, URL, URLSearchParams, AbortController, Map, Promise, JSON, Date, Math, String, Number, Array, Object };
ctx.globalThis = ctx;
vm.createContext(ctx);
try { new vm.Script(bgSrc, { filename: "background.js" }).runInContext(ctx); } catch { /* importScripts 缺失属预期 */ }

const send = (msg) => new Promise((resolve) => {
  let done = false;
  const sendResponse = (r) => { if (!done) { done = true; resolve(r); } };
  const handled = ctx.toolboxHandleMessage(msg, sendResponse);
  if (handled !== true) setTimeout(() => { if (!done) { done = true; resolve(undefined); } }, 20);
});

(async () => {
  // ---------- 桥接层未加载: 明确报错而非静默 ----------
  delete ctx.toolboxBridge;
  let r = await send({ type: "pageDispatch", method: "page.snapshot", params: {} });
  assert(r && r.ok === false && /桥接层未加载/.test(r.error), "c1. 桥接未加载时明确报错");

  // ---------- 装上假桥接: 验证转发与参数透传 ----------
  const calls = [];
  ctx.toolboxBridge = {
    dispatch: async (m, p) => { calls.push([m, p]); return { echoed: m, got: p }; },
  };
  r = await send({ type: "pageDispatch", method: "page.screenshot", params: { tabId: 7 } });
  assert(r && r.ok === true && r.result.echoed === "page.screenshot", "c2. 转发成功返回 result");
  assert(calls[0][1].tabId === 7, "c3. params 原样透传");

  // ---------- 白名单: 放行的方法 ----------
  const allowed = ["page.screenshot", "page.snapshot", "page.click", "page.type", "page.press",
    "page.hover", "page.select", "page.scroll", "page.wait", "page.eval",
    "tab.navigate", "tab.list", "tab.activate"];
  let okAll = true;
  for (const m of allowed) {
    const rr = await send({ type: "pageDispatch", method: m, params: {} });
    if (!rr || rr.ok !== true) { okAll = false; console.log("    (未放行: " + m + ")"); }
  }
  assert(okAll, "c4. 13 个页面/标签方法全部放行");

  // ---------- 白名单: 拦截的方法 ----------
  const blocked = ["export.jmx", "rec.start", "net.list", "correlate.analyze", "page.unknown", "tab.close"];
  let blockedAll = true;
  for (const m of blocked) {
    const rr = await send({ type: "pageDispatch", method: m, params: {} });
    if (!rr || rr.ok !== false) { blockedAll = false; console.log("    (未拦截: " + m + ")"); }
  }
  assert(blockedAll, "c5. 导出/录制/关联/未知方法被白名单拦截");

  // ---------- dispatch 抛错时转成 ok:false ----------
  ctx.toolboxBridge = { dispatch: async () => { throw new Error("页面已关闭"); } };
  r = await send({ type: "pageDispatch", method: "page.snapshot", params: {} });
  assert(r && r.ok === false && /页面已关闭/.test(r.error), "c6. dispatch 异常转 ok:false 带原文");

  // ---------- 静态接线 ----------
  const html = fs.readFileSync(path.join(ROOT, "sidepanel/sidepanel.html"), "utf8");
  const sp = fs.readFileSync(path.join(ROOT, "sidepanel/sidepanel.js"), "utf8");
  const bc = fs.readFileSync(path.join(ROOT, "bridge-client.js"), "utf8");
  assert(html.includes('data-tab="page"') && html.includes('id="pgPage"'), "c7. 侧栏页面页签与面板存在");
  assert(html.includes('id="pgShot"') && html.includes('id="pgSnap"'), "c8. 截图/抓结构按钮存在");
  assert(html.includes('id="pgMsg" role="status" aria-live="polite"'), "c9. 状态区 aria-live");
  assert(sp.includes('type: "pageDispatch"'), "c10. 侧栏经 pageDispatch 发请求");
  assert(sp.includes('pageDispatch("page.screenshot")') && sp.includes('pageDispatch("page.snapshot"') , "c11. 截图与快照走同一分发函数");
  assert(/dispatch:\s*bridgeDispatch/.test(bc), "c12. 桥接暴露 dispatch(与 MCP 同源实现)");
  assert(!/function\s+sidepanelSnapshot|function\s+sidepanelClick/.test(sp), "c13. 侧栏未复制第二套页面操作实现");
  // 防御: 侧栏渲染快照用 textContent 而非 innerHTML(页面内容可能含标签)
  assert(sp.includes("pre.textContent = text"), "c14. 快照用 textContent 渲染(防 HTML 注入)");

  console.log(`\n=== check_page_tab: ${fail === 0 ? "PASS" : "FAIL"} (${pass}/${pass + fail}) ===`);
  process.exit(fail === 0 ? 0 : 1);
})();
