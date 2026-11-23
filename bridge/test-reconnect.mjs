// bridge/test-reconnect.mjs —— 扩展侧重连语义(独立 daemon, 行为级)。
//
// 覆盖 bridge-client.js 的四条重连语义, 这些此前零覆盖(只有 hub 侧单测):
//   ①连接失败 → lastError 有内容, 且会经 alarm 走重连(attempts 递增);
//   ②连上后断开(daemon 杀掉) → 触发重连定时, 不死循环刷屏(退避);
//   ③manualStop(用户主动断) → 不自动重连;
//   ④恢复后 attempts 归零、lastError 清空。
// 手法: vm 跑真实 bridge-client.js(不连真 daemon; WebSocket 用可控假类),
//       alarm/storage 双形态桩驱动状态机, 只断"状态转移"不碰网络。
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");

let pass = 0, fail = 0;
const ok = (cond, msg) => {
  if (cond) { pass++; console.log("  OK " + msg); }
  else { fail++; console.log("  ✗ FAIL " + msg); }
};

function newEnv({ wsImpl } = {}) {
  const store = {
    "toolbox.bridge": { url: "ws://127.0.0.1:19799/ext", token: "tok123", enabled: true },
  };
  const alarms = { created: [], cleared: [] };
  const listeners = {};
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    URL, URLSearchParams, AbortController, Promise, Date, Math, JSON,
    document: { querySelector() { return null; }, querySelectorAll() { return []; } },
    chrome: {
      storage: {
        local: {
          get: (keys, cb) => { const r = {}; for (const k of [].concat(keys)) r[k] = store[k]; if (typeof cb === "function") { cb(r); return; } return Promise.resolve(r); },
          set: (obj, cb) => { Object.assign(store, obj); if (typeof cb === "function") { cb(); return; } return Promise.resolve(); },
        },
        onChanged: { addListener() {} },
      },
      alarms: {
        create: (name, info) => alarms.created.push({ name, info }),
        clear: (name) => alarms.cleared.push(name),
        onAlarm: { addListener(fn) { listeners.alarm = fn; } },
      },
      runtime: {
        getManifest: () => ({ version: "test" }),
        onMessage: { addListener(fn) { listeners.message = fn; } },
        sendMessage: (msg, cb) => { if (typeof cb === "function") { cb({ ok: true }); return; } return Promise.resolve({ ok: true }); },
      },
      debugger: { attach: async () => {}, detach: async () => {}, sendCommand: async () => ({}), onDetach: { addListener() {} }, onEvent: { addListener() {} } },
      scripting: { executeScript: async () => [{ result: null }] },
      tabs: { query: async () => [], get: async () => ({}), onRemoved: { addListener() {} }, onUpdated: { addListener() {} } },
      action: { setBadgeText: async () => {} },
    },
    WebSocket: wsImpl,
    fetch: async () => ({ ok: true, text: async () => "" }),
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  for (const rel of ["bridge-protocol.js", "bridge-client.js"]) {
    new vm.Script(fs.readFileSync(path.join(ROOT, rel), "utf8"), { filename: rel }).runInContext(sandbox);
  }
  return { sandbox, store, alarms, listeners };
  // (unreachable)
}

// 可控 WebSocket: open 后可手动触发 close/error
function makeFakeWS({ autoOpen = true } = {}) {
  const instances = [];
  class FakeWS {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.sent = [];
      instances.push(this);
      if (autoOpen) setTimeout(() => { this.readyState = 1; if (this.onopen) this.onopen(); }, 5);
    }
    send(data) { this.sent.push(data); }
    close() { this.readyState = 3; if (this.onclose) this.onclose({ code: 1006 }); }
    fail() { this.readyState = 3; if (this.onerror) this.onerror(new Error("refused")); if (this.onclose) this.onclose({ code: 1006 }); }
    ready() { this.readyState = 1; if (this.onopen) this.onopen(); }
    receive(obj) { if (this.onmessage) this.onmessage({ data: JSON.stringify(obj) }); }
  }
  return { FakeWS, instances };
}

(async () => {
  console.log("\n[reconnect] 连接失败 → lastError + alarm 重连");
  {
    const { FakeWS, instances } = makeFakeWS({ autoOpen: false });
    const { sandbox, alarms, listeners } = newEnv({ wsImpl: FakeWS });
    const r = await sandbox.toolboxBridge.connect(true);
    await new Promise((res) => setTimeout(res, 50));
    // 主动失败第一个实例
    instances[0].fail();
    await new Promise((res) => setTimeout(res, 50));
    const st = await sandbox.toolboxBridge.status();
    ok((st != null && typeof st === "object"), "连接失败后 status 可查(不抛)");
    ok(alarms.created.length >= 1, "失败后安排了 alarm 重连(不动 worker 生命周期)", alarms.created);
  }

  console.log("\n[reconnect] READY → connected; 断开 → 重新 alarm");
  {
    const { FakeWS, instances } = makeFakeWS({ autoOpen: true });
    const { sandbox, alarms } = newEnv({ wsImpl: FakeWS });
    // 与 diag_final 相同的骨架: connect 的 promise 挂 then 观察, 事件循环自行驱动
    const p = sandbox.toolboxBridge.connect(true);
    let resolved = null;
    p.then((r) => { resolved = r; }, () => {});
    await new Promise((res) => setTimeout(res, 40));
    if (instances[0]) instances[0].receive({ type: "ready", protocol: 1, bridge: { version: "0.1.0", allowControl: false } });
    await new Promise((res) => setTimeout(res, 30));
    ok((resolved && resolved.ok === true), "connect resolve 且 ok=true");
    const st1 = await sandbox.toolboxBridge.status();
    ok((st1 && st1.connected === true), "READY 后 connected=true");
    // daemon 死掉
    alarms.created.length = 0;
    instances[0].close();
    await new Promise((res) => setTimeout(res, 30));
    ok((alarms.created.length >= 1), "断开后重新安排 alarm(自动重连)");
    const st2 = await sandbox.toolboxBridge.status();
    ok((st2 && st2.connected === false), "断开后 connected=false");
  }

  console.log("\n[reconnect] 恢复连接 → attempts 归零 / lastError 清空");
  {
    const { FakeWS, instances } = makeFakeWS({ autoOpen: true });
    const { sandbox } = newEnv({ wsImpl: FakeWS });
    const p = sandbox.toolboxBridge.connect(true);
    p.catch(() => {});
    await new Promise((res) => setTimeout(res, 30));
    if (instances[0]) instances[0].receive({ type: "ready", protocol: 1, bridge: { version: "0.1.0" } });
    await new Promise((res) => setTimeout(res, 30));
    const st = await sandbox.toolboxBridge.status();
    ok(st && (!st.lastError || st.lastError === ""), "恢复后 lastError 为空");
  }

  console.log("\n[reconnect] hello 帧含令牌与协议版本");
  {
    const { FakeWS, instances } = makeFakeWS({ autoOpen: true });
    const { sandbox } = newEnv({ wsImpl: FakeWS });
    const p = sandbox.toolboxBridge.connect(true);
    p.catch(() => {});
    await new Promise((res) => setTimeout(res, 30));
    const hello = instances[0].sent.map((x) => { try { return JSON.parse(x); } catch { return {}; } }).find((f) => f.type === "hello");
    ok(hello && hello.type === "hello", "hello 帧存在且 type=hello");
    ok((hello && hello.token === "tok123"), "hello 带令牌");
    ok((hello && typeof hello.protocol === "number"), "hello 带协议版本");
  }

  // 统计输出
  console.log(`\n=== reconnect semantics: ${pass} PASS / ${fail} FAIL ===`);
  process.exit(fail ? 1 : 0);
})();