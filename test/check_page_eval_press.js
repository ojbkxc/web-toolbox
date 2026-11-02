// check_page_eval_press.js —— page.eval 序列化 / page.press 按键表 / 快照禁用态(v1.1.3)
//
// 覆盖:
//   ① page.eval 不再"假装成功": Map/Set/函数/DOM 节点/循环引用/超限都规约成可读形态
//   ② page.press 补 code/keyCode(表内键 / 单字符 / 大写带 Shift / 表外键退回只传 key)
//   ③ 快照标出 disabled —— AI 拿到禁用按钮不再盲点
//   ④ 死代码 bridgeSafeValue 已清(它带着同一个 JSON.stringify 缺陷, 且从未被调用)
//
// 手法同上一个走查: vm 跑真实 bridge-client.js, executeScript 直调注入函数(配 DOM stub),
// CDP 调用序列断言。
const fs = require("fs");
const vm = require("vm");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log("  OK " + msg); }
  else { fail++; console.log("  FAIL " + msg); }
}

// ---------- 环境 ----------
function newEnv(snapElements) {
  const cdp = [];
  const doc = {
    _el: null,
    _onTop: null,
    _snap: snapElements || [],
    title: "示例页",
    body: { nodeType: 1, nodeName: "BODY", tagName: "BODY", id: "", className: "" },
    querySelector() { return this._el; },
    querySelectorAll(sel) {
      if (sel === "[data-ai-ref]") return [];              // 清上次标记
      if (sel === "*" || /iframe/.test(sel)) return [];     // shadow 递归 / 同源 iframe 递归
      return this._snap;                                    // 快照的选择器表
    },
    elementFromPoint() { return this._onTop; },
    createRange() { return { selectNodeContents() {} }; },
    execCommand() { return true; },          // contenteditable 兜底删除(本文件用不到, 保底不炸)
  };
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    URL, URLSearchParams, AbortController,
    Event: class { constructor(t) { this.type = t; } },
    document: doc,
    location: { href: "https://example.com/form" },
    getComputedStyle: () => ({ visibility: "visible", display: "block" }),
    getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
    // 兜底路径要用原型访问器写 value(绕 React 值追踪器), 给最小同形类
    HTMLInputElement: { prototype: INPUT_PROTO },
    HTMLTextAreaElement: { prototype: INPUT_PROTO },
    chrome: {
      storage: { local: { get: async () => ({}), set: async () => {} }, onChanged: { addListener() {} } },
      alarms: { create() {}, clear() {}, onAlarm: { addListener() {} } },
      tabs: { query: async () => [], update: async () => {}, get: async () => ({}), remove: async () => {} },
      windows: { update: async () => {} },
      runtime: { getManifest: () => ({ version: "1.1.3" }) },
      scripting: { executeScript: async ({ func, args }) => [{ result: func(...(args || [])) }] },
      debugger: {
        attach: async () => {},
        detach: async () => {},
        sendCommand: async (_t, method, params) => {
          cdp.push({ method, params });
          // 把 Backspace 作用到 DOM(除非元素标记 _swallowKeys, 用来模拟富文本编辑器吞键)
          const el = doc._el;
          if (el && !el._swallowKeys && method === "Input.dispatchKeyEvent" &&
              params.key === "Backspace" && params.type !== "keyUp") {
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
  return { sandbox, cdp, doc };
}

function snapEl(o) {
  return {
    tagName: o.tagName || "BUTTON", type: o.type || "", name: o.name || "", className: "",
    innerText: o.label || "", value: "", disabled: !!o.disabled,
    _attrs: o.attrs || {}, shadowRoot: null,
    getAttribute(k) { return this._attrs[k] !== undefined ? this._attrs[k] : null; },
    getBoundingClientRect() { return { width: 80, height: 30 }; },
    querySelector() { return null; },
    setAttribute(k, v) { this._attrs[k] = v; },
    removeAttribute(k) { delete this._attrs[k]; },
  };
}

// page.type 用的输入框 stub(清空路径)。value 挂在原型访问器上, 才能与真实
// HTMLInputElement 同形 —— 桥接的兜底清空走的就是原型上的 value setter。
const INPUT_PROTO = Object.create(Object.prototype);
Object.defineProperty(INPUT_PROTO, "value", {
  get() { return this._value; }, set(v) { this._value = v; }, configurable: true,
});
function makeInput(o = {}) {
  const el = Object.create(INPUT_PROTO);
  Object.assign(el, {
    tagName: o.tagName || "INPUT", type: o.type || "text", name: "", className: "",
    readOnly: !!o.readOnly, disabled: !!o.disabled,
    isContentEditable: false, textContent: "", shadowRoot: null,
    _root: null, _doc: null, focused: false, selectCalled: false, dispatched: [],
    scrollIntoView() {}, getBoundingClientRect() { return { left: 0, top: 0, width: 10, height: 10 }; },
    getRootNode() { return this._root || this._doc; },
    contains(x) { return x === this; }, focus() { this.focused = true; }, select() { this.selectCalled = true; },
    dispatchEvent(e) { this.dispatched.push(e.type); return true; },
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
  });
  el._value = o.value === undefined ? "" : o.value;
  return el;
}

const keyEvents = (cdp) => cdp.filter((c) => c.method === "Input.dispatchKeyEvent");

(async () => {
  // ================= ① page.eval: 不再静默丢数据 =================
  {
    const env = newEnv();
    const ev = (script) => env.sandbox.toolboxBridge.dispatch("page.eval", { tabId: 1, script });
    const val = async (script) => (await ev(script)).value;

    const m = await ev('new Map([["a",1],["b",2]])');
    assert(m.ok === true && JSON.stringify(m.value) === '{"a":1,"b":2}',
      "a1. Map 变成等价对象(旧实现 JSON.stringify(new Map()) 不抛, 结果静默变 {}), 实际 " + JSON.stringify(m.value));
    assert(JSON.stringify(await val("new Set([1,2,2])")) === "[1,2]", "a2. Set 变成数组(去重后 2 条), 实际 " + JSON.stringify(await val("new Set([1,2,2])")));
    assert(await val("(function named(){})") === "[Function named]", "a3. 函数给出名字而不是字段消失");
    assert(await val("NaN") === "NaN", "a4. NaN 保留语义(过 JSON 会变 null)");
    assert(await val("document.body") === "[Node body]", "a5. DOM 节点给出标签标识(真节点有 parentNode 环, 旧实现退成 [object ...])");
    assert(await val("new Date(0)") === "1970-01-01T00:00:00.000Z", "a6. Date 走 ISO");
    assert(await val("/a+/g") === "/a+/g", "a7. RegExp 走字面量");

    const circ = await val("(function(){const o={a:1}; o.self=o; return o;})()");
    assert(circ.a === 1 && circ.self === "[Circular]", "a8. 循环引用不炸且标出来");

    // ---- 兼容线: 旧实现没有上限, 现成脚本可能整取几百条/较深对象, 护栏不该削掉它们 ----
    const shallow = await ev("({a:{b:{c:{d:{e:1}}}}})");
    assert(shallow.value.a.b.c.d.e === 1 && shallow.truncated === undefined,
      "a9. 5 层对象原样返回、不标截断(上限只防异常结构, 不削正常数据)");

    const mid = await ev("new Array(300).fill(0)");
    assert(mid.value.length === 300 && mid.truncated === undefined, "a10. 300 条数组原样返回");

    const deep = await val("(function(){let o={v:1}; for(let i=0;i<12;i++) o={next:o}; return o;})()");
    let node = deep, lvl = 0;
    while (node && typeof node === "object" && node.next && lvl < 20) { node = node.next; lvl++; }
    assert(node === "[MaxDepth]", "a11. 十几层的异常结构才截断标 [MaxDepth], 实际第 " + lvl + " 层为 " + JSON.stringify(node));

    const big = await ev("new Array(1200).fill(0)");
    assert(big.value.length === 1000 && big.truncated === true, "a12. 超量截断到 1000 条并置 truncated(不静默丢)");

    const cls = await val("new (class Foo{})()");
    assert(cls === "[Object Foo]", "a13. 无自有键的实例给出类名(旧实现返回空 {})");

    const boom = await ev("throw new Error('boom')");
    assert(boom.ok === false && /boom/.test(boom.error), "a14. 抛错照旧走 ok:false 带原文");

    const plain = await val('({n: 1, s: "x", b: true, nil: null})');
    assert(JSON.stringify(plain) === '{"n":1,"s":"x","b":true,"nil":null}', "a15. 普通对象原样返回(无行为回归)");
    assert(await val("undefined") === null, "a16. undefined 仍是 null(与旧契约一致)");

    // ---- 兼容线: 规约本身不能比旧实现更容易失败 ----
    const throwing = await ev("({ get boom() { throw new Error('getter'); }, ok: 1 })");
    assert(throwing.ok === true && throwing.value.ok === 1 && throwing.value.boom === "[Throws]",
      "a17. 单个取值器抛错只标该字段, 整次求值仍成功(旧实现靠 JSON.stringify 也能成功), 实际 " + JSON.stringify(throwing));
    const trapping = await ev("new Proxy({}, { ownKeys() { throw new Error('trap'); } })");
    assert(trapping.ok === true && trapping.value === "[object Object]",
      "a18. 连属性枚举都抛的怪对象退回 String(v) 且仍 ok:true(旧实现同样给字符串), 实际 " + JSON.stringify(trapping.value));
  }

  // ================= ② page.press: 补 code/keyCode =================
  {
    const env = newEnv();
    const press = (key) => env.sandbox.toolboxBridge.dispatch("page.press", { tabId: 1, key });

    let r = await press("Tab");
    let ev = keyEvents(env.cdp);
    assert(r.ok === true && r.code === "Tab", "b1. 表内键返回补全后的 code");
    assert(ev.length === 2 && ev[0].params.code === "Tab" && ev[0].params.windowsVirtualKeyCode === 9,
      "b2. Tab 带 code/keyCode(只给 key 时靠 keyCode 触发的默认行为会失效)");
    assert(ev[0].params.type === "rawKeyDown", "b3. 无 text 的键发 rawKeyDown(对齐 Playwright)");

    env.cdp.length = 0;
    r = await press("Enter");
    ev = keyEvents(env.cdp);
    assert(ev[0].params.type === "rawKeyDown" && ev[0].params.text === undefined &&
      ev[0].params.code === "Enter" && ev[0].params.windowsVirtualKeyCode === 13,
      "b4. Enter 不发 text —— 带 \\r 会多出 char 事件, 在 textarea 上多插一个换行; 提交路径改动前就没有它");

    env.cdp.length = 0;
    await press("ArrowDown");
    ev = keyEvents(env.cdp);
    assert(ev[0].params.code === "ArrowDown" && ev[0].params.windowsVirtualKeyCode === 40, "b5. 方向键有 code/keyCode");

    env.cdp.length = 0;
    r = await press("a");
    ev = keyEvents(env.cdp);
    assert(ev.length === 2 && ev[0].params.code === "KeyA" && ev[0].params.windowsVirtualKeyCode === 65 &&
      ev[0].params.text === "a" && ev[0].params.modifiers === 0, "b6. 小写字母: KeyA/65/text, 不带 Shift");

    env.cdp.length = 0;
    await press("A");
    ev = keyEvents(env.cdp);
    assert(ev.length === 4 && ev[0].params.key === "Shift" && ev[0].params.modifiers === 8 &&
      ev[1].params.key === "A" && ev[1].params.modifiers === 8 && ev[3].params.type === "keyUp" && ev[3].params.key === "Shift",
      "b7. 大写字母自动按住 Shift(否则 event.key 与 text 对不上)");

    env.cdp.length = 0;
    r = await press("!");
    ev = keyEvents(env.cdp);
    assert(ev[1].params.key === "!" && ev[1].params.text === "!" &&
      ev[1].params.code === undefined && ev[1].params.windowsVirtualKeyCode === undefined,
      "b8. 符号只给 key/text 不给 code/keyCode(给了错值比不给更糟)");
    assert(r.code === null, "b9. 符号无 code 时回执为 null");

    env.cdp.length = 0;
    r = await press("F5");
    ev = keyEvents(env.cdp);
    assert(ev.length === 2 && ev[0].params.key === "F5" && ev[0].params.code === undefined,
      "b10. 表外键名(如 F5)退回只传 key, 不因补表而拒用");

    // 键表是普通对象: "constructor"/"toString"/"__proto__" 会命中原型成员, 若不查自有属性
    // 就会取到函数/对象当 spec, key 变 undefined —— 原本能透传的键名反而发出空键。
    for (const weird of ["constructor", "toString", "__proto__"]) {
      env.cdp.length = 0;
      r = await press(weird);
      ev = keyEvents(env.cdp);
      assert(ev.length === 2 && ev[0].params.key === weird && ev[0].params.code === undefined && r.key === weird,
        "b11. 原型同名键名(" + weird + ")退回只传 key, 不当成表内键, 实际 key=" + String(r.key));
    }
  }

  // ================= ③ 快照标禁用态 =================
  {
    const env = newEnv([
      snapEl({ tagName: "BUTTON", type: "submit", label: "提交", disabled: true }),
      snapEl({ tagName: "INPUT", type: "text", name: "q", label: "搜索", attrs: { placeholder: "搜索" } }),
      snapEl({ tagName: "DIV", label: "假禁用", attrs: { "aria-disabled": "true" } }),
    ]);
    env.doc._el = null;
    const snap = await env.sandbox.toolboxBridge.dispatch("page.snapshot", { tabId: 1, maxChars: 4000 });
    const lines = String(snap.text).split("\n");
    assert(lines[0] === 'e1 button[submit] "提交" [disabled]', "c1. 原生 disabled 标出来, 实际 " + lines[0]);
    assert(lines[1] === 'e2 input[text] name=q "搜索"', "c2. 未禁用元素不加标记, 实际 " + lines[1]);
    assert(lines[2] === 'e3 div "假禁用" [disabled]', "c3. aria-disabled=true 同样标出来, 实际 " + lines[2]);
    assert(snap.url === "https://example.com/form" && snap.count === 3, "c4. 快照其余字段不受影响");
  }

  // ================= ⑤ 清空输入框: 只读/禁用/hidden 保持旧行为 =================
  // 兼容线: 旧实现对任何有 value 的元素都直接置空。改成"选中 + 真实 Backspace"后, 键盘删不掉
  // 的那几类控件必须退回直接置空, 否则原本能清空的字段就清不掉了。
  {
    const cases = [
      { name: "只读", opts: { readOnly: true } },
      { name: "禁用", opts: { disabled: true } },
      { name: "hidden", opts: { type: "hidden" } },
    ];
    for (const c of cases) {
      const env = newEnv();
      const el = makeInput({ ...c.opts, value: "旧值" });
      el._doc = env.doc;
      env.doc._el = el;
      await env.sandbox.toolboxBridge.dispatch("page.type", { tabId: 1, ref: "e1", text: "新" });
      const bd = keyEvents(env.cdp).filter((x) => x.params.key === "Backspace");
      assert(bd.length === 0, "e. " + c.name + "控件不发 Backspace(键盘本来就删不掉)");
      assert(el.value === "" && el.dispatched.indexOf("input") >= 0,
        "e. " + c.name + "控件退回直接置空 + 派发 input(与旧实现逐字一致)");
    }
  }

  // ================= ④ 清空输入框: 编辑器吞键时退回直接置空 =================
  // 兼容线: 改走真实 Backspace 后, 富文本编辑器可能吞掉按键"清不掉"。清不掉必须退回等效旧
  // 实现的做法, 不让"清空"静默失败; 回执 clearedVia=direct 让调用方看得出走了兜底。
  {
    const env = newEnv();
    const el = makeInput({ value: "旧值" });
    el._doc = env.doc;
    el._swallowKeys = true;   // 模拟编辑器吞掉 Backspace
    env.doc._el = el;
    const res = await env.sandbox.toolboxBridge.dispatch("page.type", { tabId: 1, ref: "e1", text: "新" });
    assert(keyEvents(env.cdp).filter((x) => x.params.key === "Backspace").length === 2,
      "f1. 仍然先试过真实 Backspace(不是一上来就赋值)");
    assert(res.ok === true && res.clearedVia === "direct", "f2. 按键清不掉时回执 clearedVia=direct(走了兜底)");
    assert(el.value === "", "f3. 兜底把值清空(经原型 setter, 受控组件追踪器不被打乱)");
    assert(el.dispatched.indexOf("input") >= 0, "f4. 兜底后派发 input, 页面感知到值变化");
  }

  // ================= ⑥ 死代码已清 =================
  {
    const src = fs.readFileSync(path.join(ROOT, "bridge-client.js"), "utf8");
    assert(!/function bridgeSafeValue/.test(src),
      "d1. bridgeSafeValue 已删(它带着同一个 JSON.stringify 缺陷且从未被调用)");
    assert(/const BRIDGE_KEYS = \{/.test(src), "d2. 按键表集中在一处(单源)");
    assert((src.match(/BRIDGE_KEYS\.(enter|backspace)/g) || []).length === 2,
      "d3. 提交与清空都走按键表, 不再各写一份字面量");
  }

  console.log(`\n=== check_page_eval_press: ${fail === 0 ? "PASS" : "FAIL"} (${pass}/${pass + fail}) ===`);
  process.exit(fail === 0 ? 0 : 1);
})();
