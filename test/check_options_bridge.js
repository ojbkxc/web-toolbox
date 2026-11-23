// check_options_bridge.js —— 选项页「AI 桥接」区行为级走查(v1.1.52)
//
// 桥接连接是"用户填一次然后就不管"的配置面; 它坏了用户只会觉得"AI 连不上", 很难定位是
// 扩展侧还是 bridge 侧。此前只有 check_options_page 管域名/LLM 两区, **桥接区零行为断言**:
//   ①非法地址(ws:// 前缀校验)②空令牌保存提示 ③bridgeStatus 的成功/失败分流文案。
// 手法: vm 跑真实 options.js + 双形态 storage/permissions 桩(R60 教训), 逐手势断言。
const fs = require("fs");
const vm = require("vm");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");

let fails = 0;
const ok = (name, cond, got) => {
  if (cond) console.log("  OK " + name);
  else { fails++; console.log("FAIL " + name + " → " + JSON.stringify(got)); }
};

function newEnv({ bridgeReply, stored } = {}) {
  const els = new Map();
  const mk = (id) => {
    const el = {
      id, style: {}, dataset: {}, children: [], value: "", textContent: "", innerHTML: "",
      className: "", checked: true, disabled: false, placeholder: "", type: "",
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      addEventListener() {}, setAttribute() {}, appendChild() {}, insertBefore() {},
      querySelector() { return null; }, querySelectorAll() { return []; }, focus() {},
    };
    els.set(id, el);
    return el;
  };
  const store = {
    "toolbox.domains": [],
    "toolbox.llm": { url: "", model: "", api_key: "" },
    "toolbox.bridge": stored || { url: "ws://127.0.0.1:9280/ext", token: "abc", enabled: true },
  };
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    URL, URLSearchParams, AbortController, Promise, Date,
    document: { getElementById: mk, createElement: () => mk("tmp"), querySelectorAll: () => [], body: mk("body") },
    chrome: {
      runtime: {
        // 双形态: (msg, cb) 回调式为主
        // 双形态: getDomains 回调式; bridgeStatus 是 await 式(无 cb 返回 promise)
        sendMessage: (msg, cb) => {
          if (msg && msg.type === "getDomains" && typeof cb === "function") { cb({ domains: store["toolbox.domains"] }); return; }
          if (msg && msg.type === "bridgeStatus") {
            if (typeof cb === "function") { cb(bridgeReply); return; }
            return Promise.resolve(bridgeReply);
          }
          if (typeof cb === "function") { cb({ ok: true }); return; }
          return Promise.resolve({ ok: true });
        },
        onMessage: { addListener() {} }, openOptionsPage() {},
        getManifest: () => ({ version: "test" }),
      },
      storage: {
        local: {
          get: (keys, cb) => { const r = {}; for (const k of [].concat(keys)) r[k] = store[k]; if (typeof cb === "function") { cb(r); return; } return Promise.resolve(r); },
          set: (obj, cb) => { Object.assign(store, obj); if (typeof cb === "function") { cb(); return; } return Promise.resolve(); },
          remove: (keys, cb) => { for (const k of [].concat(keys)) delete store[k]; if (typeof cb === "function") { cb(); return; } return Promise.resolve(); },
        },
        onChanged: { addListener() {} },
      },
      permissions: {
        contains: (p, cb) => cb(true),
        request: (p, cb) => cb(true),
        remove: (p, cb) => cb(true),
      },
    },
    navigator: { clipboard: { writeText: async () => {} } },
    fetch: async () => { throw new Error("nf"); },
    performance: { now: () => Date.now() },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const rel of ["common.js", "options/options.js"]) {
    new vm.Script(fs.readFileSync(path.join(ROOT, rel), "utf8"), { filename: rel }).runInContext(sandbox);
  }
  return { sandbox, els, store };
}

(async () => {
  const settle = () => new Promise((r) => setTimeout(r, 40));

  // ① 非法地址与空令牌走 saveBridgeConfig(页面全局函数, vm 加载时可直调)
  {
    const env = newEnv({ bridgeReply: { connected: true } });
    await settle();
    // ① 非法
    env.els.get("bridgeUrl").value = "http://bad";
    const ok1 = await env.sandbox.saveBridgeConfig();
    ok("非法前缀 → false 且提示 must 以 ws 开头", ok1 === false && /ws:\/\//.test(env.els.get("bridgeMsg").textContent),
      { ret: ok1, msg: env.els.get("bridgeMsg").textContent });
    // ② 合法 + 空令牌
    env.els.get("bridgeUrl").value = "ws://127.0.0.1:9280/ext";
    env.els.get("bridgeToken").value = "";
    const ok2 = await env.sandbox.saveBridgeConfig();
    ok("空令牌 → 保存成功但明示'未填令牌不会连接'",
      ok2 === true && /未填令牌/.test(env.els.get("bridgeMsg").textContent),
      env.els.get("bridgeMsg").textContent);
    ok("空令牌落库 enabled 语义保留", ((await new Promise((r) => { env.sandbox.chrome.storage.local.get(["toolbox.bridge"], (x) => r(x["toolbox.bridge"])); })) || {}).token === "",
      "n/a");
    // ③ 合法 + 有令牌
    env.els.get("bridgeToken").value = "tok123";
    await env.sandbox.saveBridgeConfig();
    ok("有令牌 → ✓已保存", /✓ 已保存/.test(env.els.get("bridgeMsg").textContent), env.els.get("bridgeMsg").textContent);
  }

  // ④ bridgeStatus 成功 / 失败分流
  {
    const env = newEnv({ bridgeReply: { connected: true } });
    await settle();
    env.els.get("bridgeUrl").value = "ws://127.0.0.1:9280/ext";
    env.els.get("bridgeToken").value = "tok";
    await env.sandbox.testBridge();
    await settle();
    ok("bridgeStatus connected → ✓ 已连接", /✓ 已连接/.test(env.els.get("bridgeMsg").textContent),
      env.els.get("bridgeMsg").textContent);
  }
  {
    const env = newEnv({ bridgeReply: { connected: false, lastError: "connect ECONNREFUSED" } });
    await settle();
    env.els.get("bridgeUrl").value = "ws://127.0.0.1:9280/ext";
    env.els.get("bridgeToken").value = "tok";
    await env.sandbox.testBridge();
    await settle();
    ok("bridgeStatus 失败 → 透出 lastError", /ECONNREFUSED/.test(env.els.get("bridgeMsg").textContent),
      env.els.get("bridgeMsg").textContent);
    ok("失败文案不是干巴巴的'未连接'(引导启动 bridge)", /bridge|启动/.test(env.els.get("bridgeMsg").textContent) || /ECONNREFUSED/.test(env.els.get("bridgeMsg").textContent),
      env.els.get("bridgeMsg").textContent);
  }
  {
    // bridgeStatus 抛错(极端) → 不静默
    const env = newEnv({ bridgeReply: null });
    env.sandbox.chrome.runtime.sendMessage = (msg, cb) => { if (typeof cb === "function") cb(undefined); return Promise.resolve(undefined); };
    await settle();
    env.els.get("bridgeUrl").value = "ws://127.0.0.1:9280/ext";
    env.els.get("bridgeToken").value = "tok";
    await env.sandbox.testBridge();
    await settle();
    ok("bridgeStatus 无响应 → 给出指引(不静默空串)", env.els.get("bridgeMsg").textContent.trim().length > 0,
      JSON.stringify(env.els.get("bridgeMsg").textContent));
  }

  // ⑤ 加载已存配置回填输入框
  {
    const env = newEnv({ stored: { url: "ws://10.0.0.1:9999/x", token: "tokX", enabled: false } });
    await settle();
    ok("已存配置回填 url/token", env.els.get("bridgeUrl").value === "ws://10.0.0.1:9999/x" && env.els.get("bridgeToken").value === "tokX",
      { url: env.els.get("bridgeUrl").value, tok: env.els.get("bridgeToken").value });
    ok("enabled=false 回填复选框", env.els.get("bridgeEnabled").checked === false, env.els.get("bridgeEnabled").checked);
  }

  console.log(fails ? `=== options bridge FAIL: ${fails} ===` : "=== options bridge PASS ===");
  process.exit(fails ? 1 : 0);
})();