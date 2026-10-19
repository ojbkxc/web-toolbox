// check_list_enhance.js —— 验证列表增强: 状态码颜色/耗时展示、>=400 过滤语义、
// 勾选全选/反选、单条删除联动(前置标记/选中态/AI 链清理)、cURL 复制。
// vm realm: 串联 sidepanel 全部 script + DOM/storage stub(与 check_trim_sync 同套路)。
// 注意: renderList 把条目 div append 进 frag 再进 list, div.innerHTML 才是条目 HTML。
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const ROOT = require('path').resolve(__dirname, '..');
const storageData = new Map();
let copied = null;

function makeSandbox() {
  const elements = new Map();
  const mkEl = (id) => {
    if (elements.has(id)) return elements.get(id);
    const el = {
      id, style: {}, dataset: {}, children: [], _html: "",
      textContent: "", value: "", checked: false, disabled: false, className: "",
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      appendChild(c) { this.children.push(c); }, addEventListener() {}, setAttribute(k, v) { this[k === "aria-label" ? "ariaLabel" : k] = v; }, scrollIntoView() {},
      insertBefore(c) { this.children.unshift(c); },
      querySelectorAll: () => [], querySelector: () => null,
      onclick: null,
    };
    Object.defineProperty(el, "innerHTML", {
      get() { return this._html; },
      set(v) { this._html = v; },
    });
    elements.set(id, el);
    return el;
  };
  const storageLocal = {
    QUOTA_BYTES: 10485760,
    get: (k, cb) => {
      const o = {};
      for (const x of [].concat(k)) o[x] = storageData.get(x);
      setTimeout(() => cb && cb(o), 0);
      return Promise.resolve(o);
    },
    set: (o, cb) => {
      for (const k of Object.keys(o)) storageData.set(k, o[k]);
      setTimeout(() => cb && cb(), 0);
      return Promise.resolve();
    },
    remove: (k, cb) => {
      for (const x of [].concat(k)) storageData.delete(x);
      setTimeout(() => cb && cb(), 0);
      return Promise.resolve();
    },
  };
  const sb = {
    console, JSON, Math, Date, Promise, Object, Array, String, Number, Boolean, RegExp, Set, Map, URL, URLSearchParams, Symbol, Error, TypeError,
    AbortController,
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {},
    fetch: async () => { throw new Error("no fetch"); },
    navigator: { clipboard: { writeText: async (t) => { copied = t; } } },
    document: {
      getElementById: mkEl,
      createElement: () => mkEl("_el" + elements.size),
      createDocumentFragment: () => mkEl("_frag" + elements.size),
      querySelectorAll: () => [],
      body: mkEl("body"),
    },
    chrome: {
      storage: { local: storageLocal, onChanged: { addListener() {} } },
      runtime: { sendMessage: async () => ({ ok: true, recState: "idle", count: 0, attachedTabs: 0, domains: [], unmatched: [], harvestCorrupt: false }), openOptionsPage() {} },
      tabs: { query: async () => [{ id: 1, url: "https://ktki.example.com/web/index" }] },
      scripting: { executeScript: async () => [{ result: { status: 200, ok: true, text: "{}" } }] },
      sidePanel: { open: async () => {} },
      cookies: { getAll: async () => [] },
      permissions: { contains: async () => true },
    },
    performance: { now: () => Date.now() },
    confirm: () => true,
    alert() {},
    Blob: class {},
  };
  sb.window = sb;
  sb.globalThis = sb;
  vm.createContext(sb);
  const html = fs.readFileSync(path.join(ROOT, "sidepanel/sidepanel.html"), "utf8");
  for (const m of html.matchAll(/<script src="([^"]+)"><\/script>/g)) {
    const f = path.resolve(path.join(ROOT, "sidepanel"), m[1]);
    try { new vm.Script(fs.readFileSync(f, "utf8"), { filename: f }).runInContext(sb); }
    catch (e) { console.log("  [load-err]", m[1], ":", String(e).slice(0, 150)); process.exit(1); }
  }
  return { sb, elements };
}

function mkEntries() {
  const t = Date.now();
  return [
    { id: "r1", method: "POST", url: "https://ktki.example.com/web/ctxInit", path: "/web/ctxInit", query: "", headers: { "X-A": "1" }, body: "", status: 200, mime: "json", response: "{}", ts: new Date(t).toISOString(), durationMs: 120 },
    { id: "r2", method: "GET", url: "https://ktki.example.com/web/order/list", path: "/web/order/list", query: "page=1", headers: {}, body: "", status: 500, mime: "json", response: '{"e":"boom"}', ts: new Date(t + 1).toISOString(), durationMs: 4200 },
    { id: "r3", method: "GET", url: "https://ktki.example.com/web/static/app.js", path: "/web/static/app.js", query: "", headers: {}, body: "", status: 200, mime: "js", response: "", ts: new Date(t + 2).toISOString(), durationMs: 40 },
  ];
}

// 取 renderList 产出的条目 div(最后一轮 append 进 list 的 frag 的 children)
function lastRowHtmls(sp) {
  const list = sp.elements.get("list");
  const out = [];
  for (const node of list.children) {
    for (const div of node.children || []) {
      if (div._html && div._html.includes('class="m')) out.push(div._html);
    }
  }
  return out;
}

let fails = 0;
function assert(cond, name) {
  if (cond) console.log("  OK " + name);
  else { fails++; console.log("  FAIL " + name); }
}

(async () => {
  // ---- 场景 1: 耗时/状态码渲染进条目 div ----
  {
    storageData.clear();
    storageData.set("toolbox.harvest", { v: 1, entries: mkEntries() });
    const sp = makeSandbox();
    await vm.runInContext("loadHarvest()", sp.sb);
    const htmls = lastRowHtmls(sp).join("\n");
    assert(htmls.includes("4200ms"), "1a 慢条目耗时显示(4200ms)");
    assert(htmls.includes('class="st s5"'), "1b 500 状态码标红(s5)");
    assert(htmls.includes('class="dur slow"'), "1c 慢条目 dur.slow 类");
    assert(htmls.includes('class="st s2"'), "1d 200 状态码标绿(s2)");
  }

  // ---- 场景 2: >=400 过滤语义 ----
  {
    storageData.clear();
    storageData.set("toolbox.harvest", { v: 1, entries: mkEntries() });
    const sp = makeSandbox();
    await vm.runInContext("loadHarvest()", sp.sb);
    vm.runInContext("setFilter('>=400')", sp.sb);
    assert(vm.runInContext("visibleEntries()", sp.sb).length === 1, "2a '>=400' 只留 500");
    vm.runInContext("setFilter('200')", sp.sb);
    const vis2 = vm.runInContext("visibleEntries()", sp.sb);
    assert(vis2.length === 2 && vis2.every((e) => e.status === 200), "2b '200' 精确匹配两条");
    vm.runInContext("setFilter('post >=400')", sp.sb);
    assert(vm.runInContext("visibleEntries()", sp.sb).length === 0, "2c AND 语义: post + >=400 组合为空");
    vm.runInContext("setFilter('')", sp.sb);
    assert(vm.runInContext("visibleEntries()", sp.sb).length === 3, "2d 清空过滤恢复全量");
  }

  // ---- 场景 3: 勾选模式全选/反选 ----
  {
    storageData.clear();
    storageData.set("toolbox.harvest", { v: 1, entries: mkEntries() });
    const sp = makeSandbox();
    await vm.runInContext("loadHarvest()", sp.sb);
    vm.runInContext("togglePickMode()", sp.sb);
    assert(sp.elements.get("btnPickAll").style.display !== "none", "3a 勾选模式下全选按钮可见");
    vm.runInContext("togglePickAll()", sp.sb);
    assert(vm.runInContext("exportSet()", sp.sb).length === 3, "3b 全选 = 3 条");
    vm.runInContext("togglePickAll()", sp.sb);
    assert(vm.runInContext("exportSet()", sp.sb).length === 3, "3c 全取消后退回可见集语义(3 条)");
    assert((sp.elements.get("chainMsg").textContent || "").includes("退回可见集"), "3c2 全取消提示退回可见集(v1.0.38): " + sp.elements.get("chainMsg").textContent);
    vm.runInContext("togglePickMode()", sp.sb);
    assert(sp.elements.get("btnPickAll").style.display === "none", "3d 退出勾选模式全选按钮隐藏");
  }

  // ---- 场景 4: 单条删除联动 ----
  {
    storageData.clear();
    storageData.set("toolbox.harvest", { v: 1, entries: mkEntries() });
    storageData.set("toolbox.aiChain", [{ from: 0, fromId: "r1", fromJsonPath: "a", to: 1, toId: "r2", toParam: "body.orderNo", var: "v1", value: "x" }]);
    storageData.set("toolbox.manualPrelude", [["r1", true]]);
    const sp = makeSandbox();
    await vm.runInContext("loadHarvest()", sp.sb);
    vm.runInContext("select('r2')", sp.sb);
    assert(vm.runInContext("preludeIds.size", sp.sb) === 1, "4a 前置标记还原(r1)");
    vm.runInContext("removeOne(entries.find(e => e.id === 'r2'))", sp.sb);
    assert(vm.runInContext("entries.length", sp.sb) === 2, "4b 删除后剩 2 条");
    // 4c(#173 就近补选): 删除选中条后不再退回空态, 自动选中相邻条(详情区不空屏)
    assert(vm.runInContext("selectedId", sp.sb) === "r1", "4c 删除选中条后就近补选前一条(不再空态): " + vm.runInContext("selectedId", sp.sb));
    assert(vm.runInContext("aiChain", sp.sb) === null, "4d AI 链随删除失效");
    const mp = storageData.get("toolbox.manualPrelude");
    assert(!mp || !mp.some(([k]) => k === "r2"), "4e manualPrelude 无 r2 残留");
    const stored = storageData.get("toolbox.harvest");
    assert(stored && stored.entries.length === 2 && !stored.entries.some((e) => e.id === "r2"), "4f storage 同步删条");
  }

  // ---- 场景 4b(#173 复选框/详情区): 清洗清死勾 + 勾选持久化 + 详情摘要 + 空可见集全选护栏 ----
  {
    storageData.clear();
    storageData.set("toolbox.harvest", { v: 1, entries: [
      { id: "s1", method: "GET", url: "https://ktki.example.com/web/app.js", path: "/web/app.js", query: "", headers: {}, body: "", status: 200, response: "", mime: "text/javascript", ts: new Date().toISOString(), durationMs: 10 },
      { id: "r1", method: "POST", url: "https://ktki.example.com/web/api/one", path: "/web/api/one", query: "", headers: {}, body: "{}", status: 200, response: "{}", mime: "json", ts: new Date().toISOString(), durationMs: 10 },
      { id: "r2", method: "GET", url: "https://ktki.example.com/web/api/two", path: "/web/api/two", query: "", headers: {}, body: "", status: 500, response: '{"e":"boom"}', mime: "json", ts: new Date().toISOString(), durationMs: 4200 },
    ]});
    const sp = makeSandbox();
    await vm.runInContext("loadHarvest()", sp.sb);
    // 4g(v1.0.96 语义): 勾选模式勾 s1+r1 点清洗 → 删除勾选的两条(不再是噪音清洗)
    vm.runInContext("togglePickMode(); togglePick('s1'); togglePick('r1')", sp.sb);
    assert(sp.elements.get("btnClean").textContent === "✂ 删除勾选 2", "4g0 勾选后清洗按钮变身删除勾选 2: " + sp.elements.get("btnClean").textContent);
    await vm.runInContext("cleanVisible()", sp.sb);
    assert(vm.runInContext("entries.map(e=>e.id).join(',')", sp.sb) === "r2", "4g 删除勾选 s1+r1, 保留 r2: " + vm.runInContext("entries.map(e=>e.id).join(',')", sp.sb));
    const picked = vm.runInContext("[...pickIds]", sp.sb);
    assert(picked.length === 0, "4g2 删除后 pickIds 同清(死 id 不残留): " + JSON.stringify(picked));
    assert(sp.elements.get("btnClean").textContent === "✂ 清洗", "4g3 删完按钮回噪音清洗文案: " + sp.elements.get("btnClean").textContent);
    const gmsg = sp.elements.get("chainMsg").textContent || "";
    assert(gmsg.includes("已删除勾选 2 条"), "4g4 状态明示删除勾选条数: " + gmsg);
    // 4h. 勾选模式内删除后持久键为空集(无死 id 残留; 退出模式才 remove 键)
    assert(JSON.stringify(storageData.get("toolbox.pickIds")) === "[]", "4h 勾选模式内空集持久化为[](死 id 不残留): " + JSON.stringify(storageData.get("toolbox.pickIds")));
    // 4i. 有数据未选中 → 详情区渲染摘要(不再"点一条请求"空态)
    vm.runInContext("selectedId = null; renderDetail()", sp.sb);
    const dh = sp.elements.get("detail").innerHTML;
    assert(dh.includes("共") && dh.includes("失败 1") && dh.includes("慢 1"), "4i 未选中详情区带摘要(总数/失败/慢): " + dh.slice(0, 120));
    // 4j. 退出勾选模式 → 持久键清(不复活死集)
    vm.runInContext("togglePickMode()", sp.sb);
    assert(storageData.get("toolbox.pickIds") === undefined, "4j 退出勾选模式清持久键: " + JSON.stringify(storageData.get("toolbox.pickIds")));
    // 4k. 空可见集点全选 → 明示提示(不误导"退回可见集 0 条")
    vm.runInContext("togglePickMode(); setFilter('zzz-no-hit'); togglePickAll()", sp.sb);
    const msg = sp.elements.get("chainMsg").textContent || "";
    assert(msg.includes("可见集为空"), "4k 空可见集全选明示(不走误导性全清分支): " + msg);
    vm.runInContext("setFilter('')", sp.sb);
    // 4m. 重开侧栏(loadHarvest)恢复勾选模式与勾选集(新 realm + 共享 storageData)
    // r1 已被 4g 删除, 全选只勾 r2(不再退选 —— 恢复链路要留活勾)
    vm.runInContext("togglePickAll()", sp.sb);
    assert(vm.runInContext("[...pickIds].join(',')", sp.sb) === "r2", "4m-pre 勾选集只 r2: " + vm.runInContext("[...pickIds]", sp.sb));
    const sp2 = makeSandbox();
    await vm.runInContext("loadHarvest()", sp2.sb);
    assert(vm.runInContext("pickMode && pickIds.has('r2')", sp2.sb) === true, "4m 重开侧栏勾选模式+勾选集恢复(r2)");
    assert(vm.runInContext("exportSet().map(e=>e.id).join(',')", sp2.sb) === "r2", "4m2 恢复后导出集只含勾选条");
  }

  // ---- 场景 4n(v1.0.82): 清洗同时去重「method+path+query+body 完全相同」的请求 ----
  // 录制 177 条里 51 次 getByheadAndBodyParam 有 17 次请求完全重复(页面轮询噪音)。
  // 去重保留首条; headers/响应/耗时不同不拆(压测脚本同一请求发一遍即可)。
  {
    storageData.clear();
    storageData.set("toolbox.harvest", { v: 1, entries: [
      { id: "d1", method: "POST", url: "https://ktki.example.com/web/param", path: "/web/param", query: "", headers: {}, body: '{"type":"CCM_AWS_DASHBORAD"}', status: 200, response: "{}", mime: "json", ts: "", durationMs: 1 },
      { id: "d2", method: "POST", url: "https://ktki.example.com/web/param", path: "/web/param", query: "", headers: { "x-trace": "abc" }, body: '{"type":"CCM_AWS_DASHBORAD"}', status: 200, response: "{}", mime: "json", ts: "", durationMs: 2 }, // headers 不同, 请求相同 → 去重
      { id: "d3", method: "POST", url: "https://ktki.example.com/web/param", path: "/web/param", query: "", headers: {}, body: '{"type":"COMM_SYSTEM_LOGO"}', status: 200, response: "{}", mime: "json", ts: "", durationMs: 3 }, // body 不同 → 保留
      { id: "d4", method: "POST", url: "https://ktki.example.com/web/param", path: "/web/param", query: "", headers: {}, body: '{"type":"CCM_AWS_DASHBORAD"}', status: 200, response: "{}", mime: "json", ts: "", durationMs: 4 }, // 与 d1 完全重复 → 去重
      { id: "d5", method: "GET", url: "https://ktki.example.com/web/static/app.js", path: "/web/static/app.js", query: "", headers: {}, body: "", status: 200, response: "", mime: "js", ts: "", durationMs: 1 }, // 静态资源 → 清洗
    ]});
    const sp = makeSandbox();
    await vm.runInContext("loadHarvest()", sp.sb);
    await vm.runInContext("cleanVisible()", sp.sb);
    const ids = vm.runInContext("entries.map(e => e.id).join(',')", sp.sb);
    assert(ids === "d1,d3", "4n 去重(d2,d4 完全重复删除)+静态资源(d5 清洗)保留 d1,d3: " + ids);
    const msg = sp.elements.get("chainMsg").textContent || "";
    assert(msg.includes("重复请求"), "4n2 清洗状态明示含重复请求: " + msg);
    // 去重后勾选同步清(死 id 不残留): 重新 set 完整集再走勾选+清洗。
    storageData.clear();
    storageData.set("toolbox.harvest", { v: 1, entries: [
      { id: "d1", method: "POST", url: "https://ktki.example.com/web/param", path: "/web/param", query: "", headers: {}, body: '{"type":"CCM_AWS_DASHBORAD"}', status: 200, response: "{}", mime: "json", ts: "", durationMs: 1 },
      { id: "d2", method: "POST", url: "https://ktki.example.com/web/param", path: "/web/param", query: "", headers: {}, body: '{"type":"CCM_AWS_DASHBORAD"}', status: 200, response: "{}", mime: "json", ts: "", durationMs: 2 },
    ]});
    const sp2 = makeSandbox();
    await vm.runInContext("loadHarvest()", sp2.sb);
    vm.runInContext("togglePickMode(); togglePick('d2'); cleanVisible()", sp2.sb);
    assert(vm.runInContext("entries.map(e=>e.id).join(',')", sp2.sb) === "d1", "4n3 勾选删除 d2(勾了点剪刀=删勾选), 保留 d1: " + vm.runInContext("entries.map(e=>e.id).join(',')", sp2.sb));
    assert(vm.runInContext("[...pickIds].join(',')", sp2.sb) === "", "4n3b 删除后 pickIds 死 id 同清");
    // 不同 method 不算重复: GET 与 POST 同名同 body 都保留
    storageData.clear();
    storageData.set("toolbox.harvest", { v: 1, entries: [
      { id: "m1", method: "GET", url: "https://ktki.example.com/web/x", path: "/web/x", query: "", headers: {}, body: "", status: 200, response: "", mime: "json", ts: "", durationMs: 1 },
      { id: "m2", method: "POST", url: "https://ktki.example.com/web/x", path: "/web/x", query: "", headers: {}, body: "", status: 200, response: "", mime: "json", ts: "", durationMs: 1 },
    ]});
    const sp3 = makeSandbox();
    await vm.runInContext("loadHarvest()", sp3.sb);
    await vm.runInContext("cleanVisible()", sp3.sb);
    assert(vm.runInContext("entries.length", sp3.sb) === 2, "4n4 GET/POST 同 path 不算重复, 都保留");
  }

  // ---- 场景 4p(v1.0.96): 勾选删除完整链路 —— confirm 取消零删除/选中补选/AI 链失效 ----
  {
    storageData.clear();
    storageData.set("toolbox.harvest", { v: 1, entries: [
      { id: "e1", method: "POST", url: "https://ktki.example.com/web/a", path: "/web/a", query: "", headers: {}, body: "{}", status: 200, response: "{}", mime: "json", ts: "", durationMs: 1 },
      { id: "e2", method: "GET", url: "https://ktki.example.com/web/b", path: "/web/b", query: "", headers: {}, body: "", status: 200, response: "{}", mime: "json", ts: "", durationMs: 2 },
      { id: "e3", method: "GET", url: "https://ktki.example.com/web/app.js", path: "/web/app.js", query: "", headers: {}, body: "", status: 200, response: "", mime: "text/javascript", ts: "", durationMs: 3 },
      { id: "e4", method: "POST", url: "https://ktki.example.com/web/d", path: "/web/d", query: "", headers: {}, body: "{}", status: 200, response: "{}", mime: "json", ts: "", durationMs: 4 },
    ]});
    // 预置 AI 链(锚定 e1): e1 被勾删 → 链必须整体失效(防错位注入)
    storageData.set("toolbox.aiChain", [{ from: 0, fromId: "e1", fromJsonPath: "token", to: 3, toId: "e4", toParam: "body.x", var: "v_t", value: "D1" }]);
    const sp = makeSandbox();
    await vm.runInContext("loadHarvest()", sp.sb);
    vm.runInContext("select('e1')", sp.sb);
    vm.runInContext("togglePickMode(); togglePick('e1'); togglePick('e3')", sp.sb);
    assert(sp.elements.get("btnClean").textContent === "✂ 删除勾选 2", "4p 勾选后按钮变身删除勾选 2: " + sp.elements.get("btnClean").textContent);
    // confirm 取消: 数据零变化
    vm.runInContext("confirm = () => false", sp.sb);
    await vm.runInContext("cleanVisible()", sp.sb);
    assert(vm.runInContext("entries.length", sp.sb) === 4, "4p2 confirm 取消零删除");
    vm.runInContext("confirm = () => true", sp.sb);
    await vm.runInContext("cleanVisible()", sp.sb);
    assert(vm.runInContext("entries.map(e=>e.id).join(',')", sp.sb) === "e2,e4", "4p3 删除勾选 e1+e3, 保留 e2,e4: " + vm.runInContext("entries.map(e=>e.id).join(',')", sp.sb));
    assert(vm.runInContext("aiChain", sp.sb) === null, "4p4 AI 链随删除失效(锚定条目被删, 保守清链)");
    assert(storageData.get("toolbox.aiChain") === undefined, "4p5 storage 侧 AI 链键同清");
    assert(vm.runInContext("selectedId", sp.sb) === "e2", "4p6 选中条被删就近补选 e2: " + vm.runInContext("selectedId", sp.sb));
    assert(vm.runInContext("[...pickIds].join(',')", sp.sb) === "", "4p7 勾选集随删除清空");
    assert(sp.elements.get("btnClean").textContent === "✂ 清洗", "4p8 删完按钮回清洗文案: " + sp.elements.get("btnClean").textContent);
    const pmsg = sp.elements.get("chainMsg").textContent || "";
    assert(pmsg.includes("已删除勾选 2 条"), "4p9 状态明示删除勾选条数: " + pmsg);
    // 4p10 storage 侧数据同步(persistEntries 整表写回): harvest 信封里 e1/e3 已不在
    const hv = storageData.get("toolbox.harvest");
    assert(hv && hv.entries.map((e) => e.id).join(",") === "e2,e4", "4p10 storage 整表写回(删勾选真删数据): " + (hv && hv.entries.map((e) => e.id).join(",")));
  }

  // ---- 场景 5: cURL 复制内容 ----
  {
    storageData.clear();
    storageData.set("toolbox.harvest", { v: 1, entries: mkEntries() });
    const sp = makeSandbox();
    await vm.runInContext("loadHarvest()", sp.sb);
    copied = null;
    await vm.runInContext("copyCurlFor(entries.find(e => e.id === 'r1'))", sp.sb);
    assert(copied && copied.includes("curl 'https://ktki.example.com/web/ctxInit'"), "5a cURL 含 url");
    assert(copied && copied.includes("-X POST"), "5b cURL 含方法");
    assert(copied && copied.includes("-H 'X-A: 1'"), "5c cURL 保留业务头");
    assert(copied && !copied.includes("--data-raw"), "5d 无 body 不带 --data-raw");
    copied = null;
    await vm.runInContext("copyCurlFor(entries.find(e => e.id === 'r3'))", sp.sb);
    assert(copied && !copied.includes("--data-raw"), "5e GET 无 body 同样干净");
  }

  // ---- 场景 6: 重放消费 textarea 编辑值(v1.0.73, #166 方向②) ----
  // replay() 的 body/headers 都从 dBody/dHeaders textarea 的【当前 value】取
  // (sidepanel.js L544/L546)—— 用户在详情页改 body/加减头后点重放, 发出的必须是
  // 编辑后的值而非录制原值。这条消费链此前零行为级断言(grep 全测试只有 aria 断言)。
  // 断言法: executeScript stub 按 URL 分流并捕获注入参数, 对比参数里的 body/headers。
  {
    storageData.clear();
    storageData.set("toolbox.harvest", { v: 1, entries: mkEntries() });
    const sp = makeSandbox();
    await vm.runInContext("loadHarvest()", sp.sb);
    // 捕获注入参数: execInPage → executeScript({target, func, args}) 的
    // args = [url, method, headers, body](sidepanel.js L558 传参序)。
    // replayFn 体内走 fetch —— sandbox 的 fetch 是 throw("no fetch") stub,
    // 注入函数在 sandbox 里执行会炸(真实 Chrome 里在页面上下文跑, sandbox 无关)。
    // 捕获 stub 不真调 cfg.func, 直接回假结果。
    const captured = [];
    sp.sb.chrome.scripting.executeScript = async (cfg) => {
      captured.push({ headers: cfg.args[2], body: cfg.args[3], url: cfg.args[0] });
      return [{ result: { status: 200, ok: true, text: "{}" } }];
    };
    vm.runInContext("select('r1')", sp.sb);
    // mkEl 是惰性工厂: getElementById 首次提及才建元素。select 后 replay 消费前先 touch
    // 一次让 dBody/dHeaders 进入 elements Map(vm stub 无 DOM 解析, innerHTML 不建元素)。
    sp.sb.document.getElementById("dBody");
    sp.sb.document.getElementById("dHeaders");
    // 编辑 textarea: 改 body + 加一个自定义头 + 保留原头
    sp.elements.get("dBody").value = '{"edited":"YES"}';
    sp.elements.get("dHeaders").value = "X-A: 1\nX-Edited: true\n坏行无冒号\n: 空键\n";
    await vm.runInContext("replay(entries.find(e => e.id === 'r1'))", sp.sb);
    assert(captured.length === 1, "6a 重放发起一次 executeScript");
    assert(captured[0].body === '{"edited":"YES"}', "6b 重放 body 是 textarea 编辑值(非录制原值): " + captured[0].body);
    assert(captured[0].headers["X-Edited"] === "true", "6c 编辑新增头真实注入: " + JSON.stringify(captured[0].headers));
    assert(captured[0].headers["X-A"] === "1", "6d 保留原头");
    assert(!("X-Bad" in captured[0].headers) && Object.keys(captured[0].headers).length === 2, "6e 坏行(无冒号/空键)被过滤, 只 2 头: " + JSON.stringify(captured[0].headers));
    // 6f 对照组: 不动 textarea, 重放走录制原值
    sp.elements.get("dBody").value = "original-body";
    sp.elements.get("dHeaders").value = "X-A: 1";
    captured.length = 0;
    await vm.runInContext("replay(entries.find(e => e.id === 'r1'))", sp.sb);
    assert(captured[0].body === "original-body" && captured[0].headers["X-A"] === "1", "6f 未编辑时重放走 textarea 当前值");
  }

  console.log(fails ? `\n=== FAIL ${fails} ===` : "\n=== 列表增强 PASS ===");
  process.exit(fails ? 1 : 0);
})();
