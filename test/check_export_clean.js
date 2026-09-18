// JMX/PY 导出净化语义: harvest 含 OPTIONS 预检 + .js 静态资源 + SSE + 业务接口 + .json 业务接口
// 断言: JMX/PY 不含前两者, JSONL/HAR 保真全量; .json 不误杀(内网业务接口形态)。
const fs = require('fs'); const vm = require('vm'); const path = require('path');
const ROOT = require('path').resolve(__dirname, '..');
const html = fs.readFileSync(ROOT + '/popup/popup.html', 'utf8');
const all = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)]
  .map((m) => m[1]).map((p) => path.resolve(ROOT + '/popup', p));
const elements = new Map();
const mkEl = (id) => { if (elements.has(id)) return elements.get(id);
  const el = { id, style: {}, dataset: {}, children: [], value: '', textContent: '', innerHTML: '', className: '', checked: true, disabled: false,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } }, addEventListener() {}, appendChild() {}, setAttribute(k, v) { this[k === "aria-label" ? "ariaLabel" : k] = v; }, insertBefore() {},
    querySelector() { return mkEl(id + '_q'); }, querySelectorAll() { return []; }, scrollIntoView() {}, onclick: null };
  elements.set(id, el); return el; };
const documentObj = { getElementById: (id) => mkEl(id), createElement: () => mkEl('a' + Math.random()), createDocumentFragment: () => mkEl('f'), querySelectorAll: () => [], body: mkEl('body') };
const storageData = new Map();
let downloads = [];
const chromeStub = {
  storage: { local: {
    get: (keys, cb) => { const r = {}; for (const k of [].concat(keys)) r[k] = storageData.get(k); if (typeof cb === 'function') setTimeout(() => cb(r), 0); return Promise.resolve(r); },
    set: (obj, cb) => { for (const k of Object.keys(obj)) storageData.set(k, obj[k]); setTimeout(() => cb && cb(), 0); return Promise.resolve(); },
    remove: (keys, cb) => { for (const k of [].concat(keys)) storageData.delete(k); setTimeout(() => cb && cb(), 0); return Promise.resolve(); } },
    onChanged: { addListener() {} } },
  runtime: { sendMessage: async () => ({ ok: true, recState: 'idle', count: 0, pending: 0, attachedTabs: 0, domains: [], unmatched: [], harvestCorrupt: false }), openOptionsPage() {} },
  tabs: { query: async () => [{ id: 1, url: 'https://a.b.com/x' }] },
  sidePanel: { open: async () => {} },
  // contains 必须回调式真调 cb(v1.0.74): common.js containsOrigin 是 new Promise(resolve =>
  // chrome.permissions.contains(..., cb)) 形态, stub 不调 cb → refresh() 静默挂起。
  // 旧 stub `async () => false` 返回 resolved promise 但 cb 永不触发, 测试侥幸绿
  // (不断言按钮显示态) —— 未来任何"加载后状态"断言都会踩这个坑(e2e stub 同款教训)。
  permissions: { contains: (p, cb) => cb(false), request: (p, cb) => cb(true) } };
const sandbox = { console, setTimeout, setInterval: () => 0, clearInterval() {}, URL, URLSearchParams, fetch: async () => { throw new Error('nf'); },
  navigator: { clipboard: { writeText: async () => {} } }, document: documentObj, chrome: chromeStub, performance: { now: () => Date.now() }, alert() {} };
sandbox.window = sandbox; sandbox.globalThis = sandbox; vm.createContext(sandbox);
// 拦截 downloadText: 不真下载, 记录内容断言
sandbox.downloadText = null; // common.js 顶层声明, 会被覆盖吗? —— function downloadText 是声明, vm 里后定义覆盖 sandbox 注入
for (const f of all) new vm.Script(fs.readFileSync(f, 'utf8'), { filename: f }).runInContext(sandbox);
vm.runInContext('downloadText = (name, data) => { __dl.push({ name, data }); }; window.__dl = [];', sandbox);
downloads = null;

const mk = (id, method, url, extra) => Object.assign({ id, method, url, path: new URL(url).pathname, query: '', headers: {}, body: '', status: 200, mime: 'application/json', response: '{}', ts: '2026-09-17T10:00:00Z' }, extra);
const entries = [
  mk('e1', 'OPTIONS', 'https://a.b.com/api/order', { status: 204, body: '', mime: '' }),
  mk('e2', 'GET', 'https://a.b.com/static/app.js', { mime: 'application/javascript' }),
  mk('e3', 'GET', 'https://a.b.com/static/logo.png', { mime: 'image/png' }),
  mk('e4', 'GET', 'https://a.b.com/sse/push', { headers: { 'Content-Type': 'text/event-stream' } }),
  mk('e5', 'GET', 'https://a.b.com/api/list.json', { response: '{"list":[]}' }), // .json 业务接口 → 不误杀
  mk('e6', 'POST', 'https://a.b.com/api/order', { body: '{"orderNo":"A1"}', response: '{"ok":1}' }),
];
storageData.set('toolbox.harvest', { v: 1, entries });

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  OK ' + msg); } else { fail++; console.log('  ✗ FAIL ' + msg); } };

(async () => {
  // 全部下载 = jsonl + jmx + py
  await vm.runInContext('quickExport(["jsonl","jmx","py"])', sandbox);
  const dl = vm.runInContext('window.__dl', sandbox);
  ok(dl.length === 3, 'popup 全部下载 3 个文件');
  const jmx = dl.find((f) => f.name.endsWith('.jmx'));
  const py = dl.find((f) => f.name.endsWith('.py'));
  const jsonl = dl.find((f) => f.name.endsWith('.jsonl'));
  ok(!!jmx && !!py && !!jsonl, 'jmx/py/jsonl 三件齐');
  // JMX 净化: 不含 OPTIONS/静态资源/SSE 路径, 含 list.json 与 order
  ok(!/OPTIONS/.test(jmx.data), 'JMX 无 OPTIONS 预检采样器');
  ok(!jmx.data.includes('/static/app.js') && !jmx.data.includes('/static/logo.png'), 'JMX 无静态资源采样器');
  ok(!jmx.data.includes('/sse/push'), 'JMX 无 SSE 采样器');
  ok(jmx.data.includes('/api/list.json'), 'JMX 保留 .json 业务接口(不误杀)');
  ok(jmx.data.includes('/api/order'), 'JMX 保留 POST 业务接口');
  ok((jmx.data.match(/<HTTPSamplerProxy /g) || []).length === 2, 'JMX 采样器恰好 2 个(list.json + order)');
  // PY 同语义
  ok(!py.data.includes('"/static/app.js"') && !py.data.includes('"/sse/push"') && !py.data.includes('"/api/order\', \'OPTIONS'), 'PY 无预检/静态/SSE 步骤');
  ok(py.data.includes('/api/list.json') && py.data.includes('/api/order'), 'PY 保留业务接口');
  // JSONL 保真: 6 条全在
  const rows = py && jsonl.data.trim().split('\n').length;
  ok(rows === 6, `JSONL 保真全量 6 条(实得 ${rows})`);
  ok(jsonl.data.includes('/static/app.js') && jsonl.data.includes('/sse/push'), 'JSONL 含静态资源与 SSE(数据格式不动)');
  // HAR 单独验证
  vm.runInContext('window.__dl = [];', sandbox);
  await vm.runInContext('quickExport(["har"])', sandbox);
  const har = vm.runInContext('window.__dl', sandbox)[0];
  const harObj = JSON.parse(har.data).log;
  const harEntries = harObj.entries;
  ok(harEntries.length === 6, `HAR 保真全量 6 条(实得 ${harEntries.length})`);
  ok(harEntries.some((e) => e.request.method === 'OPTIONS'), 'HAR 含 OPTIONS(保真)');
  // HAR 1.2 spec required 字段: 校验器按"缺 required"拒收, undefined 经 stringify 整键消失
  ok(harObj.version === '1.2', 'HAR log.version 1.2');
  for (const e of harEntries) {
    const req = ['method', 'url', 'httpVersion', 'headers', 'queryString', 'cookies', 'headersSize', 'bodySize'];
    const resp = ['status', 'statusText', 'httpVersion', 'headers', 'cookies', 'content', 'redirectURL', 'headersSize', 'bodySize'];
    const top = ['startedDateTime', 'time', 'request', 'response', 'cache', 'timings'];
    ok(top.every((k) => k in e), `entries required 齐(缺: ${top.filter((k) => !(k in e))})`);
    ok(req.every((k) => k in e.request), `request required 齐(缺: ${req.filter((k) => !(k in e.request))})`);
    ok(resp.every((k) => k in e.response), `response required 齐(缺: ${resp.filter((k) => !(k in e.response))})`);
    ok(['send', 'wait', 'receive'].every((k) => k in e.timings), 'timings send/wait/receive 齐');
    break; // 结构同构, 验首条即可
  }
  // durationMs 缺失 → time/wait = -1(HAR 语义 N/A); 有 durationMs → 原值
  ok(harEntries[0].time === -1 && harEntries[0].timings.wait === -1, '无 durationMs → time/wait 为 -1(N/A)');
  // durationMs 正值路径(v1.0.59 补): 上述只锚了缺失分支, "有值 → 原值落位"从未断言 ——
  // buildHar 的 wait 与 time 是两个独立赋值点, 只测 -1 分支对"有值分支"零证明力。
  // startedDateTime 同测: 引擎 ts 是 ISO 字符串, HAR 规范要 ISO 8601 —— 原样落位。
  vm.runInContext('window.__dl = [];', sandbox);
  storageData.set('toolbox.harvest', { v: 1, entries: [mk('h1', 'POST', 'https://a.b.com/api/order', { durationMs: 345, ts: '2026-09-17T12:34:56.789Z' })] });
  await vm.runInContext('quickExport(["har"])', sandbox);
  const harDur = JSON.parse(vm.runInContext('window.__dl', sandbox)[0].data).log.entries[0];
  ok(harDur.time === 345 && harDur.timings.wait === 345, '有 durationMs → time/wait 落原值(345)');
  ok(harDur.startedDateTime === '2026-09-17T12:34:56.789Z', 'startedDateTime 落引擎 ts 原值');
  // 恢复全量数据集(后续断言"剔除 4 条"提示语依赖上面的 6 条数据), 重跑一次 jmx 导出刷提示语
  storageData.set('toolbox.harvest', { v: 1, entries });
  vm.runInContext('window.__dl = [];', sandbox);
  await vm.runInContext('quickExport(["jmx"])', sandbox);
  // body 有值 → postData 带 mimeType; query → queryString 参数级
  const post = harEntries.find((e) => e.request.method === 'POST');
  ok(post && post.request.postData && post.request.postData.mimeType === 'application/json', 'POST postData.mimeType 取 Content-Type');
  ok(post && post.request.postData.text === '{"orderNo":"A1"}', 'postData.text 保真');
  // 提示语含剔除数
  const expEl = elements.get('expCount');
  ok(expEl.textContent.includes('剔除') && expEl.textContent.includes('4'), 'expCount 提示剔除 4 条: ' + expEl.textContent);
  // 无 skippable 数据 → dropped=0 → 提示无剔除字样
  storageData.set('toolbox.harvest', { v: 1, entries: [mk('x1', 'POST', 'https://a.b.com/api/only', { body: '{}' })] });
  elements.get('expCount').textContent = '';
  vm.runInContext('window.__dl = [];', sandbox);
  await vm.runInContext('quickExport(["jmx"])', sandbox);
  ok(!elements.get('expCount').textContent.includes('剔除'), '无 skippable 时提示不带剔除字样: ' + elements.get('expCount').textContent);

  // 空 headers 不挂空 HeaderManager(v1.0.73, #166 方向③): httpSampler 的
  // `if (biz.length)` 守卫(L156) —— 无业务头的条目(纯 GET 无自定义头)不产出
  // 空 <HeaderManager> 节点(JMeter 对空 headers 集容错差, 且空节点是采样器树噪音)。
  // x1 条目 headers={} 且非 skip 头 → biz 空。对照组: 有业务头的条目挂真 HeaderManager。
  {
    storageData.set('toolbox.harvest', { v: 1, entries: [
      mk('nh1', 'GET', 'https://a.b.com/api/nohdr', { headers: {} }),                       // 无头
      mk('nh2', 'GET', 'https://a.b.com/api/withhdr', { headers: { 'X-Token': 't1' } }),   // 有业务头
    ]});
    vm.runInContext('window.__dl = [];', sandbox);
    await vm.runInContext('quickExport(["jmx"])', sandbox);
    const j = vm.runInContext('window.__dl', sandbox).find((f) => f.name.endsWith('.jmx'));
    const total = (j.data.match(/<HeaderManager /g) || []).length;
    ok(total === 1, `空 headers 条目不挂空 HeaderManager(实得 ${total} 个, 期望 1=仅有头条目)`);
    ok(j.data.includes('X-Token') && j.data.includes('Header.name'), '有业务头条目照常挂 HeaderManager');
    const emptyHm = /<HeaderManager[^>]*>\s*<collectionProp name="HeaderManager.headers">\s*<\/collectionProp>/.test(j.data);
    ok(!emptyHm, '无空 headers 集的 HeaderManager 节点');
  }
  console.log(fail ? `\n=== 净化语义 FAIL: ${fail} ===` : '\n=== 导出净化语义 PASS ===');
  process.exit(fail ? 1 : 0);
})();
