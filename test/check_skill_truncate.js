// check_skill_truncate.js —— v1.0.12 skill 路径截断明示回归:
//   1. runSelectedSkill 状态栏: 超上限条数带"只发前 N 条"提示(不静默)
//   2. 完成态带"LLM 实际分析前 N 条"(与 README 截断明示承诺一致)
//   3. 未超上限不带截断尾巴(不误标)
//   4. prompt 内部截断声明仍在(user 消息"只取前 60 条")
//   5. SKILL_MAX 与 aireport.js 各 prompt 内 maxEntries 默认值一致性(声明即实现)
//   6. diag 环形缓冲边界: 512KB 上限裁剪 + 双上限 + getDiagLog 500 视图
const fs = require('fs'); const vm = require('vm'); const path = require('path');
const ROOT = require('path').resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  OK ' + m); } else { fail++; console.log('  ✗ FAIL ' + m); } };

// ---- 1-4: sidepanel realm ----
const elements = new Map();
const mkEl = (id) => { if (elements.has(id)) return elements.get(id);
  const el = { id, style: {}, dataset: {}, children: [], value: '', textContent: '', innerHTML: '', className: '', checked: true, disabled: false,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } }, addEventListener() {}, appendChild() {}, setAttribute(k, v) { this[k === "aria-label" ? "ariaLabel" : k] = v; }, insertBefore() {},
    querySelector() { return mkEl(id + '_q'); }, querySelectorAll() { return []; }, scrollIntoView() {}, onclick: null };
  elements.set(id, el); return el; };
const documentObj = { getElementById: (id) => mkEl(id), createElement: () => mkEl('a' + Math.random()), createDocumentFragment: () => mkEl('f'), querySelectorAll: () => [], body: mkEl('body') };
const storageData = new Map();
const chromeStub = {
  storage: { local: {
    get: (keys, cb) => { const r = {}; for (const k of [].concat(keys)) r[k] = storageData.get(k); if (typeof cb === 'function') setTimeout(() => cb(r), 0); return Promise.resolve(r); },
    set: (obj, cb) => { for (const k of Object.keys(obj)) storageData.set(k, obj[k]); setTimeout(() => cb && cb(), 0); return Promise.resolve(); },
    remove: (keys, cb) => { setTimeout(() => cb && cb(), 0); return Promise.resolve(); } },
    onChanged: { addListener() {} } },
  runtime: { sendMessage: async () => ({ ok: true, recState: 'idle', count: 0, pending: 0, attachedTabs: 0, domains: [], unmatched: [], harvestCorrupt: false }), openOptionsPage() {} },
  tabs: { query: async () => [{ id: 1, url: 'https://a.b.com/x' }] }, scripting: { executeScript: async () => [{ result: { status: 200, ok: true, text: '{}' } }] },
  sidePanel: {}, permissions: { contains: (p, cb) => cb(true), request: (p, cb) => cb(true) } };
const sandbox = { console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, URL, URLSearchParams, AbortController, Date,
  navigator: { clipboard: { writeText: async () => {} } }, document: documentObj, chrome: chromeStub, performance: { now: () => Date.now() }, fetch: async () => { throw new Error('nf'); } };
sandbox.window = sandbox; sandbox.globalThis = sandbox; vm.createContext(sandbox);
const html = fs.readFileSync(path.join(ROOT, 'sidepanel/sidepanel.html'), 'utf8');
for (const m of html.matchAll(/<script src="([^"]+)"><\/script>/g)) {
  const f = path.resolve(path.join(ROOT, 'sidepanel'), m[1]);
  new vm.Script(fs.readFileSync(f, 'utf8'), { filename: f }).runInContext(sandbox);
}
const mkEntries = (n) => Array.from({ length: n }, (_, i) => ({ id: 'e' + i, method: 'GET', url: 'https://a.b.com/p' + i, path: '/p' + i, query: '', headers: {}, body: '', status: 200, response: '{}', mime: '', ts: new Date(Date.now() + i).toISOString() }));

(async () => {
  vm.runInContext('callLlm = async (msgs, opts) => { __cap = msgs; return { ok: true, content: "R" }; }', sandbox);

  // 100 条 report: 开始态+完成态都明示
  sandbox.__big = mkEntries(100);
  vm.runInContext('entries = __big; document.getElementById("skillSel").value = "report"; runSelectedSkill()', sandbox);
  await new Promise((r) => setTimeout(r, 30));
  const cap = vm.runInContext('__cap', sandbox);
  const userMsg = cap.find((m) => m.role === 'user').content;
  ok(userMsg.includes('只取前 60 条'), 'prompt 内截断声明(100→60)');
  const done1 = elements.get('expMsg').textContent;
  ok(done1.includes('LLM 实际分析前 60 条'), '完成态明示 LLM 实际分析数');

  // 30 条: 无截断尾巴
  sandbox.__small = mkEntries(30);
  vm.runInContext('entries = __small; runSelectedSkill()', sandbox);
  await new Promise((r) => setTimeout(r, 30));
  const done2 = elements.get('expMsg').textContent;
  ok(!done2.includes('LLM 实际'), '未超上限不带截断尾巴');

  // chain 40 上限
  sandbox.__big2 = mkEntries(50);
  vm.runInContext('entries = __big2; document.getElementById("skillSel").value = "chain"; runSelectedSkill()', sandbox);
  await new Promise((r) => setTimeout(r, 30));
  const cap2 = vm.runInContext('__cap', sandbox);
  const userMsg2 = cap2.find((m) => m.role === 'user').content;
  ok(userMsg2.includes('只取前 40 条'), 'chain prompt 截断声明(50→40)');

  // ---- 5: SKILL_MAX vs aireport 默认值一致性 ----
  const spSrc = fs.readFileSync(path.join(ROOT, 'sidepanel/sidepanel.js'), 'utf8');
  const aiSrc = fs.readFileSync(path.join(ROOT, 'aireport.js'), 'utf8');
  const skillMax = spSrc.match(/const SKILL_MAX = \{([^}]+)\}/)[1];
  const get = (s, k) => new RegExp(k + '\\s*:\\s*(\\d+)').exec(s);
  const expectations = [['report', 'buildReportPrompt'], ['chain', 'buildChainPrompt'], ['doc', 'buildDocPrompt'], ['inventory', 'buildInventoryPrompt'], ['sensitive', 'buildSensitiveScanPrompt']];
  for (const [key, fn] of expectations) {
    const inSkill = Number(new RegExp(key + '\\s*:\\s*(\\d+)').exec(skillMax)[1]);
    const fnBody = aiSrc.match(new RegExp('function ' + fn + '[\\s\\S]*?\\n}'))[0];
    const m = fnBody.match(/opts\.maxEntries \?\? (\d+)/);
    const inPrompt = m ? Number(m[1]) : (fnBody.match(/slice\(0, (\d+)\)/) ? null : null);
    ok(m && Number(m[1]) === inSkill, `SKILL_MAX.${key}(${inSkill}) = ${fn} 默认(${m ? m[1] : '?'})`);
  }

  // ---- 6: diag 环形缓冲边界 ----
  const mem = {}; const listeners = {};
  function on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); }
  const bgSandbox = { console, setTimeout, clearTimeout, Date, URL, URLSearchParams, Promise,
    chrome: {
      storage: { local: {
        get: (keys, cb) => { const out = {}; if (Array.isArray(keys)) { for (const k of keys) if (k in mem) out[k] = mem[k]; } else if (typeof keys === 'string') out[keys] = mem[keys]; else Object.assign(out, mem); if (cb) cb(out); return Promise.resolve(out); },
        set: (obj, cb) => { Object.assign(mem, obj); if (cb) cb(); return Promise.resolve(); },
        remove: (keys, cb) => { if (cb) cb(); return Promise.resolve(); } },
        onChanged: { addListener() {} } },
      runtime: { onInstalled: { addListener(fn) { on('installed', fn); } }, onMessage: { addListener(fn) { on('message', fn); } } },
      debugger: { onDetach: { addListener(fn) { on('detach', fn); } }, onEvent: { addListener(fn) { on('event', fn); } }, attach: async () => {}, detach: async () => {}, sendCommand: async () => ({ body: '{}', base64Encoded: false }) },
      alarms: { onAlarm: { addListener() {} }, create: async () => {}, clear: async () => {} },
      action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
      tabs: { onRemoved: { addListener() {} } },
      permissions: { contains: async () => false } } };
  bgSandbox.window = bgSandbox; bgSandbox.globalThis = bgSandbox; vm.createContext(bgSandbox);
  new vm.Script(fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8'), { filename: 'background.js' }).runInContext(bgSandbox);
  // 2000 条 490 字符 → 字节上限先裁(512KB), 条数 < 1000
  vm.runInContext(`for (let i = 0; i < 2000; i++) diag('info', 'test', '${'y'.repeat(490)}' + i)`, bgSandbox);
  const st = JSON.parse(vm.runInContext('JSON.stringify({ n: diagEntries.length, bytes: diagBytes })', bgSandbox));
  ok(st.bytes <= 512 * 1024, `字节上限裁剪生效(${st.bytes} ≤ 524288)`);
  ok(st.n < 1000, `大消息场景条数被字节上限先裁(${st.n} < 1000)`);
  // 1000 条小消息 → 条数上限生效
  vm.runInContext('diagEntries.length = 0; diagBytes = 0', bgSandbox);
  vm.runInContext(`for (let i = 0; i < 3000; i++) diag('info', 't', 'm' + i)`, bgSandbox);
  const st2 = JSON.parse(vm.runInContext('JSON.stringify({ n: diagEntries.length })', bgSandbox));
  ok(st2.n <= 1000, `小消息场景条数上限生效(${st2.n} ≤ 1000)`);
  // getDiagLog 视图 ≤ 500
  const msg = (type, payload) => new Promise((resolve) => {
    let responded = false;
    const sr = (v) => { if (!responded) { responded = true; resolve(v); } };
    const ret = listeners['message'][0]({ type, ...payload }, {}, sr);
    if (ret !== true && !responded) resolve(undefined);
  });
  const r = await msg('getDiagLog');
  ok(Array.isArray(r.log) && r.log.length <= 500, `getDiagLog 视图上限(${r.log.length} ≤ 500)`);
  // FIFO 语义: 最新的留下
  ok(r.log.length === 500 && r.log[499].message === 'm2999', '环形裁剪保最新(FIFO)');
  // —— v1.0.54 diag 补充边界 ——
  // 7a. message 500 截断: 超 500 的消息被 slice(500), 诊断内存不受单条超大消息影响
  vm.runInContext('diagEntries.length = 0; diagBytes = 0; diag("warn", "t", "z".repeat(600))', bgSandbox);
  const m500 = vm.runInContext('diagEntries[diagEntries.length-1].message.length', bgSandbox);
  ok(m500 === 500, `单条消息 slice 500(实得 ${m500})`);
  // 7b. 怪形态 message(循环引用对象)不炸: JSON.stringify 在 diag 内抛 TypeError →
  //     catch 吞 → 主流程不受影响("诊断自身永不影响主流程"承诺)。String() 先跑所以
  //     普通对象不炸, 循环引用对象过 String() 也不炸( '[object Object]' ), 炸点在
  //     字节统计的 JSON.stringify —— 必须由 diag 的 try/catch 兜住。
  let threw = false;
  try {
    vm.runInContext('(function(){ const c = {}; c.self = c; diag("info", "test", c); })()', bgSandbox);
  } catch (e) { threw = true; }
  ok(!threw, '循环引用 message 不炸(catch 兜住)');
  vm.runInContext('diag("info", "test", "after-circular-ok")', bgSandbox);
  const nAfter = vm.runInContext('diagEntries.length', bgSandbox);
  const lastIsAfter = vm.runInContext('diagEntries[diagEntries.length-1].message', bgSandbox) === 'after-circular-ok';
  ok(nAfter >= 2 && lastIsAfter, `怪形态后 diag 继续工作(实得 ${nAfter} 条, 末条是新消息)`);

  console.log(fail ? `\n=== skill 截断/diag 边界 FAIL: ${fail} ===` : `\n=== skill 截断/diag 边界 PASS ===`);
  process.exit(fail ? 1 : 0);
})();
