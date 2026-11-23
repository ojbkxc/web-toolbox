// check_bridge_attach.js —— 桥接的 debugger attach 借用语义(v1.1.35)
//
// 核心不变量(此前只有代码注释, 没有断言): **桥接绝不把录制引擎的 attach 踢掉**。
// 同一 tab 只能有一个 debugger attach; 录制引擎可能正 attach 着它。桥接的做法是
//   ① attach 抛 "Another debugger is already attached" → 视为借用, ensure 返回 false;
//   ② 只在自己 attach 成功时才 detach(否则会把录制引擎踹下来, 用户看到"录制中却什么都没录到");
//   ③ detach 前必须先挂 globalThis.toolboxBridgeOwnDetach, 否则 background.js 的 onDetach
//      监听会无条件清掉 attach 记录 + pending。
// 手法: vm 里跑真实 bridge-client.js, chrome.debugger 全 stub 并记录 attach/detach 次数。
const fs = require("fs");
const vm = require("vm");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");

let pass = 0, fail = 0;
const ok = (name, cond, got) => {
  if (cond) { pass++; console.log("  OK " + name); }
  else { fail++; console.log("  FAIL " + name + " → " + JSON.stringify(got)); }
};

function newEnv({ attachImpl, detachImpl } = {}) {
  const calls = { attach: 0, detach: 0, detachWhileFlagged: 0 };
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    URL, URLSearchParams, AbortController,
    document: { querySelector() { return null; }, querySelectorAll() { return []; }, createRange() { return { selectNodeContents() {} }; } },
    getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
    chrome: {
      storage: { local: { get: async () => ({}), set: async () => {} }, onChanged: { addListener() {} } },
      alarms: { create() {}, clear() {}, onAlarm: { addListener() {} } },
      tabs: { query: async () => [], update: async () => {}, get: async () => ({ id: 1 }), remove: async () => {} },
      windows: { update: async () => {} },
      runtime: { getManifest: () => ({ version: "1.1.35" }) },
      scripting: { executeScript: async () => [{ result: null }] },
      debugger: {
        attach: async () => {
          calls.attach++;
          if (attachImpl) return attachImpl();
        },
        detach: async () => {
          calls.detach++;
          // detach 期间必须已经挂上"桥接自己发的"标记
          if (sandbox.globalThis.toolboxBridgeOwnDetach && sandbox.globalThis.toolboxBridgeOwnDetach.has(1)) {
            calls.detachWhileFlagged++;
          }
          if (detachImpl) return detachImpl();
        },
        sendCommand: async (_t, method) => {
          if (method === "Page.captureScreenshot") return { data: "AAAA" };
          return {};
        },
      },
    },
    WebSocket: class { constructor() { throw new Error("走查环境不连 WebSocket"); } },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const rel of ["bridge-protocol.js", "bridge-client.js"]) {
    const abs = path.join(ROOT, rel);
    new vm.Script(fs.readFileSync(abs, "utf8"), { filename: abs }).runInContext(sandbox);
  }
  return { sandbox, calls };
}

(async () => {
  // ① 自己 attach 成功 → 用完 detach 一次, 且 detach 时已挂标记
  {
    const { sandbox, calls } = newEnv();
    const r = await sandbox.toolboxBridge.dispatch("page.screenshot", { tabId: 1 });
    ok("自己 attach 成功: 截图返回 dataUrl", r && r.ok !== false && !!r.dataUrl, r);
    ok("自己 attach → attach 调 1 次", calls.attach === 1, calls);
    ok("自己 attach → detach 调 1 次(用完就还)", calls.detach === 1, calls);
    ok("detach 时已挂 toolboxBridgeOwnDetach 标记", calls.detachWhileFlagged === 1, calls);
  }

  // ② 录制引擎已 attach → 借用, **绝不能 detach**
  {
    const { sandbox, calls } = newEnv({
      attachImpl: () => { throw new Error("Another debugger is already attached to the tab with id: 1"); },
    });
    const r = await sandbox.toolboxBridge.dispatch("page.screenshot", { tabId: 1 });
    ok("借用模式: 功能仍可用(截图成功)", r && r.ok !== false && !!r.dataUrl, r);
    ok("借用模式: attach 尝试 1 次", calls.attach === 1, calls);
    ok("借用模式: detach 0 次(不踢录制引擎)", calls.detach === 0, calls);
  }

  // ③ 其它 attach 错误(如 tab 不存在) → 抛出而不是静默借用
  //    注意: 这条路径是 **throw**(不是 {ok:false}) —— MCP 工具层由 run()/fromException 兜住,
  //    侧栏走 pageDispatch 的包装(见 check_page_tab c6); 这里钉住"绝不静默"这一点。
  {
    const { sandbox, calls } = newEnv({
      attachImpl: () => { throw new Error("No tab with given id 999"); },
    });
    let err = null;
    try { await sandbox.toolboxBridge.dispatch("page.screenshot", { tabId: 999 }); } catch (e) { err = e; }
    ok("其它 attach 错误 → 抛出且指明原因", !!err && /无法连接调试器/.test(String(err.message)), err && err.message);
    ok("其它 attach 错误 → 不 detach", calls.detach === 0, calls);
  }

  // ④ detach 本身失败(已被别处 detach) → 不抛错, 功能不受影响
  {
    const { sandbox, calls } = newEnv({
      detachImpl: () => { throw new Error("Debugger is not attached to the tab with id: 1"); },
    });
    const r = await sandbox.toolboxBridge.dispatch("page.screenshot", { tabId: 1 });
    ok("detach 抛错不影响结果", r && r.ok !== false && !!r.dataUrl, r);
    ok("detach 仍被尝试 1 次", calls.detach === 1, calls);
  }

  // ⑤ 标记会延时摘除(给 background.js 的 onDetach 留时间), 不是立刻删
  {
    const { sandbox } = newEnv();
    await sandbox.toolboxBridge.dispatch("page.screenshot", { tabId: 1 });
    ok("detach 后标记仍在(等 onDetach 跑完)", sandbox.globalThis.toolboxBridgeOwnDetach.has(1), "已立刻清掉");
    await new Promise((r) => setTimeout(r, 1200));
    ok("1s 后标记自动摘除", !sandbox.globalThis.toolboxBridgeOwnDetach.has(1), "标记残留");
  }

  console.log(fail ? `=== bridge attach FAIL: ${fail} ===` : "=== bridge attach PASS ===");
  process.exit(fail ? 1 : 0);
})();
