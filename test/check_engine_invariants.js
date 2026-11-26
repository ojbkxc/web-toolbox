// 录制引擎不变式走查(v1.3.8):
//   不变式 · 时间序(R2): 库内条目必须按**请求发出序**排列。
//     ts = requestWillBeSent 到达时刻(ISO 串, 毫秒精度); startTs = CDP 单调时钟(亚毫秒)。
//     同一毫秒并发的两条请求 ts 相同, 只用 ts 比较恒等 —— 稳定排序会原样保留"入列序",
//     而入列序是响应完成序(loadingFinished 里异步取回 body 后才 push)。慢接口先完成就排到前面,
//     时间线/链路重放/JMX 采样顺序与真实请求序相反(取证见 REVIEW R127 R2, 脚本 r2_repro.js)。
//   不变式 · 丢数据必须留痕/可判(R4): 3000 条溢出要记诊断(含丢弃条数); base64 响应体换成占位串时
//     必须带 responseBase64 标记; stop 时在途条目要落库(标 incomplete)并清空 pending。
//   不变式 · 状态与现实一致(R5): 调试器被分离后 recState 必须回 idle、徽章不得再显示 REC;
//     冷启动窗口内到达的 response/finished 不得丢弃(pending 不许留死条目)。
//
//   本闸门**不靠 sleep 错开时间戳**(check_engine_edge 用 sleep(4), 恰好绕开唯一会坏的路径),
//   而是用可控时钟把两条请求的 ts 钉在同一毫秒; mock 的 storage.get 同步回调研判 KEY_TABS,
//   使 requestWillBeSent 在 fire() 调用栈内就地派发。等待落库一律轮询观测, 不用固定 sleep。
const path = require("path");
const ROOT = path.join(__dirname, "..");

// ---- 可控时钟: 只影响 new Date()(无参) ----
const RealDate = Date;
let frozen = null;
class FakeDate extends RealDate {
  constructor(...args) {
    if (args.length === 0 && frozen !== null) super(frozen);
    else super(...args);
  }
  static now() {
    return frozen !== null ? frozen : RealDate.now();
  }
}
global.Date = FakeDate;

// ---- chrome mock ----
const mem = {};
const listeners = {};
const badgeHistory = []; // 徽章文本历史(setBadgeText 调用序)
const on = (ev) => ({ addListener: (fn) => { (listeners[ev] = listeners[ev] || []).push(fn); } });
const keyList = (keys) => (Array.isArray(keys) ? keys : [keys]);
const pick = (keys) => {
  const out = {};
  for (const k of keyList(keys)) if (k in mem) out[k] = mem[k];
  return out;
};

global.__respBodies = {};
global.__respBase64 = {}; // id → base64 串(存在即视为 base64Encoded: true)
global.chrome = {
  storage: {
    local: {
      QUOTA_BYTES: 10485760,
      get: (keys, cb) => { const out = pick(keys); if (cb) { cb(out); return; } return Promise.resolve(out); },
      set: (obj, cb) => { Object.assign(mem, obj); if (cb) { cb(); return; } return Promise.resolve(); },
      remove: (keys, cb) => { for (const k of keyList(keys)) delete mem[k]; if (cb) { cb(); return; } return Promise.resolve(); },
    },
    onChanged: on("changed"),
  },
  runtime: { onInstalled: on("installed"), onMessage: on("message"), openOptionsPage() {}, getURL: (p) => p },
  alarms: { onAlarm: on("alarm"), create: async () => {}, clear: async () => {} },
  debugger: {
    onDetach: on("detach"),
    onEvent: on("event"),
    attach: async () => {},
    detach: async () => {},
    sendCommand: async (src, method, params) => {
      if (method !== "Network.getResponseBody") return {};
      const id = params.requestId;
      if (global.__respBase64[id]) return { body: global.__respBase64[id], base64Encoded: true };
      return { body: global.__respBodies[id] ?? "", base64Encoded: false };
    },
  },
  tabs: { onRemoved: on("removed"), query: async () => [], get: async () => ({}) },
  action: {
    setBadgeText: async (o) => { badgeHistory.push((o && o.text) || ""); },
    setBadgeBackgroundColor: async () => {},
  },
  permissions: { contains: async () => false },
  sidePanel: { open: async () => {} },
};

mem["toolbox.domains"] = ["app.test.com"];
mem["toolbox.recording"] = "recording";
mem["toolbox.debugTabs"] = [123];

require(path.join(ROOT, "background.js"));

// ---- 引擎驱动 ----
const fire = (method, params) => { for (const fn of (listeners["event"] || [])) fn({ tabId: 123 }, method, params); };
const fireDetach = (tabId) => { for (const fn of (listeners["detach"] || [])) fn({ tabId }); };
const harvest = () => {
  const raw = mem["toolbox.harvest"];
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  return Array.isArray(raw.entries) ? raw.entries : [];
};
const paths = () => harvest().map((e) => e.path);
const waitFor = async (pred, ms = 3000) => {
  const t0 = RealDate.now();
  while (!pred()) {
    if (RealDate.now() - t0 > ms) return false;
    await new Promise((r) => setTimeout(r, 5));
  }
  return true;
};
const msg = (type, payload = {}) =>
  new Promise((resolve) => {
    const fn = (listeners["message"] || [])[0];
    let done = false;
    const ret = fn(Object.assign({ type }, payload), {}, (r) => { done = true; resolve(r); });
    if (ret !== true && !done) resolve(undefined);
  });
const req = (id, startTs) =>
  fire("Network.requestWillBeSent", {
    requestId: id,
    timestamp: startTs, // undefined → 引擎 startTs = 0(旧数据/WebSocket 分支的实际形态)
    request: { url: "https://app.test.com/" + id, method: "GET", headers: {} },
  });
const finish = (id, startTs) => {
  global.__respBodies[id] = id;
  fire("Network.responseReceived", { requestId: id, response: { status: 200, mimeType: "text/plain", headers: {} } });
  fire("Network.loadingFinished", { requestId: id, timestamp: (startTs || 0) + 0.01 });
};
const reset = async () => { await msg("clearHarvest"); await waitFor(() => harvest().length === 0); };

let pass = 0;
let fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log("  ok   " + label); }
  else { fail++; console.log("  FAIL " + label); }
};

(async () => {
  // ---- 场景 0(R5-b): 冷启动窗口 —— 此刻 stateReady 还没跑完(domainsCache === null) ----
  // 三条事件同时落在这个窗口里: 此前只缓冲 requestWillBeSent, response/finished 因为在 pending
  // 里找不到条目被直接丢弃, 补处理后只留下一条永不完成的死条目, 该请求彻底蒸发。
  req("k1", 60.0);
  finish("k1", 60.0);
  await msg("getRecInfo"); // 等 stateReady(含缓冲补处理)
  const coldLanded = await waitFor(() => harvest().some((e) => e.path === "/k1"));
  ok(coldLanded, "冷启动窗口内的请求在补处理后落库(不再只重放 requestWillBeSent)");
  const ec = harvest().find((e) => e.path === "/k1");
  ok(
    ec && ec.status === 200 && ec.response === "k1",
    "冷启动条目是完整条目(有状态与响应体): " + JSON.stringify(ec && { status: ec.status, response: ec.response })
  );
  const coldPending = (await msg("getRecInfo")).pending;
  ok(coldPending === 0, "冷启动补处理后 pending 无残留死条目: " + coldPending);
  await reset();

  // ---- 场景 1: 同一毫秒并发(startTs 不同), 慢的 startTs 更晚却先完成 ----
  const T = RealDate.UTC(2026, 0, 1, 0, 0, 0, 5);
  frozen = T;
  req("t1", 10.0); // 先发出
  req("t2", 10.5); // 后发出
  frozen = null;
  ok(harvest().length === 0, "两条请求都已派发但尚未落库(攒批未 flush)");
  finish("t2", 10.5); // startTs 更晚的先完成 → 先入列
  finish("t1", 10.0);
  const landed = await waitFor(() => harvest().length === 2);
  ok(landed, "两条请求都已落库");
  const es = harvest();
  ok(es.length === 2 && es[0].ts === es[1].ts, "闸门确实构造了同毫秒 tie(两条 ts 相同): " + (es[0] && es[0].ts));
  ok(paths().join() === "/t1,/t2", "同毫秒 tie 仍按请求发出序排列(startTs 10.0 → 10.5): " + paths().join());
  ok(es.length === 2 && es[0].startTs === 10 && es[1].startTs === 10.5, "startTs 原样保留(10 / 10.5): " + es.map((e) => e.startTs).join(","));

  // ---- 场景 2: 缺 startTs 的条目(按 0)与有 startTs 的同毫秒请求混排 ----
  await reset();
  frozen = T + 1000;
  req("v1", undefined); // startTs 缺失 → 0
  req("v2", 5.5);
  frozen = null;
  finish("v2", 5.5);
  finish("v1", undefined);
  const landed2 = await waitFor(() => harvest().length === 2);
  ok(landed2, "混排两条均已落库");
  ok(paths().join() === "/v1,/v2", "缺 startTs 按 0 处理, 仍排在 5.5 之前(比较器不产生 NaN 乱序): " + paths().join());

  // ---- 场景 3: 跨毫秒(回归) —— ts 不同时仍按 ts 排, 与完成序无关 ----
  await reset();
  frozen = T + 2000;
  req("w1", 30.0);
  frozen = T + 2001; // ts 前进 1ms
  req("w2", 30.5);
  frozen = null;
  finish("w2", 30.5); // 后发出的先完成
  finish("w1", 30.0);
  const landed3 = await waitFor(() => harvest().length === 2);
  ok(landed3, "跨毫秒两条均已落库");
  const es3 = harvest();
  ok(es3.length === 2 && es3[0].ts < es3[1].ts, "ts 严格递增(30ms 与 31ms 不同): " + (es3[0] && es3[1] && es3[0].ts + " < " + es3[1].ts));
  ok(paths().join() === "/w1,/w2", "跨毫秒仍按发出序排列(完成序倒挂被纠正): " + paths().join());

  // ---- 场景 4(R4-a): 3000 条溢出必须留诊断(此前 while shift 静默丢最旧) ----
  await reset();
  mem["toolbox.harvest"] = {
    v: 1,
    entries: Array.from({ length: 3000 }, (_, i) => ({
      id: "s" + i, method: "GET", url: "https://app.test.com/s" + i, path: "/s" + i, query: "",
      headers: {}, body: "", status: 200, mime: "text/plain", response: "x",
      ts: new RealDate(RealDate.UTC(2020, 0, 1, 0, 0, 0, i)).toISOString(), startTs: i, durationMs: 1,
    })),
  };
  req("n1", 40.0);
  finish("n1", 40.0);
  const landed4a = await waitFor(() => harvest().some((e) => e.path === "/n1"));
  ok(landed4a, "溢出场景: 新条目已入库");
  const logA = ((await msg("getDiagLog")) || {}).log || [];
  const dropMsg = logA.map((e) => String((e && e.message) || "")).filter((m) => m.includes("丢弃最旧"));
  ok(harvest().length === 3000, "溢出后条数仍被夹在上限 3000: " + harvest().length);
  ok(!harvest().some((e) => e.path === "/s0"), "最旧的 /s0 已被裁掉(溢出真实发生)");
  ok(dropMsg.length === 1 && dropMsg[0].includes("丢弃最旧 1 条"), "溢出写了诊断且带丢弃条数: " + JSON.stringify(dropMsg));

  // ---- 场景 5(R4-b): base64 响应体替换占位串时必须带机器可判标记 ----
  await reset();
  global.__respBase64["b1"] = "AAECAwQFBgcICQ==";
  req("b1", 41.0);
  finish("b1", 41.0);
  await waitFor(() => harvest().some((e) => e.path === "/b1"));
  const eb = harvest().find((e) => e.path === "/b1");
  ok(eb && eb.responseBase64 === true, "base64 响应体带 responseBase64 标记: " + JSON.stringify(eb && eb.responseBase64));
  ok(eb && eb.response === "(binary/base64 略)", "占位串保持原样(不改既有展示): " + JSON.stringify(eb && eb.response));
  req("b2", 42.0);
  finish("b2", 42.0);
  await waitFor(() => harvest().some((e) => e.path === "/b2"));
  const et = harvest().find((e) => e.path === "/b2");
  ok(et && !("responseBase64" in et), "文本响应体不带该标记(不误标): " + JSON.stringify(et && et.responseBase64));

  // ---- 场景 7(R5-a): 调试器被分离后状态机必须回 idle, 徽章不再 REC ----
  const beforeDetach = await msg("getRecInfo");
  ok(beforeDetach.recState === "recording", "detach 前 recState = recording: " + beforeDetach.recState);
  fireDetach(123);
  const badgeSettled = await waitFor(() => badgeHistory.length > 0 && badgeHistory[badgeHistory.length - 1] === "");
  const afterDetach = await msg("getRecInfo");
  ok(badgeSettled, "detach 后徽章被清空(不再显示 REC): " + JSON.stringify(badgeHistory));
  ok(afterDetach.recState === "idle", "detach 后 recState 回 idle: " + afterDetach.recState);
  ok(mem["toolbox.recording"] === "idle", "storage 里的录制状态同步为 idle: " + JSON.stringify(mem["toolbox.recording"]));
  ok(
    Array.isArray(mem["toolbox.debugTabs"]) && mem["toolbox.debugTabs"].length === 0,
    "attach 记录已清空: " + JSON.stringify(mem["toolbox.debugTabs"])
  );

  // ---- 场景 6(R4-c): stop 时在途条目要落库并清空 pending ----
  await reset();
  const started = await msg("startRecording", { tabId: 123 }); // 场景 7 已把录制停掉, 重开
  ok(started && started.ok === true, "重开录制成功(为 stop-flush 场景准备): " + JSON.stringify(started));
  req("p1", 50.0); // 只发请求, 不等 loadingFinished
  const pendingNow = async () => (await msg("getRecInfo")).pending;
  let pn = 0;
  const t0 = RealDate.now();
  while (pn !== 1 && RealDate.now() - t0 < 2000) {
    pn = await pendingNow();
    if (pn !== 1) await new Promise((r) => setTimeout(r, 5));
  }
  ok(pn === 1, "在途请求已进 pending: " + pn);
  const stop = await msg("stopRecording");
  ok(stop && stop.ok === true, "stopRecording 返回 ok: " + JSON.stringify(stop));
  const landed6 = await waitFor(() => harvest().some((e) => e.path === "/p1"));
  const ep = harvest().find((e) => e.path === "/p1");
  ok(landed6, "stop 前在途的 /p1 已落库(不再永久蒸发)");
  ok(
    ep && ep.incomplete === true && ep.response === "",
    "落库条目带 incomplete 标记且 response 为空: " + JSON.stringify(ep && { incomplete: ep.incomplete, response: ep.response })
  );
  const pnAfter = await pendingNow();
  ok(pnAfter === 0, "stop 后 pending 已清空(不留死条目): " + pnAfter);

  console.log(fail ? "\n=== 引擎不变式 FAIL: " + fail + " ===" : "\n=== 引擎不变式 PASS (" + pass + " 项) ===");
  process.exit(fail ? 1 : 0);
})();
