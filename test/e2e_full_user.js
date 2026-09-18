// 完整用户旅程 E2E: background + sidepanel 双 realm 共享 storage stub。
const fs = require('fs');
const ROOT = require('path').resolve(__dirname, '..');
const vm = require('vm');
const path = require('path');

const storageData = new Map();
const changeListeners = [];
const downloads = [];
const elements = new Map();

const storageLocal = {
  QUOTA_BYTES: 10485760,
  get: (keys, cb) => { const r = {}; for (const k of [].concat(keys)) r[k] = storageData.get(k); const p = Promise.resolve(r); if (typeof cb === 'function') setTimeout(() => cb(r), 0); return p; },
  set: (obj, cb) => { const changes = {}; for (const k of Object.keys(obj)) { changes[k] = { newValue: obj[k] }; storageData.set(k, obj[k]); } const p = Promise.resolve(); setTimeout(() => { for (const L of changeListeners) L(changes, 'local'); cb && cb(); }, 0); return p; },
  remove: (keys, cb) => { for (const k of [].concat(keys)) storageData.delete(k); const p = Promise.resolve(); setTimeout(() => cb && cb(), 0); return p; },
};
const onChangedHub = { addListener(L) { changeListeners.push(L); } };

const bgListeners = { event: [], message: [], detach: [], removed: [], alarm: [] };
const attachedTabs = new Set();
const bgChrome = {
  storage: { local: storageLocal, onChanged: onChangedHub },
  runtime: { onInstalled: { addListener() {} }, onMessage: { addListener(L) { bgListeners.message.push(L); } } },
  debugger: {
    attach: async ({ tabId }) => { attachedTabs.add(tabId); },
    detach: async ({ tabId }) => { attachedTabs.delete(tabId); },
    sendCommand: async () => ({ body: '{"resultCode":"0","data":{"orderId":"6512345678901"}}', base64Encoded: false }),
    onEvent: { addListener(L) { bgListeners.event.push(L); } },
    onDetach: { addListener(L) { bgListeners.detach.push(L); } },
  },
  alarms: { onAlarm: { addListener(L) { bgListeners.alarm.push(L); } }, create: () => Promise.resolve(), clear: () => Promise.resolve() },
  action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
  tabs: { onRemoved: { addListener(L) { bgListeners.removed.push(L); } } },
};
const bgSandbox = { console, setTimeout, URL, Date, Math, JSON, Object, Array, Set, Map, String, Number, Boolean, RegExp, Error, Promise, chrome: bgChrome };
bgSandbox.window = bgSandbox; bgSandbox.globalThis = bgSandbox;
vm.createContext(bgSandbox);
new vm.Script(fs.readFileSync(ROOT + '/background.js', 'utf8'), { filename: 'background.js' }).runInContext(bgSandbox);

const mkEl = (id) => { if (elements.has(id)) return elements.get(id);
  const el = { id, style: {}, dataset: {}, children: [], value: '', textContent: '', innerHTML: '', className: '', checked: true, disabled: false,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {}, appendChild() {}, setAttribute(k, v) { this[k === "aria-label" ? "ariaLabel" : k] = v; }, insertBefore() {}, querySelector() { return mkEl(id + '_q'); }, querySelectorAll() { return []; }, scrollIntoView() {}, onclick: null };
  elements.set(id, el); return el; };
const documentObj = { getElementById: (id) => mkEl(id), createElement: () => mkEl('a' + Math.random()), createDocumentFragment: () => mkEl('f'), createTextNode: (t) => ({ textContent: t }), querySelectorAll() { return []; }, body: mkEl('body') };
const sendToBg = (msg) => new Promise((resolve) => {
  for (const L of bgListeners.message) L(msg, {}, resolve);
});

const spChrome = {
  storage: { local: storageLocal, onChanged: onChangedHub },
  runtime: { sendMessage: sendToBg, openOptionsPage() {} },
  tabs: { query: async () => [{ id: 101, url: 'https://app.b.com/page' }] },
  scripting: { executeScript: async () => [{ result: { status: 200, ok: true, text: '{"resultCode":"0"}' } }] },
  sidePanel: {}, permissions: { contains: async () => true, request: async () => true },
  // cookies 预置(v1.0.63, #156 方向④): 当前测试不切到 Cookie tab(querySelectorAll 空
  // 数组 → activate 不可达 → chrome.cookies 消费点不触发), 但这是侥幸依赖 stub 的
  // querySelectorAll 返回空 —— 未来 stub 演进返回真元素时, activate('ck') 一触发
  // loadCookiesForActiveTab 就 undefined 炸。一行空 stub 消掉这个暗坑。
  cookies: { getAll: async () => [] },
};
const spSandbox = { console, setTimeout, setInterval: () => 0, clearInterval() {}, URL, URLSearchParams,
  fetch: async () => { throw new Error('no fetch in sidepanel realm'); },
  navigator: { clipboard: { writeText: async () => {} } }, document: documentObj, chrome: spChrome, performance: { now: () => Date.now() } };
spSandbox.window = spSandbox; spSandbox.globalThis = spSandbox;
vm.createContext(spSandbox);
const html = fs.readFileSync(ROOT + '/sidepanel/sidepanel.html', 'utf8');
for (const m of html.matchAll(/<script src="([^"]+)"><\/script>/g)) {
  const f = path.resolve(ROOT + '/sidepanel', m[1]);
  new vm.Script(fs.readFileSync(f, 'utf8'), { filename: f }).runInContext(spSandbox);
}
spSandbox.downloadText = (filename, text, mime) => { downloads.push({ filename, text, mime }); };

const emit = (tabId, method, params) => { for (const L of bgListeners.event) L({ tabId }, method, params); };
const assert = (cond, msg) => { if (!cond) { console.log('FAIL: ' + msg); process.exit(1); } console.log('  OK ' + msg); };

(async () => {
  await new Promise(r => setTimeout(r, 15));

  let r = await sendToBg({ type: 'setDomains', domains: ['b.com'] });
  assert(r && r.ok, '1. 配置域名 b.com');

  r = await sendToBg({ type: 'startRecording', tabId: 101 });
  assert(r && r.ok, '2. 点 Record(attach tab 101, 进 recording)');

  emit(101, 'Network.requestWillBeSent', { requestId: 'q1', request: { method: 'POST', url: 'https://api.b.com/order/create',
    headers: { 'Content-Type': 'application/json' }, postData: { text: '{"orderName":"CESHIDAN"}' } } });
  emit(101, 'Network.requestWillBeSent', { requestId: 'q2', request: { method: 'GET', url: 'https://api.b.com/list?page=1', headers: {} } });
  emit(101, 'Network.requestWillBeSent', { requestId: 'q3', request: { method: 'GET', url: 'https://other-site.com/tracker.js', headers: {} } });
  await new Promise(r2 => setTimeout(r2, 10));
  emit(101, 'Network.responseReceived', { requestId: 'q1', response: { status: 200, mimeType: 'application/json' } });
  emit(101, 'Network.responseReceived', { requestId: 'q2', response: { status: 200, mimeType: 'application/json' } });
  emit(101, 'Network.loadingFinished', { requestId: 'q1' });
  emit(101, 'Network.loadingFinished', { requestId: 'q2' });
  await new Promise(r2 => setTimeout(r2, 40));
  const info = await sendToBg({ type: 'getRecInfo' });
  assert(info.count === 2, '3. 页面操作录 3 条, 入列 ' + info.count + ' 条(跨域被滤): ' + JSON.stringify(info.unmatched));

  await new Promise(r2 => setTimeout(r2, 30));
  const entriesLen = vm.runInContext('entries.length', spSandbox);
  assert(entriesLen === 2, '4. 侧栏列表同步 ' + entriesLen + ' 条(storage.onChanged 增量)');

  r = await sendToBg({ type: 'stopRecording' });
  assert(storageData.get('toolbox.recording') === 'idle', '5. 点 Stop -> idle, detach 全部');
  await new Promise(r2 => setTimeout(r2, 20));

  downloads.length = 0;
  const btnSave = elements.get('btnSave');
  assert(typeof btnSave.onclick === 'function', '6a. btnSave 绑定存在(顶层无 SyntaxError)');
  await btnSave.onclick();
  const msg = elements.get('expMsg').textContent;
  assert(msg.includes('已导出 4 个文件'), '6b. 点保存 -> ' + msg.split('\n')[0]);
  assert(downloads.length === 4, '6c. 4 个文件触发下载: ' + downloads.map(d => d.filename.split('.').slice(1).join('.')).join(', '));

  const jmx = downloads.find(d => d.filename.endsWith('.jmx'));
  const py = downloads.find(d => d.filename.endsWith('.py'));
  const jsonl = downloads.find(d => d.filename.endsWith('.jsonl'));
  const har = downloads.find(d => d.filename.endsWith('.har'));
  assert(jmx && !jmx.text.includes('[object Object]') && jmx.text.includes('CESHIDAN'), '7a. JMX body 是真实字符串');
  assert(py && !py.text.includes('[object Object]') && py.text.includes('CESHIDAN'), '7b. PY 脚本 body 是真实字符串');
  assert(jsonl && jsonl.text.includes('CESHIDAN') && !jsonl.text.includes('tracker.js'), '7c. JSONL 含 POST body 且跨域噪音未入列');
  assert(har && har.text.includes('CESHIDAN'), '7d. HAR postData 正确');
  // 7e(v1.0.60): 引擎产出→HAR 落位全链 —— e2e 的 emit 不带 timestamp, 条目 durationMs
  // 走 0 兜底(引擎设计: 字段缺失保持 0), HAR time/wait 落 0(合法值, 区别于手造缺字段的 -1)。
  // mime 走 responseReceived.mimeType('application/json')→content.mimeType 全链断言。
  const harObj = JSON.parse(har.text).log;
  const harE1 = harObj.entries.find(e => e.request.method === 'POST');
  assert(harE1 && harE1.time === 0 && harE1.timings.wait === 0, '7e. 引擎产出(无 timestamp)→HAR time/wait=0 兜底非 -1');
  assert(harE1 && harE1.response.content.mimeType === 'application/json', '7f. responseReceived.mimeType → content.mimeType 全链');

  const btnDiscard = elements.get('btnDiscard');
  vm.runInContext('globalThis.confirm = () => true', spSandbox);
  await btnDiscard.onclick();
  await new Promise(r2 => setTimeout(r2, 20));
  const entriesLen2 = vm.runInContext('entries.length', spSandbox);
  assert(entriesLen2 === 0, '8a. 丢弃 -> 侧栏清空(' + entriesLen2 + ' 条)');
  downloads.length = 0;
  await btnSave.onclick();
  assert(elements.get('expMsg').textContent.includes('没有录制数据'), '8b. 空数据点保存 -> 明确提示而非静默');

  // 9. 暂停在途不丢半截(v1.0.53 用户旅程面): 在途请求已进 pending 后点暂停 →
  //    其响应照常落库;暂停后新发出的请求不进 —— check_engine_edge 场景 7 已有引擎级
  //    断言, 这里补用户可见旅程(pause → getRecInfo 状态 → 侧栏条数)
  r = await sendToBg({ type: 'startRecording', tabId: 101 });
  emit(101, 'Network.requestWillBeSent', { requestId: 'p1', request: { method: 'GET', url: 'https://api.b.com/inflight', headers: {} } });
  await new Promise(r2 => setTimeout(r2, 5));
  r = await sendToBg({ type: 'pauseRecording' });
  const infoP = await sendToBg({ type: 'getRecInfo' });
  assert(infoP.recState === 'paused', '9a. 暂停后 recState=paused');
  emit(101, 'Network.responseReceived', { requestId: 'p1', response: { status: 200, mimeType: 'application/json' } });
  emit(101, 'Network.loadingFinished', { requestId: 'p1' });
  emit(101, 'Network.requestWillBeSent', { requestId: 'p2', request: { method: 'GET', url: 'https://api.b.com/paused-new', headers: {} } });
  emit(101, 'Network.loadingFinished', { requestId: 'p2' });
  await new Promise(r2 => setTimeout(r2, 60));
  const hvAfterPause = storageData.get('toolbox.harvest');
  const idsAfterPause = (hvAfterPause && hvAfterPause.entries || []).map((e) => e.path);
  assert(idsAfterPause.includes('/inflight'), '9b. 暂停前在途请求照常落库(用户旅程面: ' + idsAfterPause.join(',') + ')');
  assert(!idsAfterPause.includes('/paused-new'), '9c. 暂停后新请求不收');
  await sendToBg({ type: 'stopRecording' });

  // 10. AI 链注入回执的用户旅程面(v1.0.65, #159 方向③): 建链 → 链路重放 →
  //     chainOut 里能看到"哪些链生效/哪些没生效"回执。行为级细节断言在
  //     check_trim_sync 场景 5(按 URL 分流 mock 的 applied/missing 双分支),
  //     这里补旅程级: 悬空链在真实旅程数据(本轮录的 inflight 条目)上的
  //     missing 回执可见 —— 用户排查"链没生效"不需要打开控制台。
  //     注意链的 toId 必须指向集内真实条目: inject 循环对"to 不在集"的链
  //     是 continue 静默跳过(设计: 用户过滤掉目标条目 → 链自然不适用),
  //     只有 to 命中、from 悬空才会产出 missing 回执 —— 本断言锚的就是
  //     这条回执路径。inflight 条目 id 是引擎生成的(r+时间戳+rand), 从
  //     storage 真实读出再挂 toId, 不硬编码。
  const hv10 = storageData.get('toolbox.harvest');
  const inflightId = hv10 && hv10.entries[0] && hv10.entries[0].id;
  storageData.set('toolbox.aiChain', [
    { from: 0, fromId: 'zzz-ghost', fromJsonPath: 'token', to: 0, toId: inflightId, toParam: 'token', var: 'jTok', value: '' },
  ]);
  await vm.runInContext('loadHarvest()', spSandbox);
  vm.runInContext('globalThis.confirm = () => true', spSandbox);
  await vm.runInContext('runChainReplay()', spSandbox);
  const journeyOut = elements.get('chainOut').innerHTML;
  assert(journeyOut.includes('== AI 参数链 ==') && journeyOut.includes('jTok'),
    '10a. 悬空链的 missing 回执在旅程重放里可见(jTok): ' + (journeyOut.match(/⚠ [^\n]*/) || ['无'])[0]);

  console.log('');
  console.log('=== E2E FULL PASS ===');
})();
