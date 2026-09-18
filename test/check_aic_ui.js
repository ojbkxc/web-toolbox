// check_aic_ui.js —— AI 链 UI 行为回归(vm realm):
//   1. 已有链时点「🔗 建链」→ 直接 renderChainPreview, 不烧 LLM(callLlm 不被调)
//   2. renderChainPreview 的清除按钮 → aiChain 清空 + storage remove
//   3. applyAiChainToJmx 走通 sidepanel JMX 导出路径(buildJmx 内 _extractors 生成 JSONPostProcessor)
//   4. skill「chain」路径建链后同样打 id 快照
const fs = require("fs");
const ROOT = require('path').resolve(__dirname, '..');
const vm = require("vm");
const path = require("path");

const html = fs.readFileSync(ROOT + "/sidepanel/sidepanel.html", "utf8");
const all = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]).map((p) => path.resolve(ROOT + "/sidepanel", p));

const elements = new Map();
const mkEl = (id) => {
  if (elements.has(id)) return elements.get(id);
  const el = { id, style: {}, dataset: {}, children: [], value: "", textContent: "", innerHTML: "",
    className: "", checked: true, disabled: false,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {}, appendChild() {}, setAttribute(k, v) { this[k === "aria-label" ? "ariaLabel" : k] = v; }, insertBefore() {}, querySelector() { return mkEl(id + "_q"); },
    querySelectorAll() { return []; }, scrollIntoView() {}, onclick: null };
  elements.set(id, el);
  return el;
};
const documentObj = { getElementById: (id) => mkEl(id), createElement: () => mkEl("a" + Math.random()),
  createDocumentFragment: () => mkEl("f" + Math.random()), querySelectorAll: () => [], body: mkEl("body") };

const storageData = new Map();
const removedKeys = [];
const changeListeners = [];
let llmCalls = 0;
const chromeStub = {
  storage: {
    local: {
      QUOTA_BYTES: 10485760,
      get: (keys, cb) => { const r = {}; for (const k of [].concat(keys)) r[k] = storageData.get(k); const p = Promise.resolve(r); if (typeof cb === "function") setTimeout(() => cb(r), 0); return p; },
      set: (obj, cb) => { for (const k of Object.keys(obj)) storageData.set(k, obj[k]); const p = Promise.resolve(); setTimeout(() => cb && cb(), 0); return p; },
      remove: (keys, cb) => { for (const k of [].concat(keys)) { storageData.delete(k); removedKeys.push(k); } const p = Promise.resolve(); setTimeout(() => cb && cb(), 0); return p; },
    },
    onChanged: { addListener(L) { changeListeners.push(L); } },
  },
  runtime: { sendMessage: async () => ({ ok: true, recState: "idle", count: 0, pending: 0, attachedTabs: 0, domains: [], unmatched: [], harvestCorrupt: false }), openOptionsPage() {} },
  tabs: { query: async () => [{ id: 1, url: "https://a.b.com/x" }] },
  scripting: { executeScript: async () => [{ result: { status: 200, ok: true, text: "{}" } }] },
  sidePanel: {}, permissions: { contains: async () => false, request: async () => true },
};
const sandbox = { console, setTimeout, setInterval: () => 0, clearInterval() {}, URL, URLSearchParams, fetch: async () => { throw new Error("nf"); },
  navigator: { clipboard: { writeText: async () => {} } }, document: documentObj, chrome: chromeStub, performance: { now: () => Date.now() },
  Date, Math, JSON, Object, Array, Set, Map, String, Number, Boolean, RegExp, Error, Promise,
  callLlm: async () => { llmCalls++; return { ok: true, content: "[]" }; } };
sandbox.window = sandbox; sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const f of all) new vm.Script(fs.readFileSync(f, "utf8"), { filename: f }).runInContext(sandbox);

let fails = 0;
const ok = (name, cond, got) => {
  if (!cond) { fails++; console.log("FAIL " + name + " → " + JSON.stringify(got)); }
  else console.log("  OK " + name);
};

(async () => {
  // 预置: 已有一条链(模拟上次会话存的)
  storageData.set("toolbox.aiChain", [{ from: 0, fromId: "e0", fromJsonPath: "data.a", to: 1, toId: "e1", toParam: "b", var: "v1", value: "1" }]);
  // 触发 loadHarvest(初始化已跑过, 但 entries 空时 renderChainPreview 仍可用) —— 直接验证行为
  await new Promise((r) => setTimeout(r, 30));

  // 1. 已有链时点「建链」→ 查看器而非 LLM
  const btn = mkEl("btnAiChain");
  btn.disabled = false;
  const before = llmCalls;
  await vm.runInContext("aiBuildChain()", sandbox);
  ok("已有链点建链 → 不调 LLM", llmCalls === before, { before, after: llmCalls });
  const outEl = mkEl("expOut");
  ok("查看器渲染出链明细", outEl.innerHTML.includes("v1") && outEl.innerHTML.includes("清除链"), outEl.innerHTML.slice(0, 120));

  // 2. 清除按钮 → aiChain 置空 + storage remove
  mkEl("chainClear").onclick();
  ok("清除链后 aiChain 为空", vm.runInContext("aiChain", sandbox) === null, vm.runInContext("aiChain", sandbox));
  ok("storage remove 被调(toolbox.aiChain)", removedKeys.includes("toolbox.aiChain"), removedKeys);
  ok("清除后 expOut 提示去建链", mkEl("expOut").innerHTML.includes("暂无依赖链"), mkEl("expOut").innerHTML.slice(0, 120));

  // 3. JMX 导出路径: applyAiChainToJmx + buildJmx → 生成 JSONPostProcessor
  const jmx = vm.runInContext(`buildJmx(applyAiChainToJmx([
    { id: "j0", method: "POST", url: "https://h.com/login", path: "/login", query: "", headers: {}, body: "{}", status: 200, response: "", ts: "" },
    { id: "j1", method: "POST", url: "https://h.com/save", path: "/save", query: "", headers: {}, body: '{"b":"OLD"}', status: 200, response: "", ts: "" }
  ], [{ from: 0, fromId: "j0", fromJsonPath: "data.a", to: 1, toId: "j1", toParam: "b", var: "vx", value: "" }]), { threads: 1 })`, sandbox);
  ok("JMX 生成 JSONPostProcessor(vx)", jmx.includes("JSONPostProcessor") && jmx.includes("$.data.a") && jmx.includes("vx"), jmx.match(/JSONPostProcessor[^>]{0,80}/)?.[0]);
  ok("JMX body 参数化 ${vx}(xmlEsc 后)", jmx.includes("&quot;b&quot;: &quot;${vx}&quot;"), jmx.match(/Argument\.value[^<]{0,60}/)?.[0]);

  // 4. skill「chain」建链 → id 快照也打上
  storageData.set("toolbox.aiChain", null);
  llmCalls = 0;
  // 造导出集: 直接在 realm 里塞 entries
  vm.runInContext(`entries = [
    { id: "s0", method: "POST", url: "https://h.com/login", path: "/login", query: "", headers: {}, body: "{}", status: 200, response: "", ts: "" },
    { id: "s1", method: "POST", url: "https://h.com/save", path: "/save", query: "", headers: {}, body: '{"b":"OLD"}', status: 200, response: "", ts: "" }
  ]`, sandbox);
  // callLlm 返回一条链(A 的 data.a → B 的 b)
  sandbox.callLlm = async () => ({ ok: true, content: '[{"from":1,"fromJsonPath":"data.a","to":2,"toParam":"b","var":"v9","value":"x"}]' });
  vm.runInContext(`$("skillSel")`, sandbox); // 初始化 skill 下拉已在加载时跑过
  mkEl("skillSel").value = "chain";
  mkEl("btnRunSkill").disabled = false;
  await vm.runInContext(`(async () => {
    $("skillSel").value = "chain";
    await runSelectedSkill();
  })()`, sandbox);
  const saved = storageData.get("toolbox.aiChain");
  ok("skill 建链存库", Array.isArray(saved) && saved.length === 1, saved);
  ok("skill 建链打 id 快照", saved && saved[0].fromId === "s0" && saved[0].toId === "s1", saved && saved[0]);

  // 5. JMX 生态骨架对拍(v1.0.60): 无 jmeter 可执行件, 用 samples/opensource 官方样本
  //    反向对拍结构骨架 —— README 宣称"格式参照权威生成器/生态可打开", 可自动验证的
  //    最强面 = ① XML 栈配对(JMeter XStream 解析的前置) ② hashTree 开闭配对(树塌=全错)
  //    ③ 全形态结构元素齐(OnceOnly/JSONPostProcessor/参数化/CookieManager)
  //    ④ 采样器数=条目数 ⑤ 与官方样本的 defaults 段骨架同构(connect_timeout/response_timeout
  //    放 ConfigTestElement 默认值级 —— JMeter sampler 空缺回落 defaults, 单写合法等价)。
  const JMX = require(ROOT + "/jmx.js");
  const mkE = (id, method, url, extra) => Object.assign({ id, method, url, path: new URL(url).pathname, query: "", headers: { "Content-Type": "application/json" }, body: '{"a":1}', status: 200, response: '{"token":"abc"}', mime: "application/json", ts: "2026-09-17T00:00:00Z", durationMs: 10 }, extra);
  const es = [
    mkE(1, "POST", "https://app.test.com/web/login", { body: '{"user":"u","pass":"p"}' }),
    mkE(2, "POST", "https://app.test.com/order/create", { body: '{"orderName":"DAN1","ts":1}' }),
    mkE(3, "GET", "https://app.test.com/order/list"),
    mkE(4, "POST", "https://app.test.com/order/pay", { body: '{"orderName":"DAN1"}' }),
  ];
  const corr2 = { groups: [{ method: "POST", path: "/order/create", count: 2, dynamics: [{ path: "ts", values: ["1", "2"], classify: { kind: "timestamp" }, var: "ts", replace: "${__time()}" }] }] };
  const chain2 = [{ from: 1, fromId: 1, fromJsonPath: "token", to: 1, toId: 4, toParam: "body.orderName", var: "v_tok", value: "DAN1" }];
  // 侧栏导出同构管线: applyCorr → applyAiChainToJmx → buildJmx(返回值链!丢了返回值=链静默不生效)
  const jmxFull = JMX.buildJmx(sandbox.applyAiChainToJmx(sandbox.applyCorr(es, corr2), chain2), { prelude: new Set([1]) });
  ok("全形态 JMX 含 OnceOnly+JSONPostProcessor+参数化", jmxFull.includes("OnceOnlyController") && jmxFull.includes("JSONPostProcessor") && jmxFull.includes("${__time()}") && jmxFull.includes("${v_tok}"), (jmxFull.match(/JSONPostProcessor/) || ["无"]) + "");
  // XML 栈配对(手写栈: node 无内建 XML parser, JMeter XStream 前置保证)
  {
    const stack = [];
    let pairOk = true;
    for (const t of jmxFull.matchAll(/<(\/?)([A-Za-z][\w.]*)[^>]*?(\/?)>/g)) {
      const [full2, close, name, self] = t;
      if (self === "/" || name === "xml") continue;
      if (close === "/") { const top = stack.pop(); if (top !== name) { pairOk = false; break; } }
      else stack.push(name);
    }
    ok("JMX XML 栈配对良构", pairOk && stack.length === 0, "残余栈 " + stack.length);
    const htO = (jmxFull.match(/<hashTree>/g) || []).length;
    const htC = (jmxFull.match(/<\/hashTree>/g) || []).length;
    ok("hashTree 开闭配对(树结构不塌)", htO === htC && htO > 0, htO + "/" + htC);
    ok("采样器数=条目数(4)", (jmxFull.match(/<HTTPSamplerProxy /g) || []).length === 4, (jmxFull.match(/<HTTPSamplerProxy /g) || []).length);
  }
  // 官方样本同构面: defaults 段骨架(connect_timeout/response_timeout 在 ConfigTestElement)
  {
    const official = fs.readFileSync(ROOT + "/samples/opensource/apache-jmeter/TestCookieManager.jmx", "utf8");
    const offDefaults = official.match(/<ConfigTestElement[\s\S]*?<\/ConfigTestElement>/)[0];
    const needProps = [...offDefaults.matchAll(/name="(HTTPSampler\.[a-z_]+)"/g)].map((m) => m[1]);
    const ourDefaults = jmxFull.match(/<ConfigTestElement[\s\S]*?<\/ConfigTestElement>/)[0];
    const missing = needProps.filter((p) => !ourDefaults.includes(`name="${p}"`));
    ok("defaults 段骨架与官方样本同构(HTTPSampler 属性齐)", missing.length === 0, "缺 " + missing.join(","));
  }

  // 6. renderChainPreview 数据流对拍(v1.0.65, #158 方向④): 渲染形态 vs aiChain 存储形态。
  //    场景 1 只断言"有 v1/清除链字样"——渲染层的三分支从未被钉死:
  //    a) 条目在集: 渲染 method+path 可读名(不是 #序号兜底);
  //    b) 条目被删(fromId/toId 悬空): 退 #序号兜底且不炸(renderChainPreview 读全局 entries);
  //    c) origin=corr 链带 ⚡ 标注、value 有值带录制值(渲染字段全消费)。
  //    复用场景 4 的 skill 建链产物(链已在 realm aiChain + entries 里)。链形态:
  //    callLlm 给 1 基下标 {from:1,to:2}, validateChain 转 0 基 {from:0,to:1},
  //    id 快照后 {from:0, fromId:"s0", to:1, toId:"s1"} —— 兜底渲染 #from+1/#to+1 = #1/#2。
  {
    // a+b: 条目在集 → 可读名; 悬空 id → #序号兜底(建链后条目被删的真实场景)
    vm.runInContext("renderChainPreview()", sandbox);
    let outHtml = mkEl("expOut").innerHTML;
    ok("链渲染用可读接口名(method+path)", outHtml.includes("POST /login") && outHtml.includes("POST /save"), outHtml.slice(0, 200));
    vm.runInContext("entries = []", sandbox); // 模拟建链后条目全删(丢弃/清洗)
    vm.runInContext("renderChainPreview()", sandbox);
    outHtml = mkEl("expOut").innerHTML;
    ok("条目被删后渲染退 #序号兜底(不炸)", outHtml.includes("#1") && outHtml.includes("#2"), outHtml.slice(0, 200));
    ok("兜底态仍带 var/路径/value 字段", outHtml.includes("v9") && outHtml.includes("data.a") && outHtml.includes("录制值"), outHtml.slice(0, 200));
    // c: origin=corr 标注
    vm.runInContext(`aiChain = [{ from: 0, fromId: "s0", fromJsonPath: "d.token", to: 1, toId: "s1", toParam: "b", var: "ord", value: "V", origin: "corr" }]`, sandbox);
    vm.runInContext("renderChainPreview()", sandbox);
    outHtml = mkEl("expOut").innerHTML;
    ok("corr 合成链带 ⚡ 标注(origin 消费)", outHtml.includes("🔗⚡"), outHtml.slice(0, 200));
    vm.runInContext("aiChain = null", sandbox); // 还原, 不污染后续场景
  }

  console.log(fails ? `=== FAIL ${fails} ===` : "=== aic UI/导出链路 PASS ===");
  process.exit(fails ? 1 : 0);
})();
