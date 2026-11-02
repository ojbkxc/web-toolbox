// check_page_locate.js —— 页面定位健壮性走查(v1.1.3)
// 覆盖: ① 命中测试(遮挡上报 / shadow 宿主反查) ② 滚动落定轮询 ③ 清空输入框走真实按键路径
//
// 手法: vm 里跑真实 bridge-client.js; chrome.scripting.executeScript 直接把注入函数
// 当普通函数调(配 DOM stub), chrome.debugger.sendCommand 记录调用序列后断言。
// 证明的是行为而不是源码字面量 —— "派发了哪些 CDP 命令、坐标取的是哪一次量的"。
const fs = require("fs");
const vm = require("vm");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log("  OK " + msg); }
  else { fail++; console.log("  FAIL " + msg); }
}

// ---------- 环境: 可注入的 DOM stub + 记录 CDP 调用 ----------
function newEnv() {
  const cdp = [];          // [{ method, params }]
  const execCount = { n: 0 };
  const doc = {
    _el: null,             // querySelector 一律返回它(快照打标记的语义)
    _onTop: null,          // elementFromPoint 返回它
    rangeCalls: 0,
    querySelector() { return this._el; },
    querySelectorAll() { return []; },
    elementFromPoint() { return this._onTop; },
    createRange() { this.rangeCalls++; return { selectNodeContents() {} }; },
  };

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    URL, URLSearchParams, AbortController,
    Event: class { constructor(t) { this.type = t; } },
    document: doc,
    getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
    chrome: {
      storage: { local: { get: async () => ({}), set: async () => {} }, onChanged: { addListener() {} } },
      alarms: { create() {}, clear() {}, onAlarm: { addListener() {} } },
      tabs: { query: async () => [], update: async () => {}, get: async () => ({}), remove: async () => {} },
      windows: { update: async () => {} },
      runtime: { getManifest: () => ({ version: "1.1.3" }) },
      scripting: {
        executeScript: async ({ func, args }) => {
          execCount.n++;
          return [{ result: func(...(args || [])) }];
        },
      },
      debugger: {
        attach: async () => {},
        detach: async () => {},
        sendCommand: async (_target, method, params) => {
          cdp.push({ method, params });
          // 像浏览器一样把 Backspace 作用到 DOM: 否则清空后的自检永远看到"没清掉"而误走兜底路径。
          // 只模拟 Backspace —— insertText 若也模拟追加, 会把非文本控件(select)直接置空的结果又写脏。
          const el = doc._el;
          if (el && method === "Input.dispatchKeyEvent" && params.key === "Backspace" && params.type !== "keyUp") {
            if (el.isContentEditable) el.textContent = "";
            else if (typeof el.value === "string") el.value = "";
          }
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
  return { sandbox, cdp, execCount, doc };
}

function makeEl(doc, o = {}) {
  const el = {
    tagName: o.tagName || "INPUT",
    className: o.className || "",
    shadowRoot: o.shadowRoot || null,
    type: o.type || "",
    isContentEditable: !!o.contentEditable,
    textContent: o.textContent || "",
    value: o.value === undefined ? "" : o.value,
    _rect: o.rect || { left: 100, top: 200, width: 40, height: 20 },
    _root: o.root || null,
    focused: false, selectCalled: false, scrolled: 0, dispatched: [],
    scrollIntoView() { this.scrolled++; },
    getBoundingClientRect() { return { ...this._rect }; },
    getRootNode() { return this._root || doc; },
    contains(x) { return x === this; },
    focus() { this.focused = true; },
    select() { this.selectCalled = true; },
    dispatchEvent(e) { this.dispatched.push(e.type); return true; },
    setAttribute() {}, getAttribute() { return null; },
  };
  return el;
}

const methods = (cdp) => cdp.map((c) => c.method + ":" + (c.params.type || ""));
const inputEvents = (cdp, type) => cdp.filter((c) => c.method === "Input.dispatchMouseEvent" && c.params.type === type);
const keyEvents = (cdp, key) => cdp.filter((c) => c.method === "Input.dispatchKeyEvent" && c.params.key === key);
const hasInsertText = (cdp) => cdp.some((c) => c.method === "Input.insertText");

(async () => {
  // ================= ① 命中测试: 目标在最上层 =================
  {
    const env = newEnv();
    const el = makeEl(env.doc);
    env.doc._el = el; env.doc._onTop = el;
    const res = await env.sandbox.toolboxBridge.dispatch("page.click", { tabId: 1, ref: "e1" });

    assert(res && res.ok === true, "a1. 命中目标时点击成功");
    assert(res.covered === undefined && res.coveredBy === undefined, "a2. 命中目标时不报遮挡");
    assert(res.x === 120 && res.y === 210, "a3. 坐标取元素中心(100+40/2, 200+20/2)");
    assert(inputEvents(env.cdp, "mouseMoved").length === 1 &&
      inputEvents(env.cdp, "mousePressed").length === 1 &&
      inputEvents(env.cdp, "mouseReleased").length === 1, "a4. 派发完整真实鼠标序列 moved/pressed/released");
    const pr = inputEvents(env.cdp, "mousePressed")[0].params;
    assert(pr.button === "left" && pr.clickCount === 1, "a5. 左键单击参数正确");
    assert(methods(env.cdp).join(",") ===
      "Input.dispatchMouseEvent:mouseMoved,Input.dispatchMouseEvent:mousePressed,Input.dispatchMouseEvent:mouseReleased",
      "a6. 事件顺序 moved → pressed → released");
    assert(el.scrolled >= 2, "a7. 每次量坐标前都滚进视口");
  }

  // ================= ② 滚动落定轮询 =================
  {
    const env = newEnv();
    let n = 0;
    const el = makeEl(env.doc);
    // 第一次量到"还在动"的坐标, 之后稳定 —— 旧实现会把 20 当最终坐标派发出去
    el.getBoundingClientRect = () => (++n === 1
      ? { left: 0, top: 0, width: 40, height: 20 }
      : { left: 100, top: 200, width: 40, height: 20 });
    env.doc._el = el; env.doc._onTop = el;
    const res = await env.sandbox.toolboxBridge.dispatch("page.click", { tabId: 1, ref: "e1" });

    assert(res.x === 120 && res.y === 210, "b1. 元素移动时取落定后的坐标, 不取第一次的中途坐标");
    assert(n === 3, "b2. 量了 3 次(最后一次与前一次一致才收工), 实际 " + n);
    assert(env.execCount.n === 3, "b3. 落定检查真的多量了(注入调用 3 次)");
    assert(inputEvents(env.cdp, "mouseMoved")[0].params.x === 120, "b4. 派发用的是落定坐标");
  }

  // ================= ③ 命中测试: 被遮罩压住要上报 =================
  {
    const env = newEnv();
    const el = makeEl(env.doc, { tagName: "BUTTON", className: "submit primary" });
    const mask = makeEl(env.doc, { tagName: "DIV", className: "overlay-box dim" });
    env.doc._el = el; env.doc._onTop = mask;
    const res = await env.sandbox.toolboxBridge.dispatch("page.click", { tabId: 1, ref: "e1" });

    assert(res.ok === true, "c1. 被遮挡仍然照常派发鼠标事件(与旧行为一致, 不静默改成其他点击方式)");
    assert(res.covered === true, "c2. 被遮挡时明确上报 covered");
    assert(res.coveredBy === "div.overlay-box", "c3. 上报覆盖物标识(直接子元素取到首个 class), 实际 " + res.coveredBy);
    assert(inputEvents(env.cdp, "mousePressed").length === 1, "c4. 鼠标事件确实发了(调用方能看到真相但不丢能力)");
  }

  // ================= ④ 命中测试: shadow 宿主反查 =================
  {
    const env = newEnv();
    const el = makeEl(env.doc, { root: null });
    const host = { tagName: "MY-HOST", className: "", shadowRoot: { contains: (x) => x === el } };
    el._root = { elementFromPoint: () => host };
    env.doc._el = el; env.doc._onTop = null;   // document.elementFromPoint 只会看到宿主
    const res = await env.sandbox.toolboxBridge.dispatch("page.click", { tabId: 1, ref: "e1" });
    assert(res.covered === undefined, "d1. 目标在 shadow root 内时按宿主反查, 不误报遮挡");
  }

  // ================= ⑤ 命中测试: 视口外量不出覆盖物时不乱下结论 =================
  {
    const env = newEnv();
    const el = makeEl(env.doc);
    env.doc._el = el; env.doc._onTop = null;   // elementFromPoint 返回 null
    const res = await env.sandbox.toolboxBridge.dispatch("page.click", { tabId: 1, ref: "e1" });
    assert(res.covered === undefined, "e1. 量不到覆盖物(视口外)时不报遮挡, 不制造假警报");
  }

  // ================= ⑥ 清空输入框: 有内容走真实 Backspace =================
  {
    const env = newEnv();
    const el = makeEl(env.doc, { tagName: "INPUT", value: "旧内容" });
    env.doc._el = el; env.doc._onTop = el;
    const res = await env.sandbox.toolboxBridge.dispatch("page.type", { tabId: 1, ref: "e1", text: "新值", submit: true });

    assert(res.ok === true && res.chars === 2, "f1. 输入成功且字符数正确");
    assert(el.focused === true, "f2. 注入函数先聚焦元素");
    assert(el.selectCalled === true, "f3. 清空走【选中全部内容】而不是直接赋值");
    const bd = keyEvents(env.cdp, "Backspace");
    // 无 text 的键走 rawKeyDown(对齐 Playwright 的按键表): keyDown 是"带 text"的形态
    assert(bd.length === 2 && bd[0].params.type === "rawKeyDown" && bd[1].params.type === "keyUp",
      "f4. 派发真实 Backspace rawKeyDown/keyUp");
    assert(bd[0].params.code === "Backspace" && bd[0].params.windowsVirtualKeyCode === 8,
      "f5. Backspace 带 code 与 keyCode(只给 key 的合成键会被页面识破)");
    const m = methods(env.cdp);
    assert(m.indexOf("Input.dispatchKeyEvent:rawKeyDown") < m.indexOf("Input.insertText:"),
      "f6. 先删后写(Backspace 在 insertText 之前)");
    assert(el.dispatched.indexOf("input") === -1, "f7. 有内容时不再走 el.value 直接赋值(受控组件追踪器不会被打乱)");
    assert(res.clearedVia === "key", "f8. 真实按键清干净时回执 clearedVia=key(可观测走的哪条路)");
  }

  // ================= ⑦ 清空输入框: 空框不发多余按键 =================
  {
    const env = newEnv();
    const el = makeEl(env.doc, { tagName: "INPUT", value: "" });
    env.doc._el = el; env.doc._onTop = el;
    await env.sandbox.toolboxBridge.dispatch("page.type", { tabId: 1, ref: "e1", text: "abc" });

    assert(keyEvents(env.cdp, "Backspace").length === 0, "g1. 空框不发 Backspace(多余合成按键本身就是痕迹)");
    assert(hasInsertText(env.cdp), "g2. 空框仍然正常写入");
  }

  // ================= ⑧ 清空输入框: contenteditable 也能清 =================
  {
    const env = newEnv();
    const el = makeEl(env.doc, { tagName: "DIV", contentEditable: true, textContent: "hi" });
    env.doc._el = el; env.doc._onTop = el;
    await env.sandbox.toolboxBridge.dispatch("page.type", { tabId: 1, ref: "e1", text: "x" });

    assert(env.doc.rangeCalls === 1, "h1. contenteditable 走 Range 选中(旧实现没有 value 属性等于没清)");
    assert(keyEvents(env.cdp, "Backspace").length === 2, "h2. contenteditable 同样用真实 Backspace 删除");
  }

  // ================= ⑨ 清空输入框: 非文本控件保持旧行为 =================
  {
    const env = newEnv();
    const el = makeEl(env.doc, { tagName: "SELECT", value: "old" });
    env.doc._el = el; env.doc._onTop = el;
    await env.sandbox.toolboxBridge.dispatch("page.type", { tabId: 1, ref: "e1", text: "x" });

    assert(keyEvents(env.cdp, "Backspace").length === 0, "i1. select 这类不可键盘编辑的控件不发按键");
    assert(el.value === "" && el.dispatched.indexOf("input") >= 0, "i2. 退回直接置空 + 派发 input(与旧实现一致)");
  }

  // ================= ⑩ 找不到 ref 时明确报错 =================
  {
    const env = newEnv();
    env.doc._el = null;
    let caught = "";
    try { await env.sandbox.toolboxBridge.dispatch("page.click", { tabId: 1, ref: "e9" }); }
    catch (e) { caught = String(e.message || e); }
    assert(/找不到 ref=e9/.test(caught), "j1. 元素找不到时报错并提示重新快照, 实际: " + caught);
  }

  // ================= ⑪ 悬停同样走落定 =================
  {
    const env = newEnv();
    const el = makeEl(env.doc, { rect: { left: 10, top: 20, width: 10, height: 10 } });
    env.doc._el = el; env.doc._onTop = el;
    const res = await env.sandbox.toolboxBridge.dispatch("page.hover", { tabId: 1, ref: "e1" });
    assert(res.ok === true && res.x === 15 && res.y === 25, "k1. 悬停也用落定坐标");
    assert(env.execCount.n === 2, "k2. 悬停走同一套落定检查");
  }

  console.log(`\n=== check_page_locate: ${fail === 0 ? "PASS" : "FAIL"} (${pass}/${pass + fail}) ===`);
  process.exit(fail === 0 ? 0 : 1);
})();
