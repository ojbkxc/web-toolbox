// 验证 AI 断言解析修复: extractChainJson 返回数组, 不再 JSON.parse 包一层。
const fs = require('fs'), vm = require('vm'), path = require('path');
const ROOT = require('path').resolve(__dirname, '..');

// 纯函数级: extractChainJson("...[{...}]...") 已是解析后数组
const A = require(ROOT + '/aireport.js');
const raw = '```json\n[{"type":"status","target":"200"},{"type":"contains","target":"\\"resultCode\\":\\"0\\""}]\n```';
const arr = A.extractChainJson(raw);
if (!Array.isArray(arr) || arr.length !== 2) { console.log('FAIL extractChainJson 应返回数组'); process.exit(1); }
console.log('  OK extractChainJson 直接返回解析后数组');

// 逐起点解析鲁棒性(v1.0.13): 原版 indexOf('[')+lastIndexOf(']') 一次切片,
// 前文引用标号/尾部附注方括号会把切片窗口挤歪 → 整条链静默丢。
const cases = [
  ['见[1]说明: [{"from":2}]', 1, '前文 [1] 引用不被截胡'],
  ['[{"from":1}] 详见附注[2]', 1, '尾部附注 [2] 不拖走终点'],
  ['好的: ```\n[{"from":1}]\n```\n以上', 1, '无标注围栏+前后废话'],
  ['废话 [{"from":1', 0, '截断 JSON → 空'],
  ['[3]', 0, '纯数字数组(引用标号形态) → 跳过继续找/空'],
];
for (const [input, n, msg] of cases) {
  const got = A.extractChainJson(input).length;
  if (got !== n) { console.log(`FAIL ${msg}: 期望 ${n} 实得 ${got}`); process.exit(1); }
  console.log('  OK ' + msg);
}
// 端到端: validateChain(对象过滤后) 正常吃逐起点产物
const v = A.validateChain(A.extractChainJson('见[1]: [{"from":1,"to":2,"var":"v"}]'));
if (v.length !== 1 || v[0].var !== 'v') { console.log('FAIL validateChain 端到端: ' + JSON.stringify(v)); process.exit(1); }
console.log('  OK validateChain 端到端(引用标号场景链不丢)');

// sidepanel realm 级: aiBuildAsserts 流程中 r.content 含 ```json 数组时 map 应非空。
// callLlm 是全局 fetch —— stub 掉 getLlmConfig + fetch。
const storageData = new Map();
const elements = new Map();
const storageLocal = {
  get: (keys, cb) => { const r = {}; for (const k of [].concat(keys)) r[k] = storageData.get(k); const p = Promise.resolve(r); if (typeof cb === 'function') setTimeout(() => cb(r), 0); return p; },
  set: (obj, cb) => { for (const k of Object.keys(obj)) storageData.set(k, obj[k]); const p = Promise.resolve(); if (typeof cb === 'function') setTimeout(() => cb(), 0); return p; },
  remove: (keys, cb) => { const p = Promise.resolve(); if (typeof cb === 'function') setTimeout(() => cb(), 0); return p; },
};
storageData.set('toolbox.llm', { url: 'http://127.0.0.1:1/v1/chat/completions', model: 'm', api_key: '' });
const E1 = { id: 'r1', method: 'POST', url: 'https://app.b.com/web/create', path: '/web/create', query: '', headers: {}, body: '{}', status: 200, response: '{"resultCode":"0"}', mime: 'application/json', ts: '2026-09-17T08:00:00Z' };
storageData.set('toolbox.harvest', { v: 1, entries: [E1] });
const mkEl = (id) => { if (elements.has(id)) return elements.get(id);
  const el = { id, style: {}, dataset: {}, children: [], value: '', textContent: '', innerHTML: '', className: '', checked: true, disabled: false,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {}, appendChild() {}, setAttribute(k, v) { this[k === "aria-label" ? "ariaLabel" : k] = v; }, insertBefore() {}, querySelector() { return mkEl(id + '_q'); }, querySelectorAll() { return []; }, scrollIntoView() {}, onclick: null };
  elements.set(id, el); return el; };
const documentObj = { getElementById: (id) => mkEl(id), createElement: () => mkEl('a' + Math.random()), createDocumentFragment: () => mkEl('f'), querySelectorAll() { return []; }, body: mkEl('body') };
const chromeStub = { storage: { local: storageLocal, onChanged: { addListener() {} } }, runtime: { sendMessage: async () => ({ ok: true, recState: 'idle', count: 1 }), openOptionsPage() {} }, tabs: { query: async () => [{ id: 101, url: 'https://app.b.com/page' }] }, permissions: { contains: async () => true } };
const sb = { console, setTimeout, clearTimeout, AbortController, setInterval: () => 0, clearInterval() {}, URL, URLSearchParams,
  fetch: async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '```json\n[{"type":"status","target":"200"},{"type":"contains","target":"\\"resultCode\\":\\"0\\""}]\n```' } }] }) }),
  navigator: { clipboard: { writeText: async () => {} } }, document: documentObj, chrome: chromeStub, performance: { now: () => Date.now() } };
sb.window = sb; sb.globalThis = sb;
vm.createContext(sb);
const html = fs.readFileSync(ROOT + '/sidepanel/sidepanel.html', 'utf8');
for (const m of html.matchAll(/<script src="([^"]+)"><\/script>/g)) {
  const f = path.resolve(ROOT + '/sidepanel', m[1]);
  new vm.Script(fs.readFileSync(f, 'utf8'), { filename: f }).runInContext(sb);
}
(async () => {
  await new Promise(r => setTimeout(r, 30));
  const pAssert = vm.runInContext('aiBuildAsserts()', sb);
  await pAssert;
  await new Promise(r => setTimeout(r, 60));
  const rec = sb.aiAsserts instanceof Map ? sb.aiAsserts : vm.runInContext('aiAsserts', sb);
  if (!rec || !rec.size) { console.log('FAIL aiBuildAsserts 应生成 1 组断言, 实际: ' + JSON.stringify(rec && [...rec.keys()])); process.exit(1); }
  console.log('  OK aiBuildAsserts 解析出断言: ' + JSON.stringify([...rec.entries()]));
  const saved = storageData.get('toolbox.aiAsserts');
  if (!saved || !saved.length) { console.log('FAIL 断言未落 storage'); process.exit(1); }
  console.log('  OK 断言已持久化到 toolbox.aiAsserts');
  console.log('');
  console.log('=== assert 解析修复 PASS ===');
})();
