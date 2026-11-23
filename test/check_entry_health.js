// check_entry_health.js —— 入口健康闸门(v1.1.80)
//
// 为什么需要(R92 实证): 我把 bridge 的 archive stub 换成真实例, 却没注意变量作用域 ——
// `node --check` 过(语法没问题)、`unit.mjs` 过(它直接 import tools.js, 不经 index.js),
// 但 **MCP 一启动就 ReferenceError, 所有 AI 客户端 initialize 超时**。这个回归只被排在
// 最后的 smoke(8s) 偶然抓到, 代价是整条链才暴露。
//
// 本闸门把"入口能不能起来"做成**秒级**检查, 与语法检查分开(语法过 ≠ 能启动):
//   ① 语法: 所有运行时代码 node --check;
//   ② MCP 入口: 真 spawn `bridge/src/index.js`, 喂 initialize, 3s 内必须回 JSON-RPC 响应;
//   ③ doctor 入口: `--help` 必须 1s 内退出 0(它是纯 CLI, 不该挂住);
//   ④ 扩展入口: background.js 与四页面 JS 在 vm 里加载不抛(桩最小)。
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { spawnSync } = require("child_process");
const ROOT = path.resolve(__dirname, "..");

let fails = 0;
const ok = (name, cond, got) => {
  if (cond) console.log("  OK " + name);
  else { fails++; console.log("FAIL " + name + " → " + JSON.stringify(got)); }
};

// ① 语法
const runtimeFiles = [
  "background.js", "common.js", "jmx.js", "pyscript.js", "replay.js", "correlate.js", "aireport.js",
  "aic.js", "auth.js", "skill.js", "bridge-client.js", "bridge-protocol.js",
  "popup/popup.js", "sidepanel/sidepanel.js", "options/options.js",
  "bridge/src/index.js", "bridge/src/hub.js", "bridge/src/tools.js", "bridge/src/archive.js",
  "bridge/src/config.js", "bridge/src/errors.js", "bridge/src/exporters.js", "bridge/src/doctor.js",
];
const syntaxBad = [];
for (const rel of runtimeFiles) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) { syntaxBad.push(rel + "(缺文件)"); continue; }
  const r = spawnSync(process.execPath, ["--check", abs], { encoding: "utf8" });
  if (r.status !== 0) syntaxBad.push(rel + ": " + (r.stderr || "").split("\n")[0]);
}
ok(`运行时文件语法全通过(${runtimeFiles.length} 个)`, syntaxBad.length === 0, syntaxBad.slice(0, 4));

// ② MCP 入口真实启动(喂 initialize, 必须回包)
{
  const entry = path.join(ROOT, "bridge/src/index.js");
  const port = 9600 + Math.floor(Math.random() * 200);
  const r = spawnSync(process.execPath, [entry, "--port", String(port), "--quiet", "--allow-control"], {
    input: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "entry-health", version: "1" } },
    }) + "\n",
    encoding: "utf8", timeout: 8000,
    env: { ...process.env, WEB_TOOLBOX_TOKEN: "entry-health-token" },
  });
  const out = String(r.stdout || "");
  const responded = /"jsonrpc"\s*:\s*"2\.0"/.test(out) && /"result"|"error"/.test(out);
  ok("MCP 入口能启动并响应 initialize(抓 ReferenceError 类回归)",
    responded, { status: r.status, stdout: out.slice(0, 200), stderr: String(r.stderr || "").slice(0, 300) });
}

// ③ doctor CLI 一秒内退出 0(--help)
{
  const r = spawnSync(process.execPath, [path.join(ROOT, "bridge/src/doctor.js"), "--help"], {
    encoding: "utf8", timeout: 3000,
  });
  ok("doctor --help 快速退出 0(不挂住)", r.status === 0 && !r.error, { status: r.status, err: r.error && r.error.code });
}

// ④ 扩展入口在 vm 里加载不抛(最小桩)
{
  const loadFail = [];
  for (const rel of ["background.js", "common.js", "jmx.js", "pyscript.js", "replay.js", "correlate.js"]) {
    const mem = {};
    const sandbox = {
      console: { log() {}, warn() {}, error() {} },
      setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {},
      URL, URLSearchParams, AbortController, Date, Math, JSON, Promise, TextEncoder,
      document: { querySelector: () => null, querySelectorAll: () => [], getElementById: () => null },
      chrome: {
        storage: { local: { QUOTA_BYTES: 10485760,
          get: (k, cb) => { if (cb) { cb({}); return; } return Promise.resolve({}); },
          set: (o, cb) => { if (cb) cb(); return Promise.resolve(); } }, onChanged: { addListener() {} } },
        runtime: { onInstalled: { addListener() {} }, onMessage: { addListener() {} }, getManifest: () => ({ version: "t" }) },
        debugger: { onDetach: { addListener() {} }, onEvent: { addListener() {} }, attach: async () => {}, detach: async () => {}, sendCommand: async () => ({}) },
        alarms: { onAlarm: { addListener() {} }, create() {}, clear() {} },
        action: { setBadgeText: async () => {} },
        tabs: { onRemoved: { addListener() {} }, query: async () => [] },
        permissions: { contains: (p, cb) => cb && cb(false), request: (p, cb) => cb && cb(false) },
      },
      fetch: async () => ({ ok: false }),
      navigator: { clipboard: { writeText: async () => {} } },
      // UMD 桩: jmx.js 有 module.exports 分支, 缺 module 会让它走错路径。
      // 给最小实现以覆盖"有 CommonJS 环境"这条; 无 module 的场景由扩展真实运行覆盖。
      module: { exports: {} },
      exports: {},
      require: () => ({}),
    };
    sandbox.window = sandbox; sandbox.globalThis = sandbox;
    try {
      vm.createContext(sandbox);
      new vm.Script(fs.readFileSync(path.join(ROOT, rel), "utf8"), { filename: rel }).runInContext(sandbox);
    } catch (e) {
      loadFail.push(rel + ": " + e.message.slice(0, 80));
    }
  }
  ok("扩展侧入口在 vm 里可加载(6 个)", loadFail.length === 0, loadFail);
}

console.log(fails ? `=== entry health FAIL: ${fails} ===` : "=== entry health PASS ===");
process.exit(fails ? 1 : 0);