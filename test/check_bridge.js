// check_bridge.js —— AI 桥接层走查(静态契约 + 协议一致性 + 只读约束)。
//
// 为什么不在这里起真实 WebSocket: bridge/ 有自己的端到端自检(bridge/smoke.mjs),
// 那条链路需要 npm 依赖 + 真实端口, 不能进"零依赖 node 回归"。本文件守的是
// 扩展仓库这边的红线:
//   1. 协议常量两边一致(扩展 / bridge 共用 bridge-protocol.js)
//   2. bridgeDispatch 的分支与协议白名单严格对应(不出现"白名单有、dispatch 没有")
//   3. 桥接层不写 toolbox.harvest(录制不变量)
//   4. background.js 的消息处理器是具名函数(MV3 自调用限制的绕法)
//   5. 桥接层加载失败不影响录制(importScripts 有 try/catch)
const fs = require("fs");
const vm = require("vm");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const assert = (cond, msg) => {
  if (!cond) { console.log("FAIL: " + msg); process.exit(1); }
  console.log("  OK " + msg);
};

const proto = require(ROOT + "/bridge-protocol.js");
const bgSrc = fs.readFileSync(ROOT + "/background.js", "utf8");
const clientSrc = fs.readFileSync(ROOT + "/bridge-client.js", "utf8");

// ================= ① 协议结构 =================
assert(typeof proto.PROTOCOL_VERSION === "number" && proto.PROTOCOL_VERSION > 0, "协议有版本号");
assert(typeof proto.WS_PATH === "string" && proto.WS_PATH.startsWith("/"), "WS 路径以 / 开头");
assert(proto.FRAME && proto.FRAME.HELLO && proto.FRAME.READY && proto.FRAME.REQ && proto.FRAME.RES,
  "帧类型齐全(hello/ready/req/res)");
assert(Array.isArray(proto.READ_METHODS) && proto.READ_METHODS.length > 0, "只读方法白名单非空");
assert(Array.isArray(proto.CONTROL_METHODS) && proto.CONTROL_METHODS.length > 0, "控制方法白名单非空");
assert(proto.isReadMethod("net.list") === true, "isReadMethod 识别 net.list");
assert(proto.isControlMethod("page.click") === true, "isControlMethod 识别 page.click");
assert(proto.isReadMethod("page.click") === false, "控制方法不算只读");
assert(proto.isControlMethod("net.list") === false, "只读方法不算控制");

// 两个白名单不能有交集(否则权限判定会自相矛盾)
const overlap = proto.READ_METHODS.filter((m) => proto.CONTROL_METHODS.includes(m));
assert(overlap.length === 0, "只读/控制白名单无交集: " + JSON.stringify(overlap));

// ================= ② dispatch 分支与白名单一一对应 =================
// 从 bridge-client.js 里抠出 case "xxx": 分支名
const dispatchCases = [...clientSrc.matchAll(/case\s+"([\w.]+)":/g)].map((m) => m[1]);
assert(dispatchCases.length > 0, "bridgeDispatch 有分支");

// 白名单里的每个方法都必须有分支(否则 bridge 发过去会"未知方法")
for (const m of [...proto.READ_METHODS, ...proto.CONTROL_METHODS]) {
  assert(dispatchCases.includes(m), `白名单方法 ${m} 在 bridgeDispatch 有对应分支`);
}

// 反向: dispatch 里出现的"业务方法"都必须在白名单里(防止偷偷加未登记能力)
// 例外: 导出/关联由 bridge 侧计算, 扩展显式抛错引导, 不算可执行分支
const SIDE_COMPUTED = ["export.har", "export.jmx", "export.python", "correlate.analyze"];
const known = new Set([...proto.READ_METHODS, ...proto.CONTROL_METHODS, ...SIDE_COMPUTED]);
for (const c of dispatchCases) {
  assert(known.has(c), `bridgeDispatch 分支 ${c} 已在协议里登记`);
}

// 导出/关联必须由 bridge 侧算, 且扩展侧要明确拒绝(而不是返回错误结果)
for (const m of SIDE_COMPUTED) {
  assert(dispatchCases.includes(m), `${m} 有显式分支`);
  const idx = clientSrc.indexOf(`case "${m}"`);
  const seg = clientSrc.slice(idx, idx + 400);
  assert(/throw new Error/.test(seg), `${m} 在扩展侧明确抛错(引导到 bridge 侧计算)`);
}

// ================= ③ 录制不变量: 桥接层不得写 harvest =================
assert(!/storage\.local\.set\([^)]*toolbox\.harvest/.test(clientSrc),
  "bridge-client 不写 toolbox.harvest(录制不变量)");
assert(!/\["toolbox\.harvest"\]\s*:/.test(clientSrc), "bridge-client 不构造 harvest 写入对象");

// 读取是允许的
assert(clientSrc.includes("toolbox.harvest"), "bridge-client 读取 harvest(net.list)");

// ================= ④ background.js 的消息处理器具名化 =================
assert(bgSrc.includes("function toolboxHandleMessage(msg, sendResponse)"),
  "background.js 消息处理器是具名函数(service worker 自调用限制的绕法)");
assert(/chrome\.runtime\.onMessage\.addListener\(\(msg, _sender, sendResponse\) => toolboxHandleMessage\(msg, sendResponse\)\)/.test(bgSrc),
  "onMessage 委托给 toolboxHandleMessage");
// 原来的匿名回调形态必须消失(否则两套逻辑并存)
assert(!/chrome\.runtime\.onMessage\.addListener\(\(msg, _sender, sendResponse\) => \{\s*\n\s*if \(msg && msg\.type === "getDomains"\)/.test(bgSrc),
  "旧的匿名回调已移除(不留两套逻辑)");

// ================= ⑤ 桥接加载失败不拖垮录制 =================
assert(/try\s*\{\s*\n\s*importScripts\("bridge-protocol\.js", "bridge-client\.js"\)/.test(bgSrc),
  "importScripts 包在 try 里(桥接挂了录制照常)");

// 加载顺序: 协议必须在客户端之前(客户端引用全局 BRIDGE)
const scripts = bgSrc.match(/importScripts\(([^)]*)\)/);
assert(scripts, "找到 importScripts 调用");
const order = scripts[1];
assert(order.indexOf("bridge-protocol.js") < order.indexOf("bridge-client.js"),
  "先加载协议再加载客户端");

// ================= ⑥ 扩展侧不重复声明 common.js 的全局 =================
// common.js 与 background.js 同处 service worker 全局域, 若 bridge-client.js
// importScripts 了 common.js 会因 KEY_DOMAINS 等重复声明直接 SyntaxError。
assert(!/importScripts\([^)]*common\.js/.test(bgSrc),
  "不在 service worker 里 importScripts common.js(KEY_DOMAINS 会撞名)");
assert(!/importScripts\([^)]*jmx\.js/.test(bgSrc), "不在 service worker 里 importScripts jmx.js");
// 导出改由 bridge(Node)侧 require 同一份源码
const exporterSrc = fs.readFileSync(ROOT + "/bridge/src/exporters.js", "utf8");
for (const f of ["common.js", "jmx.js", "pyscript.js", "correlate.js", "auth.js"]) {
  assert(exporterSrc.includes(`load("${f}")`), `bridge 侧复用扩展的 ${f}`);
}

// ================= ⑦ 鉴权与安全 =================
assert(clientSrc.includes("token: cfg.token"), "hello 帧带令牌");
assert(/chrome\.storage\.local\.get\(\[BRIDGE_KEY_CFG\]\)/.test(clientSrc), "令牌从 storage 读, 不硬编码");
assert(!/token\s*=\s*["'][a-f0-9]{16,}["']/.test(clientSrc), "源码里没有硬编码令牌");
// 控制类必须在服务端二次判定(bridge 的 hub 已经做了, 这里确认工具层也有守卫)
const toolsSrc = fs.readFileSync(ROOT + "/bridge/src/tools.js", "utf8");
assert(/if \(!ctx\.allowControl\)/.test(toolsSrc), "工具层有 allowControl 守卫");
assert(/startBridge|--allow-control/.test(fs.readFileSync(ROOT + "/bridge/src/index.js", "utf8")),
  "bridge 启动参数支持 --allow-control");

// ================= ⑧ ref 交互不依赖坐标(LLM 可用性) =================
assert(/data-ai-ref/.test(clientSrc), "快照用 data-ai-ref 打标记");
assert(/\^e\\d\+\$/.test(clientSrc), "ref 格式有校验(防注入选择器)");
assert(/Input\.dispatchMouseEvent/.test(clientSrc), "点击走 CDP 真实鼠标事件");
assert(/Input\.insertText/.test(clientSrc), "输入走 CDP insertText(受控组件能接住)");

// ================= ⑨ options 页有桥接配置区 =================
const optHtml = fs.readFileSync(ROOT + "/options/options.html", "utf8");
const optJs = fs.readFileSync(ROOT + "/options/options.js", "utf8");
for (const id of ["bridgeUrl", "bridgeToken", "bridgeEnabled", "saveBridge", "connectBridge"]) {
  assert(optHtml.includes(`id="${id}"`), `options.html 有 #${id}`);
}
assert(optJs.includes("toolbox.bridge"), "options.js 写入 toolbox.bridge 配置 key");
assert(/testBridge|loadBridgeConfig/.test(optJs), "options.js 有连接测试与配置加载");

// ================= ⑩ mv3 生命周期: 重连用 alarm 不用 setTimeout =================
assert(/chrome\.alarms\.create\(BRIDGE_ALARM/.test(clientSrc), "断线重连用 alarm(worker 休眠后仍会触发)");
assert(/chrome\.alarms\.onAlarm\.addListener/.test(clientSrc), "监听 alarm 触发重连");
assert(/window\.setTimeout|setTimeout\(.*reconnect/i.test(clientSrc) === false,
  "不用 setTimeout 做重连(worker 休眠即失效)");

// ================= ⑪ 配置页冒烟(vm 跑真实 options.js) =================
{
  const elements = new Map();
  const mkEl = (id) => {
    if (elements.has(id)) return elements.get(id);
    const el = {
      id, style: {}, dataset: {}, value: "", textContent: "", innerHTML: "",
      className: "", checked: true, disabled: false, placeholder: "",
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      addEventListener() {}, setAttribute() {}, appendChild() {}, insertBefore() {},
      querySelector() { return mkEl(id + "_q"); }, querySelectorAll() { return []; },
      focus() {}, onclick: null,
    };
    elements.set(id, el);
    return el;
  };
  const store = new Map();
  const sandbox = {
    console, setTimeout, clearTimeout, clearInterval() {}, URL, URLSearchParams, AbortController,
    navigator: { clipboard: { writeText: async () => {} } },
    document: {
      getElementById: (id) => mkEl(id),
      createElement: (t) => { const e = mkEl("el_" + Math.random()); e.tag = t; return e; },
      createDocumentFragment: () => mkEl("f"),
      querySelectorAll: () => [], body: mkEl("body"),
    },
    chrome: {
      storage: {
        local: {
          get: (keys, cb) => {
            const r = {};
            for (const k of [].concat(keys)) r[k] = store.get(k);
            if (typeof cb === "function") setTimeout(() => cb(r), 0);
            return Promise.resolve(r);
          },
          set: (obj, cb) => { for (const k in obj) store.set(k, obj[k]); cb && setTimeout(cb, 0); return Promise.resolve(); },
          remove: (keys, cb) => { for (const k of [].concat(keys)) store.delete(k); cb && setTimeout(cb, 0); return Promise.resolve(); },
        },
        onChanged: { addListener() {} },
      },
      runtime: { openOptionsPage() {}, sendMessage: async () => ({ connected: false, lastError: "test" }) },
      permissions: { contains: (p, cb) => cb(false), request: (p, cb) => cb(false), remove: (p, cb) => cb(false) },
    },
    fetch: async () => { throw new Error("nf"); },
    performance: { now: () => Date.now() },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const rel of ["../common.js", "options.js"]) {
    const abs = path.resolve(ROOT + "/options", rel);
    new vm.Script(fs.readFileSync(abs, "utf8"), { filename: abs }).runInContext(sandbox);
  }
  assert(typeof sandbox.saveBridgeConfig === "function", "options.js 暴露 saveBridgeConfig");
  assert(typeof sandbox.testBridge === "function", "options.js 暴露 testBridge");

  // 保存非法地址应被拒
  mkEl("bridgeUrl").value = "http://not-a-ws";
  mkEl("bridgeToken").value = "tk";
  sandbox.saveBridgeConfig();
  assert(!store.get("toolbox.bridge"), "非法地址不写入配置");

  // 保存合法地址应写入
  mkEl("bridgeUrl").value = "ws://127.0.0.1:9280/ext";
  mkEl("bridgeToken").value = "abc123";
  mkEl("bridgeEnabled").checked = true;
  sandbox.saveBridgeConfig();
  assert(store.get("toolbox.bridge") &&
    store.get("toolbox.bridge").url === "ws://127.0.0.1:9280/ext" &&
    store.get("toolbox.bridge").token === "abc123",
    "合法地址与令牌写入 toolbox.bridge");
}

console.log("");
console.log("=== AI 桥接走查 PASS ===");
process.exit(0);
