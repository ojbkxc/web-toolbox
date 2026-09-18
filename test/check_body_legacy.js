// 旧数据兜底: storage 里已有的条目 body 可能是 CDP 对象(用户改动期间录的)。
// loadHarvest 后 sidepanel 直接用 —— 需在 sidepanel 加载侧归一化, 否则旧数据导出还是 [object Object]。
// 这里先确认症状, 再改 sidepanel decodeHarvest 或 loadHarvest。
const fs = require('fs');
const ROOT = require('path').resolve(__dirname, '..');
const vm = require('vm');
const path = require('path');
const html = fs.readFileSync(ROOT + '/sidepanel/sidepanel.html', 'utf8');
const all = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1]).map(p => path.resolve(ROOT + '/sidepanel', p));
const elements = new Map();
const mkEl = (id) => { if (elements.has(id)) return elements.get(id);
  const el = { id, style: {}, dataset: {}, children: [], value: '', textContent: '', innerHTML: '', className: '', checked: true, disabled: false,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {}, appendChild() {}, setAttribute(k, v) { this[k === "aria-label" ? "ariaLabel" : k] = v; }, insertBefore() {}, querySelector() { return mkEl(id + '_q'); }, querySelectorAll() { return []; }, scrollIntoView() {}, onclick: null };
  elements.set(id, el); return el; };
const documentObj = { getElementById: (id) => mkEl(id), createElement: () => mkEl('a' + Math.random()), createDocumentFragment: () => mkEl('f'), querySelectorAll: () => [], body: mkEl('body') };
const storageData = new Map(); const changeListeners = []; const downloads = [];
const chromeStub = {
  storage: { local: { QUOTA_BYTES: 10485760,
    get: (keys, cb) => { const r = {}; for (const k of [].concat(keys)) r[k] = storageData.get(k); const p = Promise.resolve(r); if (typeof cb === 'function') setTimeout(() => cb(r), 0); return p; },
    set: (obj, cb) => { const changes = {}; for (const k of Object.keys(obj)) { changes[k] = { newValue: obj[k] }; storageData.set(k, obj[k]); } const p = Promise.resolve(); setTimeout(() => { for (const L of changeListeners) L(changes, 'local'); cb && cb(); }, 0); return p; },
    remove: (keys, cb) => { for (const k of [].concat(keys)) storageData.delete(k); const p = Promise.resolve(); setTimeout(() => cb && cb(), 0); return p; } },
    onChanged: { addListener(L) { changeListeners.push(L); } } },
  runtime: { sendMessage: async () => ({ ok: true, recState: 'idle', count: 1, pending: 0, attachedTabs: 0, domains: [], unmatched: [], harvestCorrupt: false }), openOptionsPage() {} },
  tabs: { query: async () => [{ id: 1, url: 'https://a.b.com/x' }] },
  scripting: { executeScript: async () => [{ result: { status: 200, ok: true, text: '{}' } }] },
  sidePanel: {}, permissions: { contains: async () => false, request: async () => true } };
const sandbox = { console, setTimeout, setInterval: () => 0, URL, URLSearchParams, fetch: async () => { throw new Error('nf'); },
  navigator: { clipboard: { writeText: async () => {} } }, document: documentObj, chrome: chromeStub, performance: { now: () => Date.now() } };
sandbox.window = sandbox; sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const f of all) new vm.Script(fs.readFileSync(f, 'utf8'), { filename: f }).runInContext(sandbox);
sandbox.downloadText = (filename, text) => { downloads.push({ filename, text }); };
(async () => {
  const entry = { id: 'r1', method: 'POST', url: 'https://a.b.com/api/x', path: '/api/x', query: '',
    headers: { 'Content-Type': 'application/json' }, body: { text: '{"orderId":"6512345678901"}' },
    status: 200, mime: 'application/json', response: '{"resultCode":"0"}', ts: new Date().toISOString() };
  await new Promise(r => chromeStub.storage.local.set({ 'toolbox.harvest': { v: 1, entries: [entry] } }, r));
  await new Promise(r => setTimeout(r, 30));
  console.log('sandbox.entries?', vm.runInContext('entries.length', sandbox));
  const btn = elements.get('btnSave'); await btn.onclick();
  console.log('downloads:', downloads.map(d=>d.filename).join(', '));
  console.log('expMsg:', elements.get('expMsg').textContent);
  const jmx = downloads.find(d => d.filename.endsWith('.jmx'));
  console.log('旧数据(对象body) JMX 含 [object Object]?', jmx ? jmx.text.includes('[object Object]') : 'N/A');
})();
