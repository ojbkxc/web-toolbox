// 验证 manualPrelude 持久化: togglePrelude -> storage 写入; 重开 realm(loadHarvest)后还原。
const fs = require('fs');
const ROOT = require('path').resolve(__dirname, '..');
const vm = require('vm');
const path = require('path');

const storageData = new Map();
const changeListeners = [];
const elements = new Map();
const storageLocal = {
  get: (keys, cb) => { const r = {}; for (const k of [].concat(keys)) r[k] = storageData.get(k); const p = Promise.resolve(r); if (typeof cb === 'function') setTimeout(() => cb(r), 0); return p; },
  set: (obj, cb) => { const changes = {}; for (const k of Object.keys(obj)) { changes[k] = { newValue: obj[k] }; storageData.set(k, obj[k]); } const p = Promise.resolve(); setTimeout(() => { for (const L of changeListeners) L(changes, 'local'); cb && cb(); }, 0); return p; },
  remove: (keys, cb) => { for (const k of [].concat(keys)) storageData.delete(k); const p = Promise.resolve(); setTimeout(() => cb && cb(), 0); return p; },
};
const mkEl = (id) => { if (elements.has(id)) return elements.get(id);
  const el = { id, style: {}, dataset: {}, children: [], value: '', textContent: '', innerHTML: '', className: '', checked: true, disabled: false,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {}, appendChild() {}, setAttribute(k, v) { this[k === "aria-label" ? "ariaLabel" : k] = v; }, insertBefore() {}, querySelector() { return mkEl(id + '_q'); }, querySelectorAll() { return []; }, scrollIntoView() {}, onclick: null };
  elements.set(id, el); return el; };
const documentObj = { getElementById: (id) => mkEl(id), createElement: () => mkEl('a' + Math.random()), createDocumentFragment: () => mkEl('f'), querySelectorAll() { return []; }, body: mkEl('body') };

// 条目: 无登录特征(path 无 login/token), auto 不会标前置
const E1 = { id: 'r1', method: 'POST', url: 'https://app.b.com/web/ctxInit', path: '/web/ctxInit', query: '', headers: {}, body: '{}', status: 200, response: '{}', mime: 'application/json', ts: '2026-09-17T08:00:00Z' };
const E2 = { id: 'r2', method: 'GET', url: 'https://app.b.com/list', path: '/list', query: '', headers: {}, body: null, status: 200, response: '{}', mime: 'application/json', ts: '2026-09-17T08:00:01Z' };
// SSO 条目(auto 必命中): 优先级断言用 —— manual=false 要能镇住 auto 的勾选
const E_SSO = { id: 'r9', method: 'GET', url: 'https://app.b.com/cas/sso/login', path: '/cas/sso/login', query: '', headers: {}, body: null, status: 200, response: '{}', mime: 'text/html', ts: '2026-09-17T08:00:02Z' };
storageData.set('toolbox.harvest', { v: 1, entries: [E1, E2, E_SSO] });

const chromeStub = {
  storage: { local: storageLocal, onChanged: { addListener(L) { changeListeners.push(L); } } },
  runtime: { sendMessage: async () => ({ ok: true, recState: 'idle', count: 2, domains: ['b.com'] }), openOptionsPage() {} },
  tabs: { query: async () => [{ id: 101, url: 'https://app.b.com/page' }] },
  permissions: { contains: async () => true },
};

function makeSandbox() {
  const sb = { console, setTimeout, setInterval: () => 0, clearInterval() {}, URL, URLSearchParams,
    fetch: async () => { throw new Error('no fetch'); },
    navigator: { clipboard: { writeText: async () => {} } }, document: documentObj, chrome: chromeStub, performance: { now: () => Date.now() } };
  sb.window = sb; sb.globalThis = sb;
  vm.createContext(sb);
  const html = fs.readFileSync(ROOT + '/sidepanel/sidepanel.html', 'utf8');
  for (const m of html.matchAll(/<script src="([^"]+)"><\/script>/g)) {
    const f = path.resolve(ROOT + '/sidepanel', m[1]);
    new vm.Script(fs.readFileSync(f, 'utf8'), { filename: f }).runInContext(sb);
  }
  return sb;
}

const assert = (cond, msg) => { if (!cond) { console.log('FAIL: ' + msg); process.exit(1); } console.log('  OK ' + msg); };

(async () => {
  // 第一段会话: 手动勾 r1 为前置
  const sb1 = makeSandbox();
  await new Promise(r => setTimeout(r, 30));
  assert(vm.runInContext('!preludeIds.has("r1") && !preludeIds.has("r2")', sb1) === true, '1. r1/r2 无登录特征, 不自动标前置(r9 SSO 命中是对照项)');
  vm.runInContext('togglePrelude("r1")', sb1);
  assert(vm.runInContext('preludeIds.has("r1")', sb1) === true, '2. 手动勾 r1 为前置');
  await new Promise(r => setTimeout(r, 20));
  const saved = storageData.get('toolbox.manualPrelude');
  assert(Array.isArray(saved) && saved.length === 1 && saved[0][0] === 'r1' && saved[0][1] === true,
    '3. manualPrelude 已持久化: ' + JSON.stringify(saved));

  // 第二段会话(侧栏重开): 前置标记应还原
  elements.clear();
  const sb2 = makeSandbox();
  await new Promise(r => setTimeout(r, 30));
  assert(vm.runInContext('preludeIds.has("r1")', sb2) === true, '4. 重开侧栏后手动前置还原(不丢)');
  assert(vm.runInContext('preludeIds.has("r2")', sb2) === false, '5. 未勾的条目不误标');

  // 取消勾选再重开
  vm.runInContext('togglePrelude("r1")', sb2);
  await new Promise(r => setTimeout(r, 20));
  assert(vm.runInContext('preludeIds.has("r1")', sb2) === false, '6. 取消勾选生效');
  const saved2 = storageData.get('toolbox.manualPrelude');
  assert(Array.isArray(saved2) && saved2.length === 1 && saved2[0][1] === false,
    '7. 取消也持久化(强制非前置): ' + JSON.stringify(saved2));
  elements.clear();
  const sb3 = makeSandbox();
  await new Promise(r => setTimeout(r, 30));
  assert(vm.runInContext('preludeIds.has("r1")', sb3) === false, '8. 重开后强制非前置仍生效(auto 不会重新勾上)');

  // 优先级断言(v1.0.64, #157 方向②): manual 与 auto 冲突时 manual 赢, 且 auto 重扫(refreshPrelude)不覆盖。
  // E_SSO(/cas/sso/login)是 auto 必命中条目 —— manual=false 要能镇住它; 反向 manual=true
  // 要能把非登录条目拉进前置。既有断言只覆盖「无登录特征条目」的持久化, 优先级是零断言:
  // refreshPrelude 的合并序(manual===true > manual===false > auto)漂移即静默错勾/漏勾。
  elements.clear();
  const sb4 = makeSandbox();
  await new Promise(r => setTimeout(r, 30));
  assert(vm.runInContext('preludeIds.has("r9")', sb4) === true, '9. SSO 条目 auto 命中(对照项: 无 manual 时 auto 生效)');
  vm.runInContext('togglePrelude("r9")', sb4);   // r9 当前前置 → 切成强制非前置
  vm.runInContext('togglePrelude("r2")', sb4);   // r2 非登录 → 切成强制前置
  vm.runInContext('refreshPrelude()', sb4);      // auto 重扫 —— manual 优先级在此验证
  assert(vm.runInContext('preludeIds.has("r9")', sb4) === false, '10. manual=false 镇住 auto 命中(SSO 条目不被重扫复活)');
  assert(vm.runInContext('preludeIds.has("r2")', sb4) === true, '11. manual=true 强制非登录条目为前置(refreshPrelude 不撤销)');
  assert(vm.runInContext('preludeIds.has("r1")', sb4) === false, '12. 无 manual 无 auto 的条目保持非前置(合并不放空炮)');

  console.log('');
  console.log('=== manualPrelude 持久化 PASS ===');
})();
