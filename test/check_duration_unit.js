// check_duration_unit.js —— 验证 CDP MonotonicTime(秒) → durationMs(毫秒) 换算。
// 背景: v0.4.2 引入耗时记录时把 CDP timestamp 当毫秒直接减 —— CDP Network 事件的
// timestamp 是 MonotonicTime, 单位【秒】(小数)。真实 150ms 的请求差值是 0.15,
// 直接用会显示 "0.15ms" 甚至 0。修复: *1000 后取整。
// 同时验证: 无 timestamp(旧 mock)时 durationMs 保持 0;loadingFailed 不入列。
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const ROOT = require('path').resolve(__dirname, '..');
const storageData = new Map();
const listeners = { event: [], detach: [], alarm: [], removed: [], message: [] };

const chromeStub = {
  storage: {
    local: {
      QUOTA_BYTES: 10485760,
      get: (k, cb) => { const o = {}; for (const x of [].concat(k)) o[x] = storageData.get(x); setTimeout(() => cb && cb(o), 0); return Promise.resolve(o); },
      set: (o, cb) => { for (const k of Object.keys(o)) storageData.set(k, o[k]); setTimeout(() => cb && cb(), 0); return Promise.resolve(); },
      remove: (k, cb) => { for (const x of [].concat(k)) storageData.delete(x); setTimeout(() => cb && cb(), 0); return Promise.resolve(); },
    },
    onChanged: { addListener() {} },
  },
  runtime: { onInstalled: { addListener() {} }, onMessage: { addListener(L) { listeners.message.push(L); } } },
  debugger: {
    attach: async () => {},
    detach: async () => {},
    sendCommand: async () => ({ body: "ok", base64Encoded: false }),
    onDetach: { addListener(L) { listeners.detach.push(L); } },
    onEvent: { addListener(L) { listeners.event.push(L); } },
  },
  alarms: { onAlarm: { addListener(L) { listeners.alarm.push(L); } }, create: async () => {}, clear: async () => {} },
  action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
  tabs: { onRemoved: { addListener(L) { listeners.removed.push(L); } } },
};

const sandbox = {
  console, setTimeout, URL, URLSearchParams, Date, Math, JSON, Object, Array, Set, Map, String, Number, Boolean, RegExp, Error, Promise,
  chrome: chromeStub,
};
sandbox.window = sandbox; sandbox.globalThis = sandbox;
vm.createContext(sandbox);
new vm.Script(fs.readFileSync(path.join(ROOT, "background.js"), "utf8"), { filename: "background.js" }).runInContext(sandbox);

let fails = 0;
const assert = (cond, msg) => { if (!cond) { fails++; console.log("FAIL: " + msg); } else console.log("  OK " + msg); };

(async () => {
  await new Promise((r) => setTimeout(r, 20)); // stateReady
  const sendMsg = (msg) => new Promise((resolve) => { for (const L of listeners.message) L(msg, {}, resolve); });
  const emit = (tabId, method, params) => { for (const L of listeners.event) L({ tabId }, method, params); };
  await sendMsg({ type: "setDomains", domains: ["b.com"] });
  const r = await sendMsg({ type: "startRecording", tabId: 101 });
  assert(r.ok, "startRecording ok");

  const T0 = 1000.000; // CDP MonotonicTime, 秒
  // 事件 1: 正常完成, 耗时 150ms(0.15 秒差)
  emit(101, "Network.requestWillBeSent", { requestId: "q1", timestamp: T0,
    request: { method: "GET", url: "https://api.b.com/a", headers: {} } });
  emit(101, "Network.loadingFinished", { requestId: "q1", timestamp: T0 + 0.15 });

  // 事件 2: 4.2 秒的慢请求
  emit(101, "Network.requestWillBeSent", { requestId: "q2", timestamp: T0 + 10,
    request: { method: "POST", url: "https://api.b.com/b", headers: {} } });
  emit(101, "Network.loadingFinished", { requestId: "q2", timestamp: T0 + 14.2 });

  // 事件 3: 无 timestamp → durationMs 应为 0
  emit(101, "Network.requestWillBeSent", { requestId: "q3",
    request: { method: "GET", url: "https://api.b.com/c", headers: {} } });
  emit(101, "Network.loadingFinished", { requestId: "q3" });

  await new Promise((r) => setTimeout(r, 100)); // getResponseBody 异步 + flush 合帧

  const stored = storageData.get("toolbox.harvest");
  assert(stored && stored.entries.length === 3, `3 条入列(实际 ${stored ? stored.entries.length : -1})`);
  const byId = {};
  for (const e of stored.entries) byId[e.url.slice(-1)] = e;
  assert(byId.a && byId.a.durationMs === 150, `0.15s 差 → 150ms(实际 ${byId.a && byId.a.durationMs})`);
  assert(byId.b && byId.b.durationMs === 4200, `4.2s 差 → 4200ms(实际 ${byId.b && byId.b.durationMs})`);
  assert(byId.c && byId.c.durationMs === 0, `无 timestamp → 0(实际 ${byId.c && byId.c.durationMs})`);

  // loadingFailed 不入列
  emit(101, "Network.requestWillBeSent", { requestId: "q4", timestamp: T0 + 20,
    request: { method: "GET", url: "https://api.b.com/d", headers: {} } });
  emit(101, "Network.loadingFailed", { requestId: "q4", errorText: "net::ERR" });
  await new Promise((r) => setTimeout(r, 60));
  assert(storageData.get("toolbox.harvest").entries.length === 3, "loadingFailed 不入列");

  console.log(fails ? `=== FAIL ${fails} ===` : "=== duration 单位换算 PASS ===");
  process.exit(fails ? 1 : 0);
})();
