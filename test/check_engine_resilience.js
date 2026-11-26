// 录制引擎韧性走查(v1.3.7 新增):
//   缺陷: flushEntries 的批写入链里 `await chrome.storage.local.get([KEY_HARVEST])` 没有 try/catch,
//   一次 reject 就让 harvestQueue 变成 rejected promise —— 后续每批的 .then(只带成功回调)
//   拒绝直接穿透、回调永不执行, 于是**之后所有录制条目永久不入库**, 而 diag 零记录、
//   recState 仍是 recording(用户看着"录制中"其实一条都进不去)。
//   场景:
//     1. 单次读失败 → 重试自愈, 该条目不丢、无未处理 rejection
//     2. 连续两次读失败 → 本批丢弃但有诊断、**历史不被覆盖**、后续批次照常入库(链没死)
//     3. 故障后 getRecInfo().count 与库内真实条数一致(计数不再冻住)
// 手法与 check_engine_edge.js 一致: vm 外 require 真 background.js + chrome mock, 走真实事件管线。
const mem = {};
const listeners = {};
function on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); }
let failNextGet = 0;      // 只让「flushEntries 那次 promise 形式的 harvest 读」失败, 其余路径保持健康
let getRejectCount = 0;
let poisonRead = 0;       // 让下一次 harvest 读**成功**但解析出的对象访问属性即抛(打穿链尾自愈)
const rejections = [];
process.on("unhandledRejection", (e) => rejections.push(String((e && e.message) || e)));

global.chrome = {
  storage: {
    local: {
      QUOTA_BYTES: 10485760,
      get: (keys, cb) => {
        const isHarvest = keys === "toolbox.harvest" || (Array.isArray(keys) && keys.includes("toolbox.harvest"));
        if (poisonRead > 0 && isHarvest && !cb) {
          // 读出这一步成功, 但调用方一访问属性就抛 —— 模拟「读之后」任何未预料的抛出
          poisonRead--;
          // then 必须返回 undefined: 否则 await/Promise.resolve 取 then 时就在这里抛,
          // 被 readHarvestWithRetry 的第一层 try 吞掉 → 重试拿到真实库, 注入根本到不了"读出之后"。
          return Promise.resolve(new Proxy({}, {
            get(t, prop) {
              if (prop === "then") return undefined;
              throw new Error("注入: 读出后访问属性即抛");
            },
          }));
        }
        if (failNextGet > 0 && isHarvest && !cb) {
          failNextGet--;
          getRejectCount++;
          return Promise.reject(new Error("QUOTA_BYTES quota exceeded (模拟瞬时读失败)"));
        }
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
    attach: async () => {}, detach: async () => {},
    sendCommand: async (src, method, params) => {
      if (method === "Network.getResponseBody") return { body: global.__respBodies[params.requestId] ?? "", base64Encoded: false };
      return {};
    },
  },
  alarms: { onAlarm: { addListener: () => {} }, create: async () => {}, clear: async () => {} },
  action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
  tabs: { onRemoved: { addListener: (fn) => on("removed", fn) } },
  permissions: { contains: async () => false },
};
global.__respBodies = {};
const ROOT = require("path").resolve(__dirname, "..");
require(ROOT + "/background.js");

function msg(type, payload) {
  return new Promise((resolve) => {
    let responded = false;
    const sendResponse = (v) => { if (!responded) { responded = true; resolve(v); } };
    const ret = listeners["message"][0]({ type, ...payload }, {}, sendResponse);
    if (ret !== true && !responded) resolve(undefined);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const harvest = () => mem["toolbox.harvest"];
const paths = () => ((harvest() || {}).entries || []).map((e) => e.path);
const fire = (method, params) => listeners["event"].forEach((fn) => fn({ tabId: 123 }, method, params));

async function oneRequest(id) {
  global.__respBodies[id] = "body-" + id;
  fire("Network.requestWillBeSent", { requestId: id, timestamp: 1, request: { url: "https://app.test.com/" + id, method: "GET", headers: {} } });
  fire("Network.responseReceived", { requestId: id, response: { status: 200, mimeType: "text/plain" } });
  fire("Network.loadingFinished", { requestId: id, timestamp: 1.1 });
  await sleep(80);  // 等 getResponseBody → pushEntry → 微任务封批 → flush 落库
}

let pass = 0, fail = 0;
const ok = (cond, m) => { if (cond) { pass++; console.log("  OK " + m); } else { fail++; console.log("  ✗ FAIL " + m); } };

(async () => {
  await msg("setDomains", { domains: ["app.test.com"] });
  await msg("startRecording", { tabId: 123 });

  // 1) 单次读失败 → 重试自愈
  await oneRequest("a1");
  ok(paths().join() === "/a1", "基线: 正常批入库 " + JSON.stringify(paths()));
  failNextGet = 1;
  await oneRequest("b1");
  ok(paths().includes("/b1"), "1a 单次读失败后重试成功, 该条目没丢(实得 " + JSON.stringify(paths()) + ")");
  ok(getRejectCount === 1, "1b 确实发生了一次读失败(getRejectCount=" + getRejectCount + ")");
  ok(rejections.length === 0, "1c 无未处理 rejection(旧实现会沿链穿透出 " + rejections.length + " 条)");

  // 2) 连续两次读失败 → 本批丢, 但历史保留 + 有诊断 + 链不死
  failNextGet = 2;
  await oneRequest("c1");
  const p2 = paths();
  ok(!p2.includes("/c1"), "2a 两次读都失败时本批确实丢弃(c1 不在库: " + JSON.stringify(p2) + ")");
  ok(p2.includes("/a1") && p2.includes("/b1"), "2b 历史条目未被覆盖(a1/b1 仍在库 —— 降级成空数组再 set 会全抹掉)");
  const diagLog = ((await msg("getDiagLog")) || {}).log || [];
  const hit = diagLog.find((e) => String(e && e.message || "").includes("storage 读取失败"));
  ok(!!hit, "2c 读失败进了诊断日志(旧实现 diag 零记录)");
  ok(!!hit && hit.level === "error", "2d 诊断级别是 error(实得 " + (hit && hit.level) + ")");

  // 3) 链没死: 故障之后的新批次必须照常入库
  await oneRequest("d1");
  ok(paths().includes("/d1"), "3a 读恢复后新批次照常入库(链未粘死, 实得 " + JSON.stringify(paths()) + ")");

  // 4) 计数不冻: getRecInfo().count 与库内真实条数一致
  const info = (await msg("getRecInfo")) || {};
  ok(info.count === paths().length, "4a 面板计数与库内条数一致(count=" + info.count + ", 实际=" + paths().length + ")");
  ok(info.recState === "recording", "4b 录制状态保持 recording(未因故障自行中断)");

  // 5) 链尾自愈: 读成功但解析阶段任何未预料抛出, 不得让整条链粘死
  poisonRead = 1;
  await oneRequest("e1");
  ok(!paths().includes("/e1"), "5a 解析抛出时本批丢弃(e1 不在库: " + JSON.stringify(paths()) + ")");
  const diag2 = ((await msg("getDiagLog")) || {}).log || [];
  ok(diag2.some((e) => String(e && e.message || "").includes("flush 链异常已自愈")), "5b 链尾自愈写进了诊断(而不是静默哑掉)");
  await oneRequest("f1");
  ok(paths().includes("/f1"), "5c 解析抛出之后新批次仍入库(链尾 catch 把链拉回 resolved, 实得 " + JSON.stringify(paths()) + ")");

  await msg("stopRecording");
  console.log(fail ? `\n=== 引擎韧性 FAIL: ${fail} ===` : `\n=== 引擎韧性 PASS (${pass} 项) ===`);
  process.exit(fail ? 1 : 0);
})();
