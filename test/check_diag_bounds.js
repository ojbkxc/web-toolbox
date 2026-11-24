// check_diag_bounds.js —— 诊断日志有界闸门(v1.2.3)
//
// AGENTS §1.7 三个不变量: ①录制全录 ②条目按请求时间序 ③诊断日志有界(1000 条/512KB 仅元信息)。
// R82 补了 ①②(在 check_record_all / check_engine_edge), **③ 此前零闸门** —— 而它恰恰是
// "不让诊断功能自己吃垮扩展"的那道保险: 日志无界 = 长跑后 service worker 内存只涨不落。
//
// 为什么单列而不是塞进 check_record_all: 那边用 `require()` 加载 background.js(Node 模块作用域),
// 而 diagEntries/diagBytes 是 service worker 里的模块级 const, require 后**读不到**;
// 只有 vm.load + runInContext 才能观测内部状态。这里用 vm 环境独立验。
//
// 关键判据: 两个界都要证明**真的会触发** —— 只验"没超"等于允许"界根本没实现"也能绿。
const fs = require("fs");
const vm = require("vm");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");

let fails = 0;
const ok = (name, cond, got) => {
  if (cond) console.log("  OK " + name);
  else { fails++; console.log("FAIL " + name + " → " + JSON.stringify(got)); }
};

function newEnv() {
  const mem = {}; const listeners = {};
  const on = (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); };
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {},
    URL, URLSearchParams, AbortController, Date, Math, JSON, Promise, TextEncoder,
    chrome: {
      storage: { local: { QUOTA_BYTES: 10485760,
        get: (k, cb) => { const o = {}; for (const x of [].concat(k)) if (x in mem) o[x] = mem[x]; if (cb) cb(o); return Promise.resolve(o); },
        set: (o, cb) => { Object.assign(mem, o); if (cb) cb(); return Promise.resolve(); } },
        onChanged: { addListener() {} } },
      runtime: { onInstalled: { addListener: (f) => on("installed", f) },
        onMessage: { addListener: (f) => on("message", f) }, getManifest: () => ({ version: "t" }) },
      debugger: { onDetach: { addListener: (f) => on("detach", f) }, onEvent: { addListener: (f) => on("event", f) },
        attach: async () => {}, detach: async () => {}, sendCommand: async () => ({}) },
      alarms: { onAlarm: { addListener() {} }, create() {}, clear() {} },
      action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
      tabs: { onRemoved: { addListener: (f) => on("removed", f) } },
      permissions: { contains: async () => false },
    },
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  new vm.Script(fs.readFileSync(path.join(ROOT, "background.js"), "utf8"), { filename: "background.js" })
    .runInContext(sandbox);
  return { sandbox, read: (expr) => vm.runInContext(expr, sandbox) };
}

// ---- ① 常量就是承诺值 ----
{
  const { read } = newEnv();
  ok("MAX_DIAG_ENTRIES = 1000", read("MAX_DIAG_ENTRIES") === 1000, read("MAX_DIAG_ENTRIES"));
  ok("MAX_DIAG_BYTES = 512KB", read("MAX_DIAG_BYTES") === 512 * 1024, read("MAX_DIAG_BYTES"));
}

// ---- ② 条数界真的触发(短消息灌 3000 条) ----
{
  const { sandbox, read } = newEnv();
  for (let i = 0; i < 3000; i++) sandbox.diag("warn", "attach", "short" + i);
  const n = read("diagEntries.length");
  ok("灌 3000 条短日志后条数被裁到 1000", n === 1000, n);
  ok("占用字节同步下降(不泄漏)", read("diagBytes") <= 512 * 1024, read("diagBytes"));
}

// ---- ③ 字节界真的触发(长消息下条数会先于 1000 停下) ----
// 每条 message 截到 500 字符, 单条约 550 字节 —— 1000 条会到 ~550KB > 512KB,
// 所以字节界必须先触发, 最终条数应 **小于** 1000。若恒等于 1000, 说明字节界是死代码。
{
  const { sandbox, read } = newEnv();
  for (let i = 0; i < 2000; i++) sandbox.diag("warn", "attach", "L" + String(i).padEnd(497, "x"));
  const n = read("diagEntries.length");
  const bytes = read("diagBytes");
  ok("长消息下字节界先触发(条数 < 1000)", n < 1000 && n > 0, n);
  ok("字节数不超 512KB", bytes <= 512 * 1024, bytes);
}

// ---- ④ 仅元信息: 单条截断 + 字段集固定 ----
{
  const { sandbox, read } = newEnv();
  sandbox.diag("warn", "attach", "x".repeat(100000));   // 单条超长
  const len = read("diagEntries[0].message.length");
  ok("单条 message 截断到 <=500(防单条撑爆)", len <= 500, len);
  const keys = read("Object.keys(diagEntries[0] || {}).sort().join()");
  ok("字段集仅 ts/level/source/message(不含 payload/凭据)", keys === "level,message,source,ts", keys);
}

// ---- ⑤ 诊断自身永不抛(坏输入不能影响主流程) ----
{
  const { sandbox, read } = newEnv();
  let threw = null;
  try {
    sandbox.diag("warn", "attach", undefined);
    sandbox.diag(null, null, null);
    sandbox.diag("warn", "attach", { toString() { throw new Error("boom"); } });
  } catch (e) { threw = e.message; }
  ok("坏输入下 diag 不抛异常(诊断永不影响主流程)", threw === null, threw);
  ok("坏输入仍然入列(不被静默丢弃)", read("diagEntries.length") >= 1, read("diagEntries.length"));
}

// ---- ⑥ 闸门自证: 界确实落在 1000/512KB 这两个位置, 不是恒真也不是别的数 ----
// 做法: 分别灌 999 条与 1001 条 —— 前者不该被裁, 后者恰好裁到 1000。
// (不能改 const 常量来测试, 那是 TypeError; 用"刚好跨过界"两侧的样本更有说服力)
{
  const { sandbox: sb1, read: rd1 } = newEnv();
  for (let i = 0; i < 999; i++) sb1.diag("warn", "attach", "u" + i);
  ok("闸门自证: 灌 999 条时不被裁(界确实在 1000 而非更低)", rd1("diagEntries.length") === 999, rd1("diagEntries.length"));

  const { sandbox: sb2, read: rd2 } = newEnv();
  for (let i = 0; i < 1001; i++) sb2.diag("warn", "attach", "v" + i);
  ok("闸门自证: 灌 1001 条时恰好裁到 1000(界确实生效)", rd2("diagEntries.length") === 1000, rd2("diagEntries.length"));

  // 裁剪是 FIFO(留最新的): 首条应是第 1 条(v1 已被挤掉)
  const firstMsg = rd2("diagEntries[0].message");
  ok("闸门自证: 裁剪是 FIFO(留最新, 首条不是 v0)", firstMsg !== "v0", firstMsg);
}

console.log(fails ? `\n=== diag bounds FAIL: ${fails} ===` : "\n=== diag bounds PASS ===");
process.exit(fails ? 1 : 0);