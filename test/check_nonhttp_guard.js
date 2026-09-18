// 验证非 http(s) 页前置拦截: popup + sidepanel 两 realm 的 btnRecord/btnStart 均不发起 startRecording。
const fs = require('fs'), vm = require('vm'), path = require('path');
const ROOT = require('path').resolve(__dirname, '..');

function makeRealm(htmlPath, extraChrome) {
  const storageData = new Map();
  const elements = new Map();
  const storageLocal = {
    get: (keys, cb) => { const r = {}; for (const k of [].concat(keys)) r[k] = storageData.get(k); const p = Promise.resolve(r); if (typeof cb === 'function') setTimeout(() => cb(r), 0); return p; },
    set: (obj, cb) => { for (const k of Object.keys(obj)) storageData.set(k, obj[k]); const p = Promise.resolve(); if (typeof cb === 'function') setTimeout(() => cb(), 0); return p; },
    remove: (keys, cb) => { const p = Promise.resolve(); if (typeof cb === 'function') setTimeout(() => cb(), 0); return p; },
  };
  const mkEl = (id) => { if (elements.has(id)) return elements.get(id);
    const el = { id, style: {}, dataset: {}, children: [], value: '', textContent: '', innerHTML: '', className: '', checked: true, disabled: false,
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      addEventListener() {}, appendChild() {}, setAttribute(k, v) { this[k === "aria-label" ? "ariaLabel" : k] = v; }, insertBefore() {}, querySelector() { return mkEl(id + '_q'); }, querySelectorAll() { return []; }, scrollIntoView() {}, onclick: null };
    elements.set(id, el); return el; };
  const documentObj = { getElementById: (id) => mkEl(id), createElement: () => mkEl('a' + Math.random()), createDocumentFragment: () => mkEl('f'), querySelectorAll() { return []; }, body: mkEl('body') };
  const sent = [];
  const chromeStub = Object.assign({
    storage: { local: storageLocal, onChanged: { addListener() {} } },
    runtime: { sendMessage: async (msg) => { sent.push(msg); return { ok: true, recState: 'idle', count: 0 }; }, openOptionsPage() {} },
    tabs: { query: async () => [{ id: 101, url: 'chrome://settings/' }] }, // 非 http(s)
    // contains 回调式真调 cb(v1.0.74): containsOrigin 是 new Promise(cb 形态),
    // 不调 cb → refresh() 挂起。本测 tab 是 chrome:// → refresh 走"非 http(s)"分支
    // 不触 contains, 但保持 stub 形态正确防未来加 http 场景踩坑。
    permissions: { contains: (p, cb) => cb(true) },
  }, extraChrome || {});
  const sb = { console, setTimeout, setInterval: () => 0, clearInterval() {}, URL, URLSearchParams,
    fetch: async () => { throw new Error('no fetch'); }, alert: () => {},
    navigator: { clipboard: { writeText: async () => {} } }, document: documentObj, chrome: chromeStub, performance: { now: () => Date.now() } };
  sb.window = sb; sb.globalThis = sb;
  vm.createContext(sb);
  const html = fs.readFileSync(htmlPath, 'utf8');
  const root = path.dirname(htmlPath);
  for (const m of html.matchAll(/<script src="([^"]+)"><\/script>/g)) {
    const f = path.resolve(root, m[1]);
    new vm.Script(fs.readFileSync(f, 'utf8'), { filename: f }).runInContext(sb);
  }
  return { sb, elements, sent };
}

const assert = (cond, msg) => { if (!cond) { console.log('FAIL: ' + msg); process.exit(1); } console.log('  OK ' + msg); };

(async () => {
  await new Promise(r => setTimeout(r, 30));

  // popup: chrome:// 页点"开始录制"
  const pop = makeRealm(ROOT + '/popup/popup.html', { sidePanel: { open: async () => {} }, windows: { WINDOW_ID_CURRENT: 1 } });
  await new Promise(r => setTimeout(r, 30));
  await pop.elements.get('btnRecord').onclick();
  assert(pop.sent.every(m => m.type !== 'startRecording'), '1. popup 在 chrome:// 页不发起 startRecording');
  // popup 有提示(alert stub 不记录, 只验证不发消息即拦截成功)

  // sidepanel: chrome:// 页点 ● Record
  const sp = makeRealm(ROOT + '/sidepanel/sidepanel.html');
  await new Promise(r => setTimeout(r, 30));
  await sp.elements.get('btnStart').onclick();
  await new Promise(r => setTimeout(r, 20));
  assert(sp.sent.every(m => m.type !== 'startRecording'), '2. sidepanel 在 chrome:// 页不发起 startRecording');
  const msgTxt = String(sp.elements.get('chainMsg').textContent);
  assert(msgTxt.includes('http(s)'), '3. sidepanel 拦截有可读提示: ' + msgTxt);

  // 重录按钮(v1.0.81): 非 http 页点「↻ 重录」同样被前置拦截, 不发起 stop/clear/start
  await sp.elements.get('btnRerecord').onclick();
  await new Promise(r => setTimeout(r, 20));
  assert(sp.sent.every(m => m.type !== 'stopRecording' && m.type !== 'clearHarvest' && m.type !== 'startRecording'),
    '4. sidepanel 在 chrome:// 页点重录也不发起录制链(前置拦截): ' + JSON.stringify(sp.sent));

  // 反例: http 页正常发起
  const sp2 = makeRealm(ROOT + '/sidepanel/sidepanel.html');
  sp2.sb.chrome.tabs.query = async () => [{ id: 101, url: 'https://app.test.com/page' }];
  await new Promise(r => setTimeout(r, 30));
  await sp2.elements.get('btnStart').onclick();
  assert(sp2.sent.some(m => m.type === 'startRecording'), '4a. http 页正常发起 startRecording');

  // 6. 重录按钮正向全链(v1.0.81): http 页 + 空库点重录 → stop→clear→start 按序发起。
  //    此前只有断言 4(非 http 前置拦截负断言), 正向路径零覆盖。注意 makeRealm 默认
  //    confirm 未注入(sandbox 无 confirm) —— 有数据时点重录走到 confirm 会 ReferenceError,
  //    测"confirm 拦截"须先注入 confirm stub(断言 6c 才注入, 6 本身靠空库跳过 confirm)。
  const sp6 = makeRealm(ROOT + '/sidepanel/sidepanel.html');
  sp6.sb.chrome.tabs.query = async () => [{ id: 101, url: 'https://app.test.com/page' }];
  await new Promise(r => setTimeout(r, 30));
  await sp6.elements.get('btnRerecord').onclick();
  await new Promise(r => setTimeout(r, 20));
  const types6 = sp6.sent.map(m => m.type);
  assert(types6.includes('stopRecording') && types6.includes('clearHarvest') && types6.includes('startRecording'),
    '6. http 页点重录发起 stop→clear→start 全链: ' + JSON.stringify(types6));
  assert(types6.indexOf('stopRecording') < types6.indexOf('clearHarvest') && types6.indexOf('clearHarvest') < types6.indexOf('startRecording'),
    '6a. 重录链按序(先停止再清数据再开录): ' + JSON.stringify(types6));
  const startMsg6 = sp6.sent.find(m => m.type === 'startRecording');
  assert(startMsg6 && startMsg6.tabId === 101, '6b. startRecording 带当前 tabId: ' + JSON.stringify(startMsg6));

  // 6c. 有数据时 confirm 取消 → 不发起录制链(防误清护栏, 与 btnDiscard 同款语义)。
  //    makeRealm 没注入 confirm, 这里显式注入 stub 返回 false 模拟用户点"取消"。
  const sp7 = makeRealm(ROOT + '/sidepanel/sidepanel.html');
  sp7.sb.chrome.tabs.query = async () => [{ id: 101, url: 'https://app.test.com/page' }];
  sp7.sb.confirm = () => false;
  await new Promise(r => setTimeout(r, 30));
  await vm.runInContext('entries.push({id:"r1", url:"https://app.test.com/x", method:"GET", path:"/x", status:200, mime:"application/json", body:"", headers:{}, response:"", durationMs:1, ts:0});', sp7.sb);
  await sp7.elements.get('btnRerecord').onclick();
  await new Promise(r => setTimeout(r, 20));
  assert(sp7.sent.every(m => m.type !== 'stopRecording' && m.type !== 'clearHarvest' && m.type !== 'startRecording'),
    '6c. 有数据时取消重录 → 不发起录制链(confirm 防误清): ' + JSON.stringify(sp7.sent));

  // 5. sidepanel"未配置域名"空态指引一致性(v1.0.74, #168 方向③): popup v1.0.73 起
  //    未配置域名直接藏录制按钮 + site 行出"＋ 添加此域名"; sidepanel 的 Record 按钮
  //    不藏(工作台语义: 引擎跨 tab 录, 当前 tab 未配置不代表不能录别的 tab), 但录制中
  //    + 空库 + 零域名时 emptyHint 必须出"未配置域名, 捕到也全丢"指引 —— 这是双入口
  //    指引一致性的 sidepanel 侧锚(与 popup site 行"＋ 添加此域名"同语义不同呈现)。
  //    行为级: getRecInfo 回 recState=recording + count=0 + domains=[] →
  //    refreshState → updateEmptyHint → 列表 innerHTML 含"未配置域名"。
  const sp3 = makeRealm(ROOT + '/sidepanel/sidepanel.html');
  sp3.sb.chrome.runtime.sendMessage = async (msg) => ({ ok: true, recState: 'recording', count: 0, domains: [], unmatched: [], attachedTabs: 1, harvestCorrupt: false });
  await new Promise(r => setTimeout(r, 30));
  await vm.runInContext('refreshState()', sp3.sb);
  await new Promise(r => setTimeout(r, 30));
  assert(String(sp3.elements.get('list').innerHTML).includes('未配置域名'),
    '5. sidepanel 录制中+空库+零域名 → 空态出"未配置域名"指引: ' + String(sp3.elements.get('list').innerHTML).slice(0, 80));

  console.log('');
  console.log('=== 非 http(s) 前置拦截 PASS ===');
})();
