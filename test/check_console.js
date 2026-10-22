// check_console —— 控制台日志采集与侧栏展示
// 覆盖: CDP RemoteObject 三形态归一化 / 环形缓冲有界(条数+字节) / 分级映射
//       / exceptionThrown 归一化 / 与 harvest 完全隔离(清录制不影响日志)
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");
let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log("  OK " + msg); }
  else { fail++; console.log("  FAIL " + msg); }
}

// ---------- 1. 引擎侧: background.js 在 vm 中跑起来 ----------
const bgSrc = fs.readFileSync(path.join(ROOT, "background.js"), "utf8");
const store = new Map();
let msgHandlers = [];
const chromeStub = {
  runtime: {
    onInstalled: { addListener() {} },
    onMessage: { addListener(fn) { msgHandlers.push(fn); } },
    onStartup: { addListener() {} },
    getManifest: () => ({ version: "1.1.0" }),
  },
  storage: {
    local: {
      QUOTA_BYTES: 10485760,
      get: (keys, cb) => {
        const r = {};
        for (const k of [].concat(keys)) if (store.has(k)) r[k] = store.get(k);
        cb && cb(r);
        return Promise.resolve(r);
      },
      set: (obj, cb) => { for (const k of Object.keys(obj)) store.set(k, obj[k]); cb && cb(); return Promise.resolve(); },
      remove: (keys, cb) => { for (const k of [].concat(keys)) store.delete(k); cb && cb(); return Promise.resolve(); },
    },
    onChanged: { addListener(fn) { chromeStub.__onChanged = fn; } },
  },
  debugger: {
    attach: () => Promise.resolve(),
    detach: () => Promise.resolve(),
    sendCommand: () => Promise.resolve({}),
    onEvent: { addListener(fn) { chromeStub.__onEvent = fn; } },
    onDetach: { addListener() {} },
  },
  tabs: { onRemoved: { addListener() {} }, query: () => Promise.resolve([]) },
  alarms: { create() {}, clear() {}, onAlarm: { addListener() {} } },
  action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
  permissions: { contains: (p, cb) => cb(true) },
};

const ctx = {
  chrome: chromeStub, console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {},
  URL, URLSearchParams, AbortController, Map, Promise, JSON, Date, Math, String, Number, Array, Object,
};
ctx.globalThis = ctx;
vm.createContext(ctx);
// importScripts 在 node 下不存在 → 桥接层加载失败是预期分支, 用 try 包住不影响主流程
try { new vm.Script(bgSrc, { filename: "background.js" }).runInContext(ctx); } catch (e) {
  console.log("  (background.js 加载异常: " + e.message + ")");
}

const send = (msg) => new Promise((resolve) => {
  // background.js 里 toolboxHandleMessage 是具名函数(bridge-client 也直接调它),
  // 这里直接消费它, 绕开 onMessage 监听器的返回值语义差异。
  let done = false;
  const sendResponse = (r) => { if (!done) { done = true; resolve(r); } };
  const handled = ctx.toolboxHandleMessage(msg, sendResponse);
  if (handled !== true) setTimeout(() => { if (!done) { done = true; resolve(undefined); } }, 20);
});

(async () => {
  // 必须先置 recording 才会处理事件
  store.set("toolbox.recording", "recording");
  store.set("toolbox.debugTabs", [1]);
  if (chromeStub.__onChanged) chromeStub.__onChanged({ "toolbox.recording": { newValue: "recording" } }, {});
  await new Promise((r) => setTimeout(r, 30));

  const fire = (method, params) => chromeStub.__onEvent({ tabId: 1 }, method, params);

  // ---------- RemoteObject 三形态 ----------
  fire("Runtime.consoleAPICalled", {
    type: "log", args: [
      { type: "string", value: "hello" },
      { type: "number", value: 42 },
      { type: "undefined" },
      { type: "object", description: "Object" },
      { type: "number", unserializableValue: "NaN" },
    ],
    stackTrace: { callFrames: [{ url: "https://x/a.js", lineNumber: 9 }] },
  });
  await new Promise((r) => setTimeout(r, 20));
  let r = await send({ type: "getConsoleLog", limit: 50 });
  assert(r && r.total === 1, "b1. 一条 console 事件入库");
  const e0 = r.entries[0];
  assert(e0.text === "hello 42 undefined Object NaN", "b2. RemoteObject 五形态归一化(" + e0.text + ")");
  assert(e0.level === "log", "b3. level 映射 log");
  assert(e0.src === "https://x/a.js:10", "b4. 栈帧 url:行号(1-based)");

  // ---------- warning → warn ----------
  fire("Runtime.consoleAPICalled", { type: "warning", args: [{ type: "string", value: "w" }], stackTrace: { callFrames: [] } });
  await new Promise((r) => setTimeout(r, 20));
  r = await send({ type: "getConsoleLog", limit: 50 });
  assert(r.entries[1].level === "warn", "b5. warning 归一化为 warn");

  // ---------- exceptionThrown ----------
  fire("Runtime.exceptionThrown", {
    exceptionDetails: {
      text: "Uncaught",
      url: "https://x/b.js", lineNumber: 4,
      exception: { description: "TypeError: x is not a function" },
    },
  });
  await new Promise((r) => setTimeout(r, 20));
  r = await send({ type: "getConsoleLog", limit: 50 });
  const ex = r.entries[r.entries.length - 1];
  assert(ex.level === "error" && ex.text.includes("TypeError"), "b6. exceptionThrown → level=error 且取 description");
  assert(ex.src === "https://x/b.js:5", "b7. 异常位置 url:行号");

  // ---------- 环形缓冲条数上限 ----------
  for (let i = 0; i < 600; i++) {
    fire("Runtime.consoleAPICalled", { type: "log", args: [{ type: "string", value: "n" + i }], stackTrace: { callFrames: [] } });
  }
  await new Promise((r) => setTimeout(r, 50));
  r = await send({ type: "getConsoleLog", limit: 500 });
  assert(r.total === 500, "b8. 环形缓冲条数上限 500(实际 " + r.total + ")");
  assert(r.entries[r.entries.length - 1].text === "n599", "b9. 保留最新(尾部是最末条)");

  // ---------- limit 参数 ----------
  r = await send({ type: "getConsoleLog", limit: 10 });
  assert(r.entries.length === 10 && r.total === 500, "b10. limit 只截断返回不改变 total");

  // ---------- 长文本截断 ----------
  fire("Runtime.consoleAPICalled", { type: "log", args: [{ type: "string", value: "x".repeat(9000) }], stackTrace: { callFrames: [] } });
  await new Promise((r) => setTimeout(r, 20));
  r = await send({ type: "getConsoleLog", limit: 500 });
  assert(r.entries[r.entries.length - 1].text.length === 4000, "b11. 单条 text 截断到 4000");

  // ---------- 清空 ----------
  await send({ type: "clearConsoleLog" });
  r = await send({ type: "getConsoleLog", limit: 50 });
  assert(r.total === 0, "b12. 清空生效");

  // ---------- 与 harvest 隔离: 日志不进录制条目 ----------
  const hv = store.get("toolbox.harvest");
  const entries = hv && hv.entries ? hv.entries : [];
  assert(entries.length === 0, "b13. 控制台日志不写入 harvest(录制库仍为空)");

  // ---------- 侧栏: HTML 结构与 JS 接线 ----------
  const html = fs.readFileSync(path.join(ROOT, "sidepanel/sidepanel.html"), "utf8");
  const sp = fs.readFileSync(path.join(ROOT, "sidepanel/sidepanel.js"), "utf8");
  assert(html.includes('data-tab="log"') && html.includes('id="pgLog"'), "b14. 侧栏控制台页签与面板存在");
  assert(html.includes('id="logFilter"') && html.includes('id="logList"'), "b15. 过滤框与列表容器存在");
  assert(html.includes('id="logMsg" role="status" aria-live="polite"'), "b16. 状态区 aria-live");
  assert(sp.includes('type: "getConsoleLog"') && sp.includes('type: "clearConsoleLog"'), "b17. 侧栏接引擎读取/清空消息");
  assert(sp.includes("startLogPolling") && sp.includes("stopLogPolling"), "b18. 轮询随页签启停");
  assert(/if \(t\.dataset\.tab === "log"\)/.test(sp), "b19. activate 中接线控制台页");
  assert(sp.includes("level:") && sp.includes("logMatches"), "b20. 过滤支持 level: 前缀");
  assert(bgSrc.includes('"Runtime.enable"'), "b21. attach 时启用 Runtime domain");
  assert(bgSrc.includes("MAX_CONSOLE") && bgSrc.includes("MAX_CONSOLE_BYTES"), "b22. 双上限(条数+字节)常量在");

  console.log(`\n=== check_console: ${fail === 0 ? "PASS" : "FAIL"} (${pass}/${pass + fail}) ===`);
  process.exit(fail === 0 ? 0 : 1);
})();
