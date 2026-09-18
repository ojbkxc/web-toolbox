// 端到端 mock 测试 background.js 的录制数据流
// 模拟 chrome API, 验证: 配域名 → startRecording → 请求事件 → storage 落库 → stop 数据保留
const mem = {};
const listeners = {};
function on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); }

global.chrome = {
  storage: {
    local: {
      QUOTA_BYTES: 10485760,
      // 同时支持 promise 与 callback 两种调用(background.js 两种都用了)
      get: (keys, cb) => {
        const out = {};
        if (typeof keys === "string") { out[keys] = mem[keys]; }
        else if (Array.isArray(keys)) { for (const k of keys) if (k in mem) out[k] = mem[k]; }
        else Object.assign(out, mem);
        if (cb) cb(out);
        return Promise.resolve(out);
      },
      set: (obj, cb) => { Object.assign(mem, obj); if (cb) cb(); return Promise.resolve(); },
      remove: (keys, cb) => { for (const k of (Array.isArray(keys) ? keys : [keys])) delete mem[k]; if (cb) cb(); return Promise.resolve(); },
    },
    onChanged: { addListener: () => {} },
  },
  runtime: {
    onInstalled: { addListener: (fn) => on("installed", fn) },
    onMessage: { addListener: (fn) => on("message", fn) },
  },
  debugger: {
    onDetach: { addListener: (fn) => on("detach", fn) },
    onEvent: { addListener: (fn) => on("event", fn) },
    attach: async () => {},
    detach: async () => {},
    sendCommand: async () => ({ body: '{"ok":1}', base64Encoded: false }),
  },
  alarms: {
    onAlarm: { addListener: () => {} },
    create: async () => {},
    clear: async () => {},
  },
  action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
  tabs: { onRemoved: { addListener: () => {} } },
  permissions: { contains: async () => false },
};

require("./background.js");

function msg(type, payload) {
  return new Promise((resolve) => {
    let responded = false;
    const sendResponse = (v) => { if (!responded) { responded = true; resolve(v); } };
    const ret = listeners["message"][0]({ type, ...payload }, {}, sendResponse);
    if (ret !== true && !responded) resolve(undefined);
  });
}
// debugger.sendCommand 用回调风格(background 里 chrome.debugger.sendCommand 是 promise, 但 getResponseBody 走 await, 兼容)
function fire(method, params) {
  const src = { tabId: 123 };
  for (const fn of listeners["event"]) fn(src, method, params);
}

(async () => {
  // 1) 配域名
  await msg("setDomains", { domains: ["app.test.com"] });
  // 2) 开始录制
  const s = await msg("startRecording", { tabId: 123 });
  console.log("startRecording:", JSON.stringify(s));
  // 3) 请求事件流
  fire("Network.requestWillBeSent", {
    requestId: "r1",
    request: { url: "https://app.test.com/web/login", method: "POST", headers: { "Content-Type": "application/json" }, postData: '{"user":"a"}' },
  });
  fire("Network.responseReceived", { requestId: "r1", response: { status: 200, mimeType: "application/json" } });
  fire("Network.loadingFinished", { requestId: "r1" });
  // 等 flush 合帧微任务 + storage 写入
  await new Promise((r) => setTimeout(r, 50));
  const info = await msg("getRecInfo");
  console.log("getRecInfo count:", info.count, "recState:", info.recState);
  const h = mem["toolbox.harvest"];
  console.log("harvest 条目数:", h && h.entries ? h.entries.length : "无", "首条 body:", h && h.entries[0] ? JSON.stringify(h.entries[0].body) : "-");
  // 4) 停止
  await msg("stopRecording");
  const info2 = await msg("getRecInfo");
  console.log("stop 后 recState:", info2.recState, "count:", info2.count, "(数据应保留)");
})();