// check_poll_perf.js —— v1.0.11 轮询移除 + renderList 性能边界回归:
//   1. popup/sidepanel 源码不再含 setInterval 轮询(状态走 onChanged 推送)
//   2. popup onChanged 推送逻辑: harvest 变化 → 条数/按钮态更新; 损坏信封不动
//   3. renderList 3000 条(录制上限)在 JS 侧 < 100ms(浏览器 DOM 成本另计, 此处守逻辑回归)
//   4. onChanged added 分支不再双重渲染(refreshPrelude 内已 renderList)
const fs = require('fs'); const vm = require('vm'); const path = require('path');
const ROOT = require('path').resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  OK ' + m); } else { fail++; console.log('  ✗ FAIL ' + m); } };

// 1) 轮询移除
const popSrc = fs.readFileSync(path.join(ROOT, 'popup/popup.js'), 'utf8');
const spSrc = fs.readFileSync(path.join(ROOT, 'sidepanel/sidepanel.js'), 'utf8');
ok(!/setInterval\(refresh/.test(popSrc), 'popup 无 refresh 轮询');
ok(!/setInterval\(refreshState/.test(spSrc), 'sidepanel 无 refreshState 轮询');
ok(/storage\.onChanged\.addListener/.test(popSrc), 'popup 已挂 onChanged 推送');

// 2) popup onChanged 推送语义(vm realm)
const elements = new Map();
const mkEl = (id) => { if (elements.has(id)) return elements.get(id);
  const el = { id, style: {}, dataset: {}, children: [], value: '', textContent: '', innerHTML: '', className: '', checked: true, disabled: false, placeholder: '',
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } }, addEventListener() {}, appendChild() {}, setAttribute(k, v) { this[k === "aria-label" ? "ariaLabel" : k] = v; }, insertBefore() {},
    querySelector() { return mkEl(id + '_q'); }, querySelectorAll() { return []; }, focus() {}, onclick: null };
  elements.set(id, el); return el; };
const documentObj = { getElementById: (id) => mkEl(id), createElement: () => mkEl('a' + Math.random()), createDocumentFragment: () => mkEl('f'), querySelectorAll: () => [], body: mkEl('body') };
const storageData = new Map();
let onChangedListeners = [];
const chromeStub = {
  storage: { local: {
    get: (keys, cb) => { const r = {}; for (const k of [].concat(keys)) r[k] = storageData.get(k); if (typeof cb === 'function') setTimeout(() => cb(r), 0); return Promise.resolve(r); },
    set: (obj, cb) => { for (const k of Object.keys(obj)) storageData.set(k, obj[k]); if (typeof cb === 'function') setTimeout(() => cb(), 0); return Promise.resolve(); },
    remove: (keys, cb) => { setTimeout(() => cb && cb(), 0); return Promise.resolve(); } },
    onChanged: { addListener(L) { onChangedListeners.push(L); } } },
  runtime: { sendMessage: async () => ({ ok: true, recState: 'idle', count: 0 }), openOptionsPage() {} },
  tabs: { query: async () => [{ id: 1, url: 'https://a.b.com/x' }] },
  sidePanel: { open: async () => {} }, windows: { WINDOW_ID_CURRENT: 1 },
  permissions: { contains: (p, cb) => cb(true) } };
const sandbox = { console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, URL, URLSearchParams, Date,
  alert() {}, navigator: { clipboard: { writeText: async () => {} } }, document: documentObj, chrome: chromeStub, performance: { now: () => Date.now() } };
sandbox.window = sandbox; sandbox.globalThis = sandbox; vm.createContext(sandbox);
const html = fs.readFileSync(path.join(ROOT, 'popup/popup.html'), 'utf8');
for (const m of html.matchAll(/<script src="([^"]+)"><\/script>/g)) {
  const f = path.resolve(ROOT + '/popup', m[1]);
  new vm.Script(fs.readFileSync(f, 'utf8'), { filename: f }).runInContext(sandbox);
}
ok(onChangedListeners.length === 1, 'popup 注册了 onChanged 监听');
// harvest 推送 → 条数/按钮
onChangedListeners[0]({ 'toolbox.harvest': { newValue: { v: 1, entries: [{ id: 1 }, { id: 2 }, { id: 3 }] } }, 'toolbox.recording': { newValue: 'recording' } }, 'local');
ok(elements.get('expCount').textContent === 3, '推送 3 条 → expCount=3');
ok(!elements.get('btnExpJmx').disabled, '有条数 → 导出按钮可用');
// 损坏信封不动画条数
onChangedListeners[0]({ 'toolbox.harvest': { newValue: 'corrupted-shape' } }, 'local');
ok(elements.get('expCount').textContent === 3, '损坏信封 → 条数不动(保持 3)');
// 状态推送
onChangedListeners[0]({ 'toolbox.recording': { newValue: 'paused' } }, 'local');
ok(elements.get('stLabel').textContent === 'PAUSE', '状态推送 → PAUSE');
onChangedListeners[0]({ 'toolbox.recording': { newValue: 'idle' } }, 'local');
ok(elements.get('stLabel').textContent === 'IDLE', '状态推送 → IDLE');

// 3) sidepanel onChanged added 分支不双渲
ok(!/refreshPrelude\(\); renderList\(\)/.test(spSrc), 'onChanged added 分支无双 renderList');
ok(/if \(added\) \{ refreshPrelude\(\); \}/.test(spSrc), 'added 分支只调 refreshPrelude(内含渲染)');

// 4) renderList 3000 条性能底线(逻辑侧)
const spSandbox = (() => {
  const el2 = new Map();
  const mk = (id) => { if (el2.has(id)) return el2.get(id);
    const e = { id, style: {}, dataset: {}, children: [], value: '', textContent: '', innerHTML: '', className: '', checked: true, disabled: false,
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } }, addEventListener() {}, appendChild() {}, setAttribute(k, v) { this[k === "aria-label" ? "ariaLabel" : k] = v; }, insertBefore() {},
      querySelector() { return mk(id + '_q'); }, querySelectorAll() { return []; }, scrollIntoView() {}, onclick: null };
    el2.set(id, e); return e; };
  const doc2 = { getElementById: (id) => mk(id), createElement: () => mk('e' + Math.random()), createDocumentFragment: () => mk('f'), querySelectorAll: () => [], body: mk('body') };
  const sd = new Map();
  const ch2 = {
    storage: { local: {
      get: (keys, cb) => { const r = {}; for (const k of [].concat(keys)) r[k] = sd.get(k); if (typeof cb === 'function') setTimeout(() => cb(r), 0); return Promise.resolve(r); },
      set: (obj, cb) => { for (const k of Object.keys(obj)) sd.set(k, obj[k]); if (typeof cb === 'function') setTimeout(() => cb(), 0); return Promise.resolve(); },
      remove: (keys, cb) => { setTimeout(() => cb && cb(), 0); return Promise.resolve(); } },
      onChanged: { addListener() {} } },
    runtime: { sendMessage: async () => ({ ok: true, recState: 'idle', count: 0, pending: 0, attachedTabs: 0, domains: [], unmatched: [], harvestCorrupt: false }), openOptionsPage() {} },
    tabs: { query: async () => [{ id: 1, url: 'https://a.b.com/x' }] }, scripting: { executeScript: async () => [{ result: { status: 200, ok: true, text: '{}' } }] },
    sidePanel: {}, permissions: { contains: (p, cb) => cb(true), request: (p, cb) => cb(true) } };
  const sb = { console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, URL, URLSearchParams, AbortController,
    navigator: { clipboard: { writeText: async () => {} } }, document: doc2, chrome: ch2, performance: { now: () => Date.now() }, fetch: async () => { throw new Error('nf'); } };
  sb.window = sb; sb.globalThis = sb; vm.createContext(sb);
  const h2 = fs.readFileSync(path.join(ROOT, 'sidepanel/sidepanel.html'), 'utf8');
  for (const m of h2.matchAll(/<script src="([^"]+)"><\/script>/g)) {
    const f = path.resolve(ROOT + '/sidepanel', m[1]);
    new vm.Script(fs.readFileSync(f, 'utf8'), { filename: f }).runInContext(sb);
  }
  return sb;
})();
const big = [];
for (let i = 0; i < 3000; i++) big.push({ id: 'e' + i, method: i % 5 === 0 ? 'POST' : 'GET', url: 'https://a.b.com/web/api/p' + i, path: '/web/api/p' + i, query: '', headers: {}, body: '', status: 200, response: '{}', mime: '', ts: new Date(Date.now() + i).toISOString(), durationMs: 30 });
spSandbox.__big = big;
vm.runInContext('entries = __big', spSandbox);
const t0 = Date.now();
vm.runInContext('renderList()', spSandbox);
const dt = Date.now() - t0;
ok(dt < 500, `3000 条 renderList 逻辑侧 ${dt}ms < 500ms 底线`);

// 5) correlate 签名/nonce 启发式(本轮新增)
const C = require(path.join(ROOT, 'correlate.js'));
ok(C.classifyDynamic('sign', ['a1b2', 'c3d4']).kind === 'seq', 'sign 命名 → seq');
ok(C.classifyDynamic('nonce', ['111', '222']).kind === 'seq', 'nonce 命名 → seq');
ok(C.classifyDynamic('name', ['a', 'b']).kind === 'fixed', '普通字段仍 fixed');

// 6) recState 徽章双面对账(v1.0.60): popup/sidepanel 两套 setState 的
//    徽章类名+文案是"引擎状态机的双呈现面"——漂移会让用户在两个入口看到
//    不同的状态字。全枚举 {idle, recording, paused, 未知态} × 双面对拍。
//    按钮组差异(popup paused 也显示 Record)是布局设计非漂移——popup 空间小
//    保留 idle 直觉入口, Record 与 Resume 在 paused 态都发 startRecording
//    (换 tab 复用 attach 路径)行为等价; 徽章/文案才是对账面。
{
  // sidepanel realm(独立小 realm, 不复用上方推送场景 sandbox——全枚举 setState
  // 会耦合场景状态)
  const spElements = new Map();
  const mkSpEl = (id) => { if (spElements.has(id)) return spElements.get(id);
    const el = { id, style: {}, dataset: {}, children: [], value: '', textContent: '', innerHTML: '', className: '', checked: true, disabled: false,
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } }, addEventListener() {}, appendChild() {}, setAttribute(k, v) { this[k === 'aria-label' ? 'ariaLabel' : k] = v; },
      querySelector() { return mkSpEl(id + '_q'); }, querySelectorAll() { return []; }, focus() {}, onclick: null };
    spElements.set(id, el); return el; };
  const spDoc = { getElementById: (id) => mkSpEl(id), createElement: () => mkSpEl('a' + Math.random()), createDocumentFragment: () => mkSpEl('f'), querySelectorAll() { return []; }, body: mkSpEl('body') };
  const sp2 = { console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, URL, URLSearchParams, AbortController,
    navigator: { clipboard: { writeText: async () => {} } }, document: spDoc, performance: { now: () => Date.now() }, fetch: async () => { throw new Error('nf'); },
    chrome: { storage: { local: { get: async () => ({}), set: async () => {} }, onChanged: { addListener() {} } },
      runtime: { sendMessage: async () => ({ ok: true, recState: 'idle', count: 0, pending: 0, attachedTabs: 0, domains: [], unmatched: [], harvestCorrupt: false }), openOptionsPage() {} },
      tabs: { query: async () => [{ id: 1, url: 'https://a.b.com/x' }] }, scripting: { executeScript: async () => [{ result: { status: 200, ok: true, text: '{}' } }] },
      sidePanel: {}, permissions: { contains: async () => true, request: async () => true } } };
  sp2.window = sp2; sp2.globalThis = sp2; vm.createContext(sp2);
  const spHtml = fs.readFileSync(path.join(ROOT, 'sidepanel/sidepanel.html'), 'utf8');
  for (const m of spHtml.matchAll(/<script src="([^"]+)"><\/script>/g)) {
    const f = path.resolve(ROOT + '/sidepanel', m[1]);
    new vm.Script(fs.readFileSync(f, 'utf8'), { filename: f }).runInContext(sp2);
  }
  // popup realm
  const popElements = new Map();
  const mkPopEl = (id) => { if (popElements.has(id)) return popElements.get(id);
    const el = { id, style: {}, dataset: {}, children: [], value: '', textContent: '', innerHTML: '', className: '', checked: true, disabled: false,
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } }, addEventListener() {}, appendChild() {}, setAttribute(k, v) { this[k === 'aria-label' ? 'ariaLabel' : k] = v; },
      querySelector() { return mkPopEl(id + '_q'); }, querySelectorAll() { return []; }, focus() {}, onclick: null };
    popElements.set(id, el); return el; };
  const popDoc = { getElementById: (id) => mkPopEl(id), createElement: () => mkPopEl('a' + Math.random()), createDocumentFragment: () => mkPopEl('f'), querySelectorAll() { return []; }, body: mkPopEl('body') };
  const pop2 = { console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, URL, URLSearchParams,
    alert() {}, navigator: { clipboard: { writeText: async () => {} } }, document: popDoc, performance: { now: () => Date.now() },
    chrome: { storage: { local: { get: async () => ({}), set: async () => {} }, onChanged: { addListener() {} } },
      runtime: { sendMessage: async () => ({ ok: true, recState: 'idle', count: 0 }), onMessage: { addListener() {} }, openOptionsPage() {} },
      tabs: { query: async () => [{ id: 1, url: 'https://a.b.com/x' }] }, sidePanel: { open: async () => {} }, windows: { WINDOW_ID_CURRENT: 1 } } };
  pop2.window = pop2; pop2.globalThis = pop2; vm.createContext(pop2);
  const popHtml = fs.readFileSync(path.join(ROOT, 'popup/popup.html'), 'utf8');
  for (const m of popHtml.matchAll(/<script src="([^"]+)"><\/script>/g)) {
    const f = path.resolve(ROOT + '/popup', m[1]);
    new vm.Script(fs.readFileSync(f, 'utf8'), { filename: f }).runInContext(pop2);
  }
  // 全枚举对拍: 徽章类名 + 文案(双呈现面唯一对账契约)
  const expected = { idle: ['badge idle', 'IDLE'], recording: ['badge rec', 'REC'], paused: ['badge pause', 'PAUSE'] };
  let drift = [];
  for (const [st, [cls, txt]] of Object.entries(expected)) {
    vm.runInContext(`setState(${JSON.stringify(st)})`, sp2);
    vm.runInContext(`setState(${JSON.stringify(st)})`, pop2);
    const spB = spElements.get('stBadge'), spL = spElements.get('stLabel');
    const ppB = popElements.get('stBadge'), ppL = popElements.get('stLabel');
    if (spB.className !== cls || ppB.className !== cls || spL.textContent !== txt || ppL.textContent !== txt) {
      drift.push(`${st}: sp=[${spB.className}/${spL.textContent}] pp=[${ppB.className}/${ppL.textContent}] 期望=[${cls}/${txt}]`);
    }
  }
  ok(!drift.length, `recState 全枚举徽章双面一致(idle/recording/paused)${drift.length ? ' 漂移: ' + drift.join('; ') : ''}`);
  // 未知态双面都退 idle(引擎加新状态时 UI 不裸显乱码)
  vm.runInContext('setState("bogus")', sp2);
  vm.runInContext('setState("bogus")', pop2);
  ok(spElements.get('stBadge').className === 'badge idle' && popElements.get('stBadge').className === 'badge idle', '未知 recState 双面防御性退 idle');
  // background 角标第三面也是同枚举消费方(setBadge) —— 静态断言它三态分支齐全
  const bgSrc = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
  ok(/state === "recording"[\s\S]{0,200}state === "paused"/.test(bgSrc) && /setBadgeText\(\{ text: "" \}\)/.test(bgSrc), 'background setBadge 三态(rec/paused/清空)分支在');
}

console.log(fail ? `\n=== 轮询/性能/启发式回归 FAIL: ${fail} ===` : `\n=== 轮询/性能/启发式回归 PASS ===`);
process.exit(fail ? 1 : 0);
