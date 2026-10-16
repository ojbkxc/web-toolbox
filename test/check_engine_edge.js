// 录制引擎边界走查:
//   1. 入列乱序修复: 慢接口先发(t早)、快接口后发(t晚)但先完成 → flush 后库内按 ts 排序
//   2. 关无关 tab 不作废录制中的在途请求(pending.clear 只对录制目标 tab)
//   3. 关录制目标 tab → pending 清空(死条目不残留)
//   4. loadingFailed 不入列 / 响应体 200KB 截断 / 信封格式
//   5. 双请求乱序 + 失败混合场景端到端
//   6. 配额预算裁剪真实数据流(100 条 × 80KB → 裁到预算内)
//   7. pauseRecording 语义(v1.0.53 协议盘点补测): 新请求不收, 在途照常落库
//   8. 合帧批语义(v1.0.55): 同 tick 攒一批一次写(合帧价值)+ 批内 FIFO 保序
const mem = {};
const listeners = {};
function on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); }
let setCallCount = 0; // storage.set 调用计数(场景 8 合帧批语义断言用)
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
      set: (obj, cb) => { setCallCount++; Object.assign(mem, obj); if (cb) cb(); return Promise.resolve(); },
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
    // getResponseBody: 按 requestId 返回不同响应(控制完成序)
    sendCommand: async (src, method, params) => {
      if (method === "Network.getResponseBody") {
        const body = global.__respBodies[params.requestId] ?? "";
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
const ROOT = require('path').resolve(__dirname, '..');
require(ROOT + '/background.js');

function msg(type, payload) {
  return new Promise((resolve) => {
    let responded = false;
    const sendResponse = (v) => { if (!responded) { responded = true; resolve(v); } };
    const ret = listeners["message"][0]({ type, ...payload }, {}, sendResponse);
    if (ret !== true && !responded) resolve(undefined);
  });
}
let clock = 0;
function fire(method, params) {
  listeners["event"].forEach((fn) => fn({ tabId: 123 }, method, params));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  OK ' + msg); } else { fail++; console.log('  ✗ FAIL ' + msg); } };
const harvest = () => mem["toolbox.harvest"];
const ids = () => (harvest()?.entries || []).map((e) => e.id);

(async () => {
  await msg("setDomains", { domains: ["app.test.com"] });
  await msg("startRecording", { tabId: 123 });

  // 1) 乱序场景: 慢接口 A 先发(ts 早) 但响应后到; 快接口 B 后发先完成
  // requestWillBeSent 的到达序 = 发出序: A 先到达, B 后到达 —— ts 由 Date.now() 生成,
  // mock 下同 tick 生成 ts 相同 → 无法区分。改从条目自身拿 ts 后用 __ts 注入不可行(ts 在引擎内生成)。
  // 等价验证: 直接预置库里已有旧条目(模拟上一批), 新批条目 ts 更晚但 push 在前 —— 排序后仍按 ts 序。
  mem["toolbox.harvest"] = { v: 1, entries: [
    { id: "old1", method: "GET", url: "https://app.test.com/a", path: "/a", query: "", headers: {}, body: "", status: 200, mime: "", response: "", ts: "2026-09-17T10:00:00.000Z" },
    { id: "old2", method: "GET", url: "https://app.test.com/b", path: "/b", query: "", headers: {}, body: "", status: 200, mime: "", response: "", ts: "2026-09-17T10:00:02.000Z" },
  ] };
  // 新请求: 系统时钟现在(2026 实际时刻) >> 10:00 mock 旧条目 —— 但两个 fire 之间真实时钟几乎同 ms
  // 用两次 fire + 手动等 3ms 间隔保证 ts 递增:
  fire("Network.requestWillBeSent", { requestId: "n1", timestamp: 1, request: { url: "https://app.test.com/n1", method: "GET", headers: {} } });
  await sleep(4);
  fire("Network.requestWillBeSent", { requestId: "n2", timestamp: 2, request: { url: "https://app.test.com/n2", method: "GET", headers: {} } });
  fire("Network.responseReceived", { requestId: "n2", response: { status: 200, mimeType: "application/json" } });
  fire("Network.loadingFinished", { requestId: "n2", timestamp: 2.05 }); // n2 先完成
  await sleep(4);
  fire("Network.responseReceived", { requestId: "n1", response: { status: 200, mimeType: "application/json" } });
  fire("Network.loadingFinished", { requestId: "n1", timestamp: 4.0 });  // n1 后完成(慢)
  await sleep(60);
  const es = harvest().entries;
  const paths = es.map((e) => e.path);
  ok(paths.join() === "/a,/b,/n1,/n2", '入库按 ts 排序(n1 先发排前, 完成序倒挂被纠正): ' + paths.join());
  ok(es[2].path === "/n1" && es[2].ts <= es[3].ts, "ts 递增序保持");

  // 2) 关无关 tab: 在途请求应存活
  fire("Network.requestWillBeSent", { requestId: "k1", timestamp: 5, request: { url: "https://app.test.com/k1", method: "GET", headers: {} } });
  // 关 tab 999(非录制目标)
  listeners["removed"].forEach((fn) => fn(999));
  await sleep(10);
  fire("Network.responseReceived", { requestId: "k1", response: { status: 200, mimeType: "" } });
  fire("Network.loadingFinished", { requestId: "k1", timestamp: 5.1 });
  await sleep(60);
  ok((harvest().entries || []).some((e) => e.path === "/k1"), "关无关 tab 后在途请求照常入列(原实现 pending.clear() 会作废)");

  // 3) 关录制目标 tab → pending 清空, 在途死条目不残留(其 loadingFinished 不会再来)
  fire("Network.requestWillBeSent", { requestId: "dead1", timestamp: 6, request: { url: "https://app.test.com/dead", method: "GET", headers: {} } });
  listeners["removed"].forEach((fn) => fn(123));
  await sleep(10);
  const infoAfterClose = await msg("getRecInfo");
  ok(infoAfterClose.pending === 0, "关录制 tab 后 pending 清空(死条目不残留), pending=" + infoAfterClose.pending);
  // 已入库数据保留
  ok((harvest().entries || []).some((e) => e.path === "/k1") && (harvest().entries || []).some((e) => e.path === "/n1"), "已入库数据保留");

  // 4) loadingFailed 不入列
  await msg("startRecording", { tabId: 123 });
  fire("Network.requestWillBeSent", { requestId: "f1", timestamp: 7, request: { url: "https://app.test.com/fail", method: "GET", headers: {} } });
  fire("Network.loadingFailed", { requestId: "f1", errorText: "net::ERR_ABORTED" });
  await sleep(50);
  ok(!(harvest().entries || []).some((e) => e.path === "/fail"), "loadingFailed 不入列");

  // 5) 响应体超长截断
  global.__respBodies["big"] = "X".repeat(300000);
  fire("Network.requestWillBeSent", { requestId: "big", timestamp: 8, request: { url: "https://app.test.com/big", method: "GET", headers: {} } });
  fire("Network.responseReceived", { requestId: "big", response: { status: 200, mimeType: "text/plain" } });
  fire("Network.loadingFinished", { requestId: "big", timestamp: 8.1 });
  await sleep(60);
  const big = (harvest().entries || []).find((e) => e.path === "/big");
  ok(big && big.response.length === 200000, "响应体截断到 200KB(实得 " + (big ? big.response.length : 0) + ")");
  ok(harvest().v === 1, "信封 v=1");

  // 6) 配额预算裁剪真实数据流: 100 条 × 80KB(8MB > 7.5MB 预算) → flush 后库应被裁到 ≤ 预算,
  //    最新一条永远保留, diag 里有裁剪记录。走真实 flushEntries 合帧管线(非单测函数直调)。
  await msg("stopRecording");
  mem["toolbox.harvest"] = { v: 1, entries: [] };
  await msg("startRecording", { tabId: 123 });
  const BUDGET = 10485760 * 0.75;
  const N = 100;
  for (let i = 0; i < N; i++) {
    global.__respBodies["q" + i] = "Z".repeat(80000);
    fire("Network.requestWillBeSent", { requestId: "q" + i, timestamp: 10 + i * 0.1, request: { url: `https://app.test.com/q${i}`, method: "GET", headers: {} } });
    fire("Network.responseReceived", { requestId: "q" + i, response: { status: 200, mimeType: "text/plain" } });
    fire("Network.loadingFinished", { requestId: "q" + i, timestamp: 10 + i * 0.1 + 0.05 });
  }
  await sleep(400); // 等 flush 队列(串行链)全部落库
  const hv = harvest();
  const bytes = JSON.stringify(hv).length;
  ok(bytes <= BUDGET, `大流量 flush 后库 ≤ 7.5MB 预算(实得 ${bytes} ≤ ${BUDGET})`);
  ok(hv.entries.length < N, `超预算条目被裁(实得 ${hv.entries.length} < ${N})`);
  ok(hv.entries.some((e) => e.path === "/q99"), "最新一条(q99)永远保留");
  ok(!hv.entries.some((e) => e.path === "/q0"), "最旧(q0)被裁");

  // 7) pauseRecording 语义(v1.0.53 消息协议盘点补测 —— 此前零覆盖):
  //    paused 时 handleRequestWillBeSent 直接 return(新请求不收),
  //    但 paused 前已发出的在途请求(已进 pending)的 loadingFinished 照常落库
  //    —— dispatch 的 response/loading 分支只查 pending, 不查 recState。
  //    用户心智: 点暂停的瞬间"之后"的流量不进, "之前"正在飞的不丢。
  await msg("stopRecording");
  const countBefore = harvest().entries.length;
  await msg("startRecording", { tabId: 123 });
  // 在途: 先发请求(进 pending), 再点暂停
  fire("Network.requestWillBeSent", { requestId: "inflight", timestamp: 30, request: { url: "https://app.test.com/inflight", method: "GET", headers: {} } });
  await msg("pauseRecording");
  fire("Network.responseReceived", { requestId: "inflight", response: { status: 200, mimeType: "application/json" } });
  fire("Network.loadingFinished", { requestId: "inflight", timestamp: 30.1 });
  // 暂停后新发出的请求: 不进
  fire("Network.requestWillBeSent", { requestId: "paused-new", timestamp: 31, request: { url: "https://app.test.com/paused-new", method: "GET", headers: {} } });
  fire("Network.responseReceived", { requestId: "paused-new", response: { status: 200, mimeType: "application/json" } });
  fire("Network.loadingFinished", { requestId: "paused-new", timestamp: 31.1 });
  await sleep(80);
  const infoPaused = await msg("getRecInfo");
  ok(infoPaused.recState === "paused", "pause 后 recState=paused: " + infoPaused.recState);
  ok((harvest().entries || []).some((e) => e.path === "/inflight"), "暂停前在途请求照常落库(不因暂停丢半截)");
  ok(!(harvest().entries || []).some((e) => e.path === "/paused-new"), "暂停后新请求不收");
  ok(harvest().entries.length === countBefore + 1, `条数只增在途 1 条(实得 ${harvest().entries.length}, 期望 ${countBefore + 1})`);

  // 7b) 暂停→继续(同 tab)全链路(v1.0.81, #178 用户报"点击继续录制有问题"修复锚):
  //     a) 同 tab 二次 attach 在真实 Chrome 抛 "Another debugger is already attached
  //        to the target with given id"(小写 already)—— attachTab 容错此前只认
  //        "Already attached"(大写)→ 继续录制在真实 Chrome 必失败。修复=大小写不敏感
  //        正则 /already attached/i。本测试的 attach stub 永远成功掩盖了这条路径,
  //        用"对已 attach tab 抛真实错误消息"的 stub 才能锚住容错分支。
  //     b) 同 tab 继续不再 pending.clear: 暂停语义承诺"在途不丢", 继续作废在途与之矛盾
  //        (暂停几秒点继续, 横跨暂停窗口的慢接口半截蒸发)。
  //     c) 暂停→继续的 unmatchedHosts 诊断线索保留(同一次录制的排查连续性)。
  {
    // 前置: 先恢复 recording(cross-pause 必须在 recording 态发出才能进 pending)
    await msg("startRecording", { tabId: 123 });
    // in-flight(pause 前发) + 点继续(同 tab 123)
    fire("Network.requestWillBeSent", { requestId: "cross-pause", timestamp: 40, request: { url: "https://app.test.com/cross-pause", method: "GET", headers: {} } });
    await msg("pauseRecording");
    const rResume = await msg("startRecording", { tabId: 123 }); // 同 tab 继续
    ok(rResume && rResume.ok === true, `同 tab 继续录制回 {ok:true}(实得 ${JSON.stringify(rResume)})`);
    fire("Network.responseReceived", { requestId: "cross-pause", response: { status: 200, mimeType: "application/json" } });
    fire("Network.loadingFinished", { requestId: "cross-pause", timestamp: 40.5 });
    // 继续后新请求照常
    fire("Network.requestWillBeSent", { requestId: "after-resume", timestamp: 41, request: { url: "https://app.test.com/after-resume", method: "GET", headers: {} } });
    fire("Network.responseReceived", { requestId: "after-resume", response: { status: 200, mimeType: "application/json" } });
    fire("Network.loadingFinished", { requestId: "after-resume", timestamp: 41.1 });
    await sleep(80);
    ok((harvest().entries || []).some((e) => e.path === "/cross-pause"), "暂停→继续: 横跨暂停窗口的在途请求照常落库(pending 不因同 tab 继续被清)");
    ok((harvest().entries || []).some((e) => e.path === "/after-resume"), "继续后新请求照常入列");
    const infoResumed = await msg("getRecInfo");
    ok(infoResumed.recState === "recording", "继续后 recState=recording: " + infoResumed.recState);
  }
  // 7c) 暂停→换 tab 继续: pending 必须清(旧 tab 在途死条目, loadingFinished 永不再来)
  {
    fire("Network.requestWillBeSent", { requestId: "stale-cross", timestamp: 50, request: { url: "https://app.test.com/stale-cross", method: "GET", headers: {} } });
    await msg("pauseRecording");
    await msg("startRecording", { tabId: 456 }); // 换 tab —— 旧 tab 在途作废
    const infoSwap = await msg("getRecInfo");
    ok(infoSwap.pending === 0, `暂停→换 tab 继续: pending 清空(旧 tab 在途不作废会成死条目), 实得 ${infoSwap.pending}`);
    ok(!(harvest().entries || []).some((e) => e.path === "/stale-cross"), "换 tab 后旧 tab 的在途请求不残留");
    await msg("stopRecording");
  }
  // 7d) 重录全链(v1.0.81 重录按钮的引擎侧语义): stop→clear→start 同 tab, 旧会话在途必须丢弃。
  //     stop 先回 idle → start 的 isResume=(recState==="paused")=false → `if (!isResume || !sameTab)`
  //     恒真 → pending.clear()。与 7b(暂停→继续同 tab 保在途)对比: 暂停继续是"延续", 重录是
  //     "全新会话", 在途作废是正确语义(避免旧页面残留流量混进新一轮)。
  {
    await msg("startRecording", { tabId: 123 });
    fire("Network.requestWillBeSent", { requestId: "rer-stale", timestamp: 55, request: { url: "https://app.test.com/rer-stale", method: "GET", headers: {} } });
    // 重录全链(同 tab): 停 → 清 → 开
    await msg("stopRecording");
    await msg("clearHarvest");
    await msg("startRecording", { tabId: 123 });
    // 旧在途的响应在重录完成后才到 → 应被丢弃(不在新会话)
    fire("Network.responseReceived", { requestId: "rer-stale", response: { status: 200, mimeType: "application/json" } });
    fire("Network.loadingFinished", { requestId: "rer-stale", timestamp: 55.1 });
    // 新会话请求照常录
    fire("Network.requestWillBeSent", { requestId: "rer-fresh", timestamp: 56, request: { url: "https://app.test.com/rer-fresh", method: "GET", headers: {} } });
    fire("Network.responseReceived", { requestId: "rer-fresh", response: { status: 200, mimeType: "application/json" } });
    fire("Network.loadingFinished", { requestId: "rer-fresh", timestamp: 56.1 });
    await sleep(80);
    const infoRer = await msg("getRecInfo");
    ok(infoRer.pending === 0, `重录后 pending 清空(旧会话在途作废), 实得 ${infoRer.pending}`);
    ok(!(harvest().entries || []).some((e) => e.path === "/rer-stale"), "重录后旧会话在途请求不混入新会话");
    ok((harvest().entries || []).some((e) => e.path === "/rer-fresh"), "重录后新会话请求照常入列");
    await msg("stopRecording");
  }

  // 7e) clearHarvest 与在途 flushEntries 竞态(v1.0.83): 已 loadingFinished 进 pushEntry 攒批
  //     的条目, clearHarvest 后不复活。此前 set(空信封) 不在 harvestQueue 链且无序号守卫,
  //     flush 在清空后执行: get 拿空信封 → push 旧条目 → set 写回 → 列表清不掉(用户实锤)。
  //     与 7d 区别: 7d 测的是"在途请求"(只 requestWillBeSent, pending Map), 本场景测的是
  //     "已完成进攒批"(loadingFinished → pushEntry, pendingEntries/harvestQueue 链) ——
  //     后者是 7d 未覆盖的竞态窗口, 也是用户"点了感觉没清空"的根因。
  {
    await msg("startRecording", { tabId: 123 });
    // 请求完成 → loadingFinished 的 async IIFE → pushEntry 进攒批(微任务, 未 flush)
    fire("Network.requestWillBeSent", { requestId: "clr-stale", timestamp: 200, request: { url: "https://app.test.com/clr-stale", method: "GET", headers: {} } });
    fire("Network.responseReceived", { requestId: "clr-stale", response: { status: 200, mimeType: "application/json" } });
    fire("Network.loadingFinished", { requestId: "clr-stale", timestamp: 200.1 });
    // 立即清空(不等 flush) —— 竞态窗口: 修复前 flush 在清空后写回 clr-stale → 复活
    const rc = await msg("clearHarvest");
    ok(rc && rc.ok === true, "clearHarvest 回 {ok:true}");
    await sleep(80);
    ok(!(harvest().entries || []).some((e) => e.path === "/clr-stale"), "clearHarvest 后已 pushEntry 的攒批条目不复活(竞态修复, v1.0.83)");
    ok(harvest() && harvest().v === 1 && (harvest().entries || []).length === 0, "clearHarvest 后库为空信封(非残留旧条目)");
    await msg("stopRecording");
  }

  // 8) 合帧批语义(v1.0.55): 同一 tick 批内 FIFO 保序 + 异步边界封批一次写 + 攒批不可被换会话作废
  //    pushEntry 攒批承诺从未被行为级测过(此前全靠最终态断言):
  //    a) 同 tick 连续 loadingFinished 多条 → 一批一次 storage.set(写放大合帧的价值所在)
  //    b) 批内按 push 顺序 FIFO(乱序完成不乱写入序——sort 只管 ts 展示序, push 序保持到达序)
  //    c) 已 pushEntry 的攒批条目在换会话(pending.clear)时不作废 —— pending.clear 只清
  //       CDP 在途 Map, 已脱离 pending 进攒批的条目在串行链上必达 storage(数据不丢)
  await msg("startRecording", { tabId: 123 });
  setCallCount = 0;
  for (let i = 0; i < 5; i++) {
    fire("Network.requestWillBeSent", { requestId: "batch" + i, timestamp: 40 + i * 0.1, request: { url: `https://app.test.com/batch${i}`, method: "GET", headers: {} } });
  }
  // 同一 tick 全部 loadingFinished → pushEntry 同 tick 攒批
  for (let i = 0; i < 5; i++) {
    fire("Network.responseReceived", { requestId: "batch" + i, response: { status: 200, mimeType: "application/json" } });
    fire("Network.loadingFinished", { requestId: "batch" + i, timestamp: 40 + i * 0.1 + 0.05 });
  }
  await sleep(120);
  const batchEntries = (harvest().entries || []).filter((e) => e.path.startsWith("/batch"));
  ok(batchEntries.length === 5, `同 tick 5 条全入列(实得 ${batchEntries.length})`);
  // 批语义 a: 一批一次写 —— storage.set 调用次数远小于条数(合帧)
  // (setCallCount 由下方 stub 钩子累加; 5 条若不合帧是 5 次 set, 合帧后 1 次 + 后续批次)
  ok(setCallCount <= 2, `合帧生效: 5 条攒一批, storage.set 仅 ${setCallCount} 次(不合帧会是 5+)`);
  // 批语义 b: FIFO 保序(ts 排序后同刻并发保持入列相对序)
  ok(batchEntries.every((e, idx) => e.path === `/batch${idx}`), "批内按 push 序 FIFO 保序: " + batchEntries.map((e) => e.path).join(","));

  // 8b) 高频大批量合帧边界(v1.0.71, #165 方向②): 同 tick 120 条远超既有 5 条场景 ——
  //     合帧无批上限(攒批是"同 tick 全收"), 大批量只该体现为"批更大"而非"写更多次";
  //     120 条一次写 + 全部入列 + FIFO 保序, 顺带把 MAX_ENTRIES(3000) 裁剪的
  //     "远未触顶"侧也过了(120 << 3000, shift 不发生)。
  setCallCount = 0;
  for (let i = 0; i < 120; i++) {
    fire("Network.requestWillBeSent", { requestId: "big" + i, timestamp: 60 + i * 0.01, request: { url: `https://app.test.com/big${i}`, method: "GET", headers: {} } });
  }
  for (let i = 0; i < 120; i++) {
    fire("Network.responseReceived", { requestId: "big" + i, response: { status: 200, mimeType: "application/json" } });
    fire("Network.loadingFinished", { requestId: "big" + i, timestamp: 60 + i * 0.01 + 0.005 });
  }
  await sleep(200);
  const bigBatch = (harvest().entries || []).filter((e) => e.path.startsWith("/big"));
  ok(bigBatch.length === 120, `同 tick 120 条全入列(实得 ${bigBatch.length})`);
  ok(setCallCount <= 2, `120 条大批量合帧: storage.set 仅 ${setCallCount} 次(不合帧会是 120+)`);
  ok(bigBatch.every((e, idx) => e.path === `/big${idx}`), "120 条批内 FIFO 保序: " + bigBatch.slice(0, 3).map((e) => e.path).join(",") + "…");

  // 9) pause/stop 的 sendResponse 对称性(v1.0.64, #157 方向④): 两个分支此前无 try/catch ——
  //    storage.set 抛错(配额满等)时 unhandled rejection + 调用方端口关闭错误, 指令已生效
  //    (内存态改了)但错误被吞。对称补 try/catch 后, 失败也走 sendResponse({ok:false})。
  //    行为级: 注入抛错的 storage.set → pause/stop 都要返回 {ok:false, error} 而非炸/永挂。
  {
    const origSet = global.chrome.storage.local.set;
    global.chrome.storage.local.set = (obj, cb) => Promise.reject(new Error("quota exceeded"));
    const rp = await msg("pauseRecording");
    ok(rp && rp.ok === false && String(rp.error).includes("quota"), `pause 失败走 {ok:false,error}(非永挂): ${JSON.stringify(rp)}`);
    const rs = await msg("stopRecording");
    ok(rs && rs.ok === false && String(rs.error).includes("quota"), `stop 失败走 {ok:false,error}(非永挂): ${JSON.stringify(rs)}`);
    global.chrome.storage.local.set = origSet; // 还原 stub, 不污染后续场景
    const r2 = await msg("stopRecording");
    ok(r2 && r2.ok === true, "还原后 stop 正常回 {ok:true}(修复未破坏主路径)");
  }

  // 9b) (说明) clearHarvest 的 set(空信封)在真实 Chrome 里不会走 pause/stop 的 promise 链
  //     (回调式), 配额满场景由场景 10 的空信封落库断言覆盖主路径即可, 不重复注入。

  // 10) clearHarvest 派生键清单(v1.0.78): #173 起 pickIds 也是锚定条目 id 的持久化派生键,
  //     background 权威清单必须跟上 —— 否则非发起面板/重开侧栏前 storage 一直残留死勾选。
  //     行为级: 预置 5 派生键(4 旧 + pickIds) → clearHarvest → storage 全部消失 + 空信封落库。
  {
    mem["toolbox.corrResult"] = { groups: [] };
    mem["toolbox.aiChain"] = [{ from: 0, to: 0, var: "v" }];
    mem["toolbox.aiAsserts"] = [{ path: "x", asserts: [] }];
    mem["toolbox.manualPrelude"] = [["r1", true]];
    mem["toolbox.pickIds"] = ["r1", "r2"];
    const rc = await msg("clearHarvest");
    ok(rc && rc.ok === true, "clearHarvest 回 {ok:true}");
    ok(mem["toolbox.corrResult"] === undefined && mem["toolbox.aiChain"] === undefined &&
       mem["toolbox.aiAsserts"] === undefined && mem["toolbox.manualPrelude"] === undefined,
       "clearHarvest 清 4 个旧派生键(回归锚, 改清单不许丢旧键)");
    ok(mem["toolbox.pickIds"] === undefined, "clearHarvest 清 toolbox.pickIds(v1.0.78: 权威清单跟上 #173 新键)");
    const hv = harvest();
    ok(hv && hv.v === 1 && hv.entries.length === 0, "清空落库是空信封(非 remove, onChanged 清空分支依赖 newValue)");
  }

  await msg("stopRecording");
  console.log(fail ? `\n=== 引擎边界 FAIL: ${fail} ===` : `\n=== 引擎边界走查 PASS ===`);
  process.exit(fail ? 1 : 0);
})();
