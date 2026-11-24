// test/check_record_all.js —— 录制不变量「永远全录」闸门(v1.1.69)
//
// 为什么需要: AGENTS §1.7 写着"录制永远全录(过滤/勾选/清洗只影响显示与导出)", 但此前
// **没有任何闸门管这条规则** —— 实证: 在 background.js 的完成路径插一句
// `if (e.status !== 200) return;` 丢弃非 200 条目, 现有全部闸门仍全绿。
//
// 本闸门断言(全都落在"库里有什么", 不看显示层):
//   ① 状态码 2xx/3xx/4xx/5xx 全部入库(失败也是证据, 不许丢);
//   ② 任意 mime(text/html、image/png、text/event-stream、空 mime)全部入库;
//   ③ 超长响应体只截断不丢条目(条目在, response 被切);
//   ④ 空响应体(204/无 body)仍入库(response 为空串);
//   ⑤ loadingFailed 的请求**不入库**(这是唯一合法的"不录" —— 半截数据无意义);
//   ⑥ 域名不匹配的请求不入库(这是域名授权模型的过滤, 不是录制层过滤)。
const mem = {};
const listeners = {};
function on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); }
global.chrome = {
  storage: {
    local: {
      QUOTA_BYTES: 10485760,
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
  runtime: { onInstalled: { addListener: (fn) => on("installed", fn) }, onMessage: { addListener: (fn) => on("message", fn) } },
  debugger: {
    onDetach: { addListener: (fn) => on("detach", fn) },
    onEvent: { addListener: (fn) => on("event", fn) },
    attach: async () => {},
    detach: async () => {},
    sendCommand: async (src, method, params) => {
      if (method === "Network.getResponseBody") {
        const body = (global.__respBodies || {})[params.requestId] ?? "";
        return { body, base64Encoded: false };
      }
      return {};
    },
  },
  alarms: { onAlarm: { addListener: () => {} }, create: async () => {}, clear: async () => {} },
  action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
  tabs: { onRemoved: { addListener: (fn) => on("removed", fn) } },
  permissions: { contains: async () => false },
};
global.__respBodies = {};

const path = require("path");
require(path.resolve(__dirname, "..", "background.js"));

function msg(type, payload) {
  return new Promise((resolve) => {
    let responded = false;
    const sendResponse = (v) => { if (!responded) { responded = true; resolve(v); } };
    const ret = listeners["message"][0]({ type, ...payload }, {}, sendResponse);
    if (ret !== true && !responded) resolve(undefined);
  });
}
function fire(method, params) {
  listeners["event"].forEach((fn) => fn({ tabId: 123 }, method, params));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log("  OK " + msg); } else { fail++; console.log("  ✗ FAIL " + msg); } };
const entries = () => (mem["toolbox.harvest"] && mem["toolbox.harvest"].entries) || [];

// 走一遍完整请求生命周期。status/mime/body 都来自参数, 便于逐形态断言。
function roundTrip(reqId, { url, method = "GET", status = 200, mime = "application/json", body = "", fail = false } = {}) {
  fire("Network.requestWillBeSent", { requestId: reqId, timestamp: 1, request: { url, method, headers: {} } });
  if (fail) { fire("Network.loadingFailed", { requestId: reqId }); return; }
  fire("Network.responseReceived", { requestId: reqId, response: { status, mimeType: mime } });
  if (body) global.__respBodies[reqId] = body;
  fire("Network.loadingFinished", { requestId: reqId, timestamp: 1.05 });
}

(async () => {
  await msg("setDomains", { domains: ["app.test.com"] });
  await msg("startRecording", { tabId: 123 });

  // ① 状态码全形态
  roundTrip("s200", { url: "https://app.test.com/ok" });
  roundTrip("s302", { url: "https://app.test.com/redir", status: 302 });
  roundTrip("s404", { url: "https://app.test.com/missing", status: 404 });
  roundTrip("s500", { url: "https://app.test.com/boom", status: 500 });
  await sleep(60);
  const st = entries().map((e) => e.status).sort((a, b) => a - b);
  ok(st.join() === "200,302,404,500", "① 2xx/3xx/4xx/5xx 全部入库: " + st.join());

  // ② mime 全形态
  roundTrip("m1", { url: "https://app.test.com/a.html", mime: "text/html", body: "<html>x</html>" });
  roundTrip("m2", { url: "https://app.test.com/i.png", mime: "image/png" });
  roundTrip("m3", { url: "https://app.test.com/sse", mime: "text/event-stream", body: "data: 1\n\n" });
  roundTrip("m4", { url: "https://app.test.com/no-mime", mime: "" });
  await sleep(60);
  const mimes = entries().map((e) => e.mime).filter((m) => m !== undefined);
  const hasAllMime = ["text/html", "image/png", "text/event-stream"].every((m) => mimes.includes(m));
  ok(hasAllMime, "② text/html、image/png、text/event-stream 都入库(净化只在导出层)");
  ok(entries().length === 8, "② 累计 8 条(4 状态码 + 4 mime 形态): " + entries().length);

  // ③ 超长响应体: 条目在, response 按 **UTF-8 字节**截断(200KB = 204800B 上限, v1.2.0)
  global.__respBodies["big"] = "A".repeat(300000);
  roundTrip("big", { url: "https://app.test.com/big", body: "A".repeat(300000) });
  await sleep(80);
  const big = entries().find((e) => e.path === "/big");
  ok(!!big, "③ 超长响应体仍入库(不丢条目)");
  ok(big && Buffer.byteLength(big.response, "utf8") <= 204800,
    "③ 响应体按字节截断到 204800B: " + (big ? Buffer.byteLength(big.response, "utf8") + "B" : "-"));

  // ④ 空响应体(204/无 body)
  roundTrip("empty", { url: "https://app.test.com/204", status: 204 });
  await sleep(60);
  const empty = entries().find((e) => e.path === "/204");
  ok(!!empty, "④ 204 空响应仍入库");
  ok(empty && empty.response === "", "④ response 为空串: " + JSON.stringify(empty && empty.response));

  // ⑤ loadingFailed 不入库(唯一合法的"不录")
  const before = entries().length;
  roundTrip("fail1", { url: "https://app.test.com/failed", fail: true });
  await sleep(60);
  ok(entries().length === before, "⑤ loadingFailed 不入库(半截数据无意义): " + before + " → " + entries().length);

  // ⑥ 域名不匹配不入库(域名授权模型的过滤, 不是录制层)
  const before2 = entries().length;
  roundTrip("other", { url: "https://other.test.com/nope" });
  await sleep(60);
  ok(entries().length === before2, "⑥ 非授权域不入库(域名模型过滤): " + before2 + " → " + entries().length);

  console.log(fail ? `\n=== record-all FAIL: ${fail} ===` : `\n=== record-all PASS: ${pass} ===`);
  process.exit(fail ? 1 : 0);
})();