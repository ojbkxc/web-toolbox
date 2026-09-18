// check_seq_link.js —— seq 动态值与 AI 链的联动断档修复回归:
//   1. linkSeqDynamics: 单号在更早条目响应里命中 → 合成链(origin:"corr")
//   2. timestamp 类不溯源(已有 ${__time()} 参数化)
//   3. 同值多路径但无同名叶 → 放弃(宁可不链)
//   4. 同名叶优先(多候选里有 leaf 同名的取它)
//   5. 变量名与 AI 链 var 不撞(taken 错开)
//   6. 合成链经 applyAiChain(重放注入)真的生效 —— 断档变闭环
//   7. 合成链经 applyAiChainToJmx 挂 JSONPostProcessor + ${var} 替换
//   8. 合成链经 buildPyScript 生成 pick 提取 + re.sub 注入(与 AI 链同语义)
//   9. showCorrelation 集成: 有 aiChain 时 concat 不覆盖 AI 链
const fs = require("fs");
const ROOT = require('path').resolve(__dirname, '..');
const vm = require("vm");
const path = require("path");

const ctx = { console, URL, URLSearchParams };
vm.createContext(ctx);
for (const f of ["correlate.js", "common.js", "jmx.js", "pyscript.js"]) {
  new vm.Script(fs.readFileSync(path.join(ROOT, f), "utf8"), { filename: f }).runInContext(ctx);
}
// applyAiChain 从 sidepanel.js 提取的副本
const aicSrc = fs.readFileSync(path.join(process.env.TEMP, "aic.js"), "utf8");
vm.runInContext(`this.applyAiChain = ${aicSrc};`, ctx);

let fails = 0;
const ok = (name, cond, got) => {
  if (!cond) { fails++; console.log("FAIL " + name + " → 实际: " + JSON.stringify(got)); }
  else console.log("  OK " + name);
};

// 场景: 建单接口录 2 次(单号不同), 查询接口响应里有同名单号
const mkEntries = () => ([
  { id: "s0", method: "POST", url: "https://h.com/login", path: "/login", query: "", headers: {}, body: "{}", status: 200,
    response: '{"data":{"token":"T1"}}', ts: "" },
  { id: "s1", method: "POST", url: "https://h.com/order/create", path: "/order/create", query: "", headers: {}, body: "{}", status: 200,
    response: '{"resultCode":"0","data":{"orderNo":"6512345678901"}}', ts: "" },
  { id: "s2", method: "POST", url: "https://h.com/order/submit", path: "/order/submit", query: "", headers: {},
    body: '{"orderNo":"6512345678901","remark":"A"}', status: 200, response: '{"resultCode":"0"}', ts: "" },
  { id: "s3", method: "POST", url: "https://h.com/order/create", path: "/order/create", query: "", headers: {}, body: "{}", status: 200,
    response: '{"resultCode":"0","data":{"orderNo":"6599999999999"}}', ts: "" },
  { id: "s4", method: "POST", url: "https://h.com/order/submit", path: "/order/submit", query: "", headers: {},
    body: '{"orderNo":"6599999999999","remark":"B"}', status: 200, response: '{"resultCode":"0"}', ts: "" },
]);

// ---- 1. 基本溯源 ----
{
  const entries = mkEntries();
  const corr = ctx.analyzeCorrelation(entries);
  const links = ctx.linkSeqDynamics(entries, corr, []);
  ok("correlate 识别出 submit 的 orderNo 是 seq 动态",
    corr.groups.some((g) => g.path === "/order/submit" && g.dynamics.some((d) => d.path === "orderNo")), corr.groups.map((g) => g.path));
  const noLinks = links.filter((c) => c.toParam === "orderNo");
  ok("每条 submit 都溯源到最近的上游 create", noLinks.length === 2, noLinks);
  const l0 = noLinks[0];
  ok("链形态: from=1(create) to=2(submit)", l0.from === 1 && l0.to === 2, l0);
  ok("fromJsonPath= data.orderNo", l0.fromJsonPath === "data.orderNo", l0.fromJsonPath);
  ok("fromId/toId 快照已打", l0.fromId === "s1" && l0.toId === "s2", l0);
  ok("origin 标 corr", l0.origin === "corr", l0.origin);
  ok("变量名以 V_orderNo 为基", /^V_orderNo/.test(l0.var), l0.var);
  const l1 = noLinks[1];
  ok("第二次 submit 溯源到第二个 create(就近原则)", l1.from === 3 && l1.to === 4, l1);
}

// ---- 2. timestamp 不溯源 ----
{
  const entries = [
    { id: "t0", method: "POST", url: "https://h.com/a", path: "/a", query: "", headers: {}, body: "{}", status: 200,
      response: '{"data":{"ts":1730000000000}}', ts: "" },
    { id: "t1", method: "POST", url: "https://h.com/b", path: "/b", query: "", headers: {}, body: '{"ts":1730000001000}', status: 200, response: "", ts: "" },
    { id: "t2", method: "POST", url: "https://h.com/b", path: "/b", query: "", headers: {}, body: '{"ts":1730000002000}', status: 200, response: "", ts: "" },
  ];
  const corr = ctx.analyzeCorrelation(entries);
  const links = ctx.linkSeqDynamics(entries, corr, []);
  ok("timestamp 类不溯源(值不同但已有 __time 参数化)", links.length === 0, links);
  ok("correlate 把 ts 归为 timestamp", corr.groups[0].dynamics[0].classify.kind === "timestamp", corr.groups[0].dynamics[0].classify);
}

// ---- 3. 同值多路径无同名叶 → 放弃 ----
{
  const entries = [
    { id: "u0", method: "POST", url: "https://h.com/q", path: "/q", query: "", headers: {}, body: "{}", status: 200,
      response: '{"a":{"x":"DUP"},"b":{"y":"DUP"}}', ts: "" },
    { id: "u1", method: "POST", url: "https://h.com/w", path: "/w", query: "", headers: {}, body: '{"field1":"DUP"}', status: 200, response: "", ts: "" },
    { id: "u2", method: "POST", url: "https://h.com/w", path: "/w", query: "", headers: {}, body: '{"field1":"DUP2"}', status: 200, response: "", ts: "" },
  ];
  const corr = ctx.analyzeCorrelation(entries);
  const links = ctx.linkSeqDynamics(entries, corr, []);
  ok("同值多路径且无同名叶 → 不链(保守)", links.length === 0, links);
}

// ---- 4. 同名叶优先 ----
{
  const entries = [
    { id: "v0", method: "POST", url: "https://h.com/q", path: "/q", query: "", headers: {}, body: "{}", status: 200,
      response: '{"data":{"orderNo":"OK1"},"meta":{"trace":"OK1"}}', ts: "" },
    { id: "v1", method: "POST", url: "https://h.com/w", path: "/w", query: "", headers: {}, body: '{"orderNo":"OK1"}', status: 200, response: "", ts: "" },
    { id: "v2", method: "POST", url: "https://h.com/w", path: "/w", query: "", headers: {}, body: '{"orderNo":"OK2"}', status: 200, response: "", ts: "" },
  ];
  const corr = ctx.analyzeCorrelation(entries);
  const links = ctx.linkSeqDynamics(entries, corr, []);
  ok("多候选里取同名叶(data.orderNo)", links.length === 1 && links[0].fromJsonPath === "data.orderNo", links);
}

// ---- 5. 变量名错开 ----
{
  const entries = mkEntries();
  const corr = ctx.analyzeCorrelation(entries);
  const links = ctx.linkSeqDynamics(entries, corr, ["V_orderNo"]); // AI 链已占 V_orderNo
  const vars = links.map((c) => c.var);
  ok("taken 占用时变量名加后缀", vars.includes("V_orderNo_2"), vars);
}

// ---- 6. 合成链经 applyAiChain 重放注入闭环 ----
{
  const entries = mkEntries();
  const corr = ctx.analyzeCorrelation(entries);
  const links = ctx.linkSeqDynamics(entries, corr, []);
  const rt = ctx.applyAiChain(entries, links);
  // 重放: create 返回新单号 → note 提取 → inject 到 submit
  rt.note(1, entries[1], JSON.stringify({ resultCode: "0", data: { orderNo: "65LIVE_LIVE" } }));
  const e2 = rt.inject(entries[2], links);
  ok("重放注入: submit.body 的旧单号被 live 值替换", e2.body.includes("65LIVE_LIVE") && !e2.body.includes("6512345678901"), e2.body);
  const rep = rt.report();
  ok("注入回执 applied 非空", rep.applied.length >= 1, rep.applied);
  // JMX: create 挂提取器, submit body 参数化
  const out = ctx.applyAiChainToJmx(entries, links);
  ok("JMX: create 挂 JSONPath 提取器($.data.orderNo)",
    (out[1]._extractors || []).some((x) => x.expr === "$.data.orderNo"), out[1]._extractors);
  ok("JMX: submit body 参数化 ${var}", out[2].body.includes("${" + links[0].var + "}"), out[2].body);
}

// ---- 7. PY 导出同语义 ----
{
  const entries = mkEntries();
  const corr = ctx.analyzeCorrelation(entries);
  const links = ctx.linkSeqDynamics(entries, corr, []);
  const script = ctx.buildPyScript(entries, "cookies.state.json", { aiChain: links });
  ok("PY: 生成 pick 函数", script.includes("def pick(obj, path):"), "");
  ok("PY: create 步骤提取 ctx[var]", script.includes("ctx[" + JSON.stringify(links[0].var) + "]"), script.match(/ctx\[.+?\]/g)?.slice(0, 3));
  ok("PY: submit 步骤 re.sub 注入", /re\.sub/.test(script), "");
}

// ---- 8. showCorrelation 集成(vm realm, aiChain 不被覆盖) ----
(async () => {
  const html = fs.readFileSync(ROOT + "/sidepanel/sidepanel.html", "utf8");
  const all = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]).map((p) => path.resolve(ROOT + "/sidepanel", p));
  const elements = new Map();
  const mkEl = (id) => {
    if (elements.has(id)) return elements.get(id);
    const el = { id, style: {}, dataset: {}, value: "", textContent: "", innerHTML: "", className: "", checked: true, disabled: false,
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      addEventListener() {}, appendChild() {}, setAttribute(k, v) { this[k === "aria-label" ? "ariaLabel" : k] = v; }, insertBefore() {}, querySelector() { return mkEl(id + "_q"); },
      querySelectorAll() { return []; }, scrollIntoView() {}, onclick: null };
    elements.set(id, el); return el;
  };
  const documentObj = { getElementById: (id) => mkEl(id), createElement: () => mkEl("a" + Math.random()),
    createDocumentFragment: () => mkEl("f" + Math.random()), querySelectorAll: () => [], body: mkEl("body") };
  const storageData = new Map();
  const chromeStub = {
    storage: {
      local: {
        get: (keys, cb) => { const r = {}; for (const k of [].concat(keys)) r[k] = storageData.get(k); if (typeof cb === "function") setTimeout(() => cb(r), 0); return Promise.resolve(r); },
        set: (obj, cb) => { for (const k of Object.keys(obj)) storageData.set(k, obj[k]); setTimeout(() => cb && cb(), 0); return Promise.resolve(); },
        remove: (keys, cb) => { for (const k of [].concat(keys)) storageData.delete(k); setTimeout(() => cb && cb(), 0); return Promise.resolve(); },
      },
      onChanged: { addListener() {} },
    },
    runtime: { sendMessage: async () => ({ ok: true }), openOptionsPage() {} },
    tabs: { query: async () => [{ id: 1, url: "https://a.b.com/x" }] },
    scripting: {}, sidePanel: {}, permissions: { contains: async () => false, request: async () => true },
  };
  const sandbox = { console, setTimeout, setInterval: () => 0, clearInterval() {}, URL, URLSearchParams, fetch: async () => { throw new Error("nf"); },
    navigator: { clipboard: { writeText: async () => {} } }, document: documentObj, chrome: chromeStub, performance: { now: () => Date.now() },
    Date, Math, JSON, Object, Array, Set, Map, String, Number, Boolean, RegExp, Error, Promise };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const f of all) new vm.Script(fs.readFileSync(f, "utf8"), { filename: f }).runInContext(sandbox);
  // 预置: AI 建了一条链 + 录制数据(5 条场景)
  storageData.set("toolbox.aiChain", [{ from: 0, fromId: "s0", fromJsonPath: "data.token", to: 1, toId: "s1", toParam: "header.X-Token", var: "ai_tok", value: "" }]);
  storageData.set("toolbox.harvest", { v: 1, entries: mkEntries() });
  // 显式 await loadHarvest: storage.get 异步回调链, 不等就把 entries 置进来,
  // showCorrelation 看到的 entries 还是空的(vm 测试坑 v1.0.4 已记, 这里补上)。
  await vm.runInContext("loadHarvest()", sandbox);
  vm.runInContext("showCorrelation()", sandbox);
  await new Promise((r) => setTimeout(r, 50));
  const saved = storageData.get("toolbox.aiChain");
  ok("AI 链保留 + 合成链 concat", Array.isArray(saved) && saved.length === 3, saved && saved.length);
  ok("合成链带 origin:corr", saved && saved.filter((c) => c.origin === "corr").length === 2, saved && saved.map((c) => c.origin));
  ok("AI 链的 var 未被占用(ai_tok 在)", saved && saved.some((c) => c.var === "ai_tok"), saved && saved.map((c) => c.var));
  ok("状态行提示溯源数", mkEl("expMsg").textContent.includes("溯源"), mkEl("expMsg").textContent);
  ok("链查看器渲染(含合成链标记)", mkEl("expOut").innerHTML.includes("V_orderNo"), mkEl("expOut").innerHTML.slice(0, 150));
  // 幂等: 同一集重复点「关联」→ 旧合成链剔除后重合成, 不整份翻倍(v1.0.17 修复回归)
  vm.runInContext("showCorrelation()", sandbox);
  await new Promise((r) => setTimeout(r, 50));
  const saved2 = storageData.get("toolbox.aiChain");
  ok("重复关联不翻倍(仍 3 条)", saved2 && saved2.length === 3, saved2 && saved2.length);
  ok("AI 链仍在 + 合成链重打", saved2 && saved2.filter((c) => c.origin === "corr").length === 2 && saved2.some((c) => c.var === "ai_tok"),
    saved2 && saved2.map((c) => c.var));

  // 退出必须留在 IIFE 尾部: 此前 process.exit 在 IIFE 外, 主线程不等异步 IIFE 就退出,
  // 集成段断言从未真正执行 —— 打印的 "PASS" 只是纯函数段的(7 条集成断言静默没跑)。
  console.log(fails ? `=== FAIL ${fails} ===` : "=== seq 溯源联动 PASS ===");
  process.exit(fails ? 1 : 0);
})();
