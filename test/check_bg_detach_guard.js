// check_bg_detach_guard.js —— background 侧"桥接自发 detach 不清录制状态"的守卫(v1.1.36)
//
// R31 钉住了桥接侧(会挂 globalThis.toolboxBridgeOwnDetach); 本轮钉 background 侧:
//   chrome.debugger.onDetach 收到事件时, 若 tabId 在该标记里 → **必须直接 return**,
//   不许 detachTab()。否则 AI 点一下页面, 录制就被静默清掉(用户只看到"录制中却抓不到")。
// 手法: vm 里跑真实 background.js; chrome 用宽松 Proxy stub; 捕获 onDetach 监听器后
// 分别在"标记存在/不存在"两种情况下触发, 统计 storage.set 次数。
const fs = require("fs");
const vm = require("vm");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");

let pass = 0, fail = 0;
const ok = (name, cond, got) => {
  if (cond) { pass++; console.log("  OK " + name); }
  else { fail++; console.log("  FAIL " + name + " → " + JSON.stringify(got)); }
};

// 宽松 stub: 未显式定义的一律返回"能继续点下去的万能对象/函数", 且**递归包裹 overrides**
// (顶层 proxy 包不到 runtime.onInstalled 这种二级属性 —— 第一版就栽在这里)。
function looseStub(overrides = {}) {
  const make = (obj, isFn) => {
    const target = isFn ? () => Promise.resolve(undefined) : obj;
    return new Proxy(target, {
      get(t, k) {
        if (k === "then") return undefined;            // 别被当成 thenable
        // 先看显式 overrides: 否则 "捕获监听器" 的自定义 addListener 会被下面的兜底盖掉
        // (第一版栽在这: onDetach 监听器永远拿不到, 断言看到 null)。
        if (k in t) {
          const v = t[k];
          return (v && typeof v === "object") ? make(v, false) : v;
        }
        if (k === "addListener" || k === "removeListener" || k === "hasListener") return () => {};
        return make({}, true);
      },
      apply() { return Promise.resolve(undefined); },
    });
  };
  return make(overrides, false);
}
function newEnv() {
  const sets = [];        // 每次 storage.local.set 的键集合
  const calls = { detach: 0 };   // chrome.debugger.detach 次数(清理动作的直接信号)
  const store = {};
  let detachListener = null;
  const chrome = looseStub({
    storage: {
      local: {
        get: async (keys) => {
          const out = {};
          for (const k of [].concat(keys || [])) out[k] = store[k];
          return out;
        },
        set: async (obj, cb) => { sets.push(Object.keys(obj)); Object.assign(store, obj); if (cb) cb(); },
        remove: async () => {},
      },
      onChanged: { addListener() {} },
    },
    debugger: {
      attach: async () => {},
      detach: async () => { calls.detach++; },
      sendCommand: async () => ({}),
      onDetach: { addListener: (fn) => { detachListener = fn; } },
      onEvent: { addListener() {} },
    },
    tabs: { query: async () => [], get: async () => ({ id: 1 }), onRemoved: { addListener() {} }, onUpdated: { addListener() {} } },
    runtime: { onMessage: { addListener() {} }, getManifest: () => ({ version: "test" }), lastError: null },
    alarms: { create() {}, clear() {}, onAlarm: { addListener() {} } },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
  });

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    URL, URLSearchParams, AbortController, Date, Math, JSON,
    chrome,
    fetch: async () => ({ ok: true, text: async () => "" }),
    WebSocket: class { constructor() { throw new Error("不连 WebSocket"); } },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  // 只加载 background.js: 它与 common.js 有同名 const(KEY_DOMAINS) —— 这正是
  // "SW 里绝不 importScripts common.js" 那条约束的由来, 一起塞进同一个 realm 就是 SyntaxError。
  const abs = path.join(ROOT, "background.js");
  new vm.Script(fs.readFileSync(abs, "utf8"), { filename: abs }).runInContext(sandbox);
  return { sandbox, sets, calls, getDetachListener: () => detachListener };
}

// 预置"该 tab 正在被录制"的 attach 记录, 否则 detachTab 找不到条目也就没有清理动作可断言
function store_seed(env, tabIds) {
  env.sandbox.chrome.storage.local.set({ "toolbox.debugTabs": [...tabIds] });
}

(async () => {
  // 场景 1: 桥接自发的 detach(标记里有 tabId) → 不清录制状态
  {
    const env = newEnv();
    ok("background.js 注册了 onDetach 监听", typeof env.getDetachListener() === "function", String(env.getDetachListener()));
    env.sandbox.globalThis.toolboxBridgeOwnDetach = new Set([7]);
    const before = env.sets.length;
    await env.getDetachListener()({ tabId: 7 });
    await new Promise((r) => setTimeout(r, 30));
    ok("桥接自发 detach → 不做任何清理(detach 0 次 / 不写 storage)",
      env.sets.length === before && env.calls.detach === 0, { sets: env.sets.length - before, detach: env.calls.detach });
  }

  // 场景 2: 用户点黄条取消 / 被别处抢走(标记里没有该 tabId) → 必须清
  {
    const env = newEnv();
    store_seed(env, [9]);
    env.sandbox.globalThis.toolboxBridgeOwnDetach = new Set([8]);
    const before = env.sets.length;
    await env.getDetachListener()({ tabId: 9 });
    await new Promise((r) => setTimeout(r, 30));
    ok("非桥接 detach → 真的 detach 并清记录", env.calls.detach === 1 && env.sets.length > before,
      { detach: env.calls.detach, sets: env.sets.length - before });
  }

  // 场景 3: 标记不存在(桥接未加载) → 仍按真实 detach 处理, 不许因缺标记崩掉
  {
    const env = newEnv();
    store_seed(env, [10]);
    env.sandbox.globalThis.toolboxBridgeOwnDetach = undefined;
    const before = env.sets.length;
    let threw = null;
    try { await env.getDetachListener()({ tabId: 10 }); } catch (e) { threw = e; }
    await new Promise((r) => setTimeout(r, 30));
    ok("标记缺失 → 不抛错且仍清理", !threw && env.calls.detach === 1 && env.sets.length > before,
      { threw: threw && threw.message, detach: env.calls.detach });
  }

  // 场景 4: 事件不带 tabId → 不炸
  {
    const env = newEnv();
    let threw = null;
    try { await env.getDetachListener()({}); } catch (e) { threw = e; }
    ok("无 tabId 的 detach 事件 → 不抛错", !threw, threw && threw.message);
  }

  console.log(fail ? `=== bg detach guard FAIL: ${fail} ===` : "=== bg detach guard PASS ===");
  process.exit(fail ? 1 : 0);
})();
