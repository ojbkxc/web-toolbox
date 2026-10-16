// popup 快速导出 E2E: storage 有录制数据 -> 一键导出 JMX/PY 全链(popup realm 串联加载 popup.html 的 6 个 script)。
const fs = require('fs');
const ROOT = require('path').resolve(__dirname, '..');
const vm = require('vm');
const path = require('path');

const storageData = new Map();
const downloads = [];
const alerts = [];
const elements = new Map();
const granted = new Set();
let lastRequest = null;

const storageLocal = {
  get: (keys, cb) => { const r = {}; for (const k of [].concat(keys)) r[k] = storageData.get(k); const p = Promise.resolve(r); if (typeof cb === 'function') setTimeout(() => cb(r), 0); return p; },
  set: (obj, cb) => { for (const k of Object.keys(obj)) storageData.set(k, obj[k]); const p = Promise.resolve(); if (typeof cb === 'function') setTimeout(() => cb(), 0); return p; },
  onChanged: { addListener() {} }, // v1.0.11 起 popup 用 onChanged 推送替代 1s 轮询
};
let recInfoCount = 2;
let recInfoCorrupt = false; // getRecInfo 返回的 harvestCorrupt(损坏信封场景 7 切换用)
let msgChannelDead = false;  // sendMessage throw 开关(场景 8: 消息通道死锁 → catch 直读兜底)
const msgHandlers = [];
const mkEl = (id) => { if (elements.has(id)) return elements.get(id);
  const el = { id, style: {}, dataset: {}, children: [], value: '', textContent: '', innerHTML: '', className: '', checked: true, disabled: false,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {}, appendChild() {}, setAttribute(k, v) { this[k === "aria-label" ? "ariaLabel" : k] = v; }, insertBefore() {}, querySelector() { return mkEl(id + '_q'); }, querySelectorAll() { return []; }, onclick: null };
  elements.set(id, el); return el; };
const documentObj = { getElementById: (id) => mkEl(id), createElement: () => mkEl('a' + Math.random()), body: mkEl('body'), querySelectorAll() { return []; } };

const onChangedFns = []; // chrome.storage.onChanged 真实监听体捕获(9k 消费: 顶层挂载只在脚本加载时发生一次, 捕获必须在挂载路径上)
const chromeStub = {
  storage: { local: storageLocal, onChanged: { addListener: (fn) => { onChangedFns.push(fn); } } },
  runtime: {
    sendMessage: async (msg) => { if (msgChannelDead) throw new Error('message channel closed'); for (const h of msgHandlers) { const r = h(msg, {}, () => {}); if (r === true) return undefined; } return { ok: true, recState: 'idle', count: recInfoCount, harvestCorrupt: recInfoCorrupt }; },
    onMessage: { addListener(h) { msgHandlers.push(h); } },
    openOptionsPage() {},
  },
  tabs: { query: async () => [{ id: 201, url: 'https://app.test.com/home' }] },
  sidePanel: { open: async () => {} },
  windows: { WINDOW_ID_CURRENT: 'cur' },
  permissions: { contains: (p, cb) => cb(p.origins.some((o) => granted.has(o))), request: (p, cb) => { p.origins.forEach((o) => granted.add(o)); lastRequest = [...p.origins]; cb(true); } },
};
const sandbox = { console, setTimeout, setInterval: () => 0, clearInterval() {}, URL, URLSearchParams, Date, Promise,
  alert: (m) => alerts.push(m), navigator: { clipboard: { writeText: async () => {} } }, document: documentObj, chrome: chromeStub, performance: { now: () => Date.now() } };
sandbox.window = sandbox; sandbox.globalThis = sandbox;
vm.createContext(sandbox);

// storage 预置: 2 条录制(信封格式, 含登录前置 + 业务) + 关联结果
storageData.set('toolbox.harvest', { v: 1, entries: [
  { id: 1, method: 'POST', url: 'https://app.test.com/web/login', path: '/web/login', query: '', headers: { 'Content-Type': 'application/json' }, body: '{"user":"u1","ts":1789520001000}', status: 200, response: '{"token":"abc"}', mime: 'application/json', ts: '2026-09-17T08:00:01Z' },
  { id: 2, method: 'POST', url: 'https://app.test.com/order/create', path: '/order/create', query: '', headers: { 'Content-Type': 'application/json' }, body: '{"orderName":"DAN1","ts":1789520002000}', status: 200, response: '{"resultCode":"0","data":{"orderId":"6512345678901"}}', mime: 'application/json', ts: '2026-09-17T08:00:02Z' },
]});
// corrResult 形态与 analyzeCorrelation 产物对齐(groups[].count 是产物 schema 的字段, 消费面 applyCorr 不读但保持一致防 schema 漂移)
storageData.set('toolbox.corrResult', { groups: [{ method: 'POST', path: '/order/create', count: 2, dynamics: [{ path: 'ts', values: ['1789520002000', '1789520002999'], classify: { kind: 'timestamp' }, var: 'ts', replace: '${__time()}' }] }], summary: '1 处' });
// v1.0.73 起 popup 有 siteReady 门槛(当前域名未配置时藏录制/导出按钮):
// e2e 预置域名清单 + 授权, 让全旅程默认就绪不破坏既有断言。快捷添加面由独立场景(9/9b)覆盖。
storageData.set('toolbox.domains', ['app.test.com']);
granted.add('https://app.test.com/*');
// AI 链预置: popup 一键导出同样应用侧栏建链成果(README L172 承诺) —— e2e 必须钉死这条注入面:
// 登录响应 token 字段 → 下游单号查询 body.orderName 的提取器+变量替换(与 corr 独立双注入)。
// fromId/toId 必须与真实产物同类型(数字): 侧栏建链 ids = src.map(e => e.id), entry.id 是数字;
// applyAiChainToJmx 的 byId Map.get 类型严格, 字符串 '1' 拿不到数字 1 → 链静默跳过。
storageData.set('toolbox.aiChain', [{ from: 0, fromId: 1, fromJsonPath: 'token', to: 1, toId: 2, toParam: 'body.orderName', var: 'v_tok', value: 'DAN1' }]);

const html = fs.readFileSync(ROOT + '/popup/popup.html', 'utf8');
for (const m of html.matchAll(/<script src="([^"]+)"><\/script>/g)) {
  const f = path.resolve(ROOT + '/popup', m[1]);
  new vm.Script(fs.readFileSync(f, 'utf8'), { filename: f }).runInContext(sandbox);
}
sandbox.downloadText = (filename, text, mime) => { downloads.push({ filename, text, mime }); };

const assert = (cond, msg) => { if (!cond) { console.log('FAIL: ' + msg); process.exit(1); } console.log('  OK ' + msg); };

(async () => {
  await new Promise(r => setTimeout(r, 30));

  // 1. 初始化: expCount 显示条数, 导出按钮可用
  assert(String(elements.get("expCount").textContent).includes("2"), '1. 初始显示已录 2 条(实际: ' + elements.get('expCount').textContent + ')');
  assert(!elements.get('btnExpJmx').disabled, '2a. 有数据时导出按钮可用');

  // 2. JMX 一键导出: 登录前置 setUp 线程组全局一次(v1.0.91) + 关联参数化生效 + AI 链提取器注入 +
  //    CSV 数据驱动(v1.0.82: 链变量 v_tok → 生成 data.csv + JMX 引用)
  downloads.length = 0;
  await elements.get('btnExpJmx').onclick();
  const jmxDl = downloads.find((d) => d.filename.endsWith('.jmx'));
  const csvDl = downloads.find((d) => d.filename.endsWith('.csv'));
  assert(!!jmxDl, '3a. JMX 下载(实得文件: ' + downloads.map((d) => d.filename).join(', ') + ')');
  const jmx = jmxDl.text;
  assert(!!csvDl && csvDl.text.includes('v_tok') && csvDl.text.includes('DAN1'), '3a2. 链变量 v_tok 生成 data.csv(表头+录制值): ' + (csvDl ? JSON.stringify(csvDl.text) : '无'));
  // v1.0.91: 登录前置默认 setUp 线程组(全局只登 1 次, 主组共享 Cookie), 不再是 OnceOnlyController
  assert(jmx.includes('SetupThreadGroup') && jmx.includes('shared_cookie'), '3b. 登录前置自动包 setUp 线程组(全局一次+共享Cookie)');
  assert(jmx.includes('${__time()}'), '3c. 关联结果(时间戳参数化)从 storage 生效');
  assert(jmx.includes('JSONPostProcessor') && jmx.includes('token') && jmx.includes('${v_tok}'), '3c2. AI 链从 storage 生效(提取器+变量替换)');
  // 3d 锚 orderName 键名而非值 DAN1: 3c2 链替换生效后, body 值已换 \${v_tok}(键在值换)。
  assert(jmx.includes('orderName') && !jmx.includes('[object Object]'), '3d. body 为真实字符串(键名保留)');
  assert(jmx.includes('CSVDataSet') && jmx.includes('variableNames') && jmx.includes('v_tok'), '3d2. JMX 挂 CSVDataSet 引用链变量');
  // v1.0.94: .jmx 内引用的 csvFile 默认值必须与实际下载的 .csv 文件名严格一致 ——
  // 之前两次独立 stamp() 跨秒错位 → JMeter 找不到 CSV → 主线程组静默 0 采样器。
  const csvRef = (jmx.match(/__P\(csvFile,([^)]+)\)/) || [])[1];
  assert(!!csvRef && csvDl && csvRef === csvDl.filename, '3d3. JMX 引用的 CSV 文件名与实际下载一致(防 stamp 跨秒错位): ' + csvRef + ' vs ' + (csvDl ? csvDl.filename : '无'));

  // 3. PY 导出
  downloads.length = 0;
  await elements.get('btnExpPy').onclick();
  assert(downloads.length === 1 && downloads[0].filename.endsWith('.py'), '4a. PY 下载 1 个文件');
  assert(downloads[0].text.includes('def step_') && downloads[0].text.includes('DAN1'), '4b. PY 含函数与 body');
  assert(downloads[0].text.includes('v_tok') && downloads[0].text.includes('token'), '4c. PY 应用 AI 链(ctx 变量池提取+替换)');

  // 4. 全部下载 = JSONL + JMX + CSV + PY(v1.0.82: 链变量让 JMX 附带 data.csv)
  downloads.length = 0;
  await elements.get('btnExpAll').onclick();
  const dlAll = downloads.map((d) => d.filename).join(', ');
  assert(downloads.some((d) => d.filename.endsWith('.jsonl')) && downloads.some((d) => d.filename.endsWith('.jmx')) && downloads.some((d) => d.filename.endsWith('.py')), '5a. 全部下载含 JSONL/JMX/PY: ' + dlAll);
  const jsonl = downloads.find(d => d.filename.endsWith('.jsonl'));
  assert(jsonl && jsonl.text.includes('DAN1'), '5b. JSONL 含业务 body');
  assert(downloads.some((d) => d.filename.endsWith('.csv')) && downloads.some((d) => d.filename.endsWith('.jmx')), '5b2. CSV 数据驱动伴随 JMX 导出: ' + dlAll);

  // 5. 空数据: 按钮禁用
  recInfoCount = 0;
  storageData.set('toolbox.harvest', { v: 1, entries: [] });
  // refresh 是 async(setInterval 由 stub 掉, 这里手动再触发一轮 setState -> syncExportButtons)
  await vm.runInContext('refresh()', sandbox);
  await new Promise(r => setTimeout(r, 30));
  assert(elements.get('btnExpJmx').disabled && elements.get('btnExpAll').disabled, '6a. 空数据导出按钮禁用');

  // 6. 损坏信封明示(v1.0.56): 数据存在但结构非法时, popup 不能只显 0 条数 ——
  // 用户会误读成"没录上"然后重录覆盖真数据。主路径 getRecInfo 带 harvestCorrupt=true
  // → expCount 明示"数据损坏, 已隔离"(与侧栏同语义), 而非裸数字。
  recInfoCorrupt = true;
  await vm.runInContext('refresh()', sandbox);
  await new Promise(r => setTimeout(r, 30));
  assert(String(elements.get('expCount').textContent).includes('损坏'), '7a. 损坏信封明示而非裸条数: ' + elements.get('expCount').textContent);

  // 7. 消息通道死锁 → catch 直读兜底分支(v1.0.56 加的 decode 损坏判定, 一直零覆盖):
  // sendMessage throw(worker 被杀/通道死锁)时 popup 走 storage 直读 —— 损坏判定逻辑
  // (decoded===null)只在主路径(getRecInfo 带 harvestCorrupt)被测过, 兜底分支的自己
  // decode 是独立代码路径。两条件叠加才可达: msgChannelDead + storage 里放损坏信封。
  msgChannelDead = true;
  storageData.set('toolbox.harvest', 'not-an-envelope'); // decodeHarvest 对非信封结构返回 null
  await vm.runInContext('refresh()', sandbox);
  await new Promise(r => setTimeout(r, 30));
  assert(String(elements.get('expCount').textContent).includes('损坏'), '8a. 通道死锁+损坏信封: catch 直读分支也明示损坏(非裸 0): ' + elements.get('expCount').textContent);
  // 8b 对照: 通道死锁 + 正常数据 → 兜底分支条数照常(解码正常)
  storageData.set('toolbox.harvest', { v: 1, entries: [
    { id: 1, method: 'GET', url: 'https://app.test.com/a', path: '/a', headers: {}, body: '', status: 200, response: '', mime: '', ts: '' },
  ]});
  storageData.set('toolbox.recording', 'recording');
  await vm.runInContext('refresh()', sandbox);
  await new Promise(r => setTimeout(r, 30));
  assert(String(elements.get('expCount').textContent) === '1', '8b. 通道死锁+正常数据: 兜底分支条数照常: ' + elements.get('expCount').textContent);
  assert(String(elements.get('stLabel').textContent) === 'REC', '8c. 通道死锁+正常数据: 兜底分支状态照常(recording): ' + elements.get('stLabel').textContent);
  // stub 开关全复原(v1.0.59): 此前 recInfoCorrupt/recInfoCount 置位后不复原 —— 当前 8 是
  // 最后一个场景无伤害, 但未来在 8 后加场景 9 会被"损坏信封还挂着"暗坑(check_trim_sync 2d
  // 同款 stub 状态泄漏教训)。测试尾部统一归位, 让"加场景"不继承隐式状态。
  msgChannelDead = false;
  recInfoCorrupt = false;
  recInfoCount = 2;

  // 9. siteReady 门槛(v1.0.73, #167): 域名未配置 → 录制按钮隐藏, site 行出
  //    "＋ 添加此域名"快捷按钮; 一键添加 → 授权+入列+按钮恢复。此前"未配置域名"在
  //    popup 零呈现(要自己去 options), 用户点了录制也全被过滤丢掉。
  storageData.delete('toolbox.domains');
  storageData.set('toolbox.harvest', { v: 1, entries: [] }); // 空库: 导出组此时才随门槛隐藏
  recInfoCount = 0;
  await vm.runInContext('refresh()', sandbox);
  await new Promise(r => setTimeout(r, 30));
  assert(elements.get('btnRecord').style.display === 'none', '9a. 域名未配置: 录制按钮隐藏');
  assert(elements.get('btnExpJmx').style.display === 'none', '9b. 域名未配置且空库: 导出按钮隐藏');
  assert(elements.get('btnAddSite'), '9c. 域名未配置: site 行有快捷添加按钮');
  assert(String(elements.get('site').innerHTML).includes('添加此域名'), '9d. 快捷按钮文案在: ' + elements.get('site').innerHTML.slice(-90));
  // 9e. 有数据时导出保留(数据在库里, 导出与当前域名无关): 灌 1 条再 refresh
  storageData.set('toolbox.harvest', { v: 1, entries: [
    { id: 1, method: 'GET', url: 'https://app.test.com/a', path: '/a', headers: {}, body: '', status: 200, response: '', mime: '', ts: '' },
  ]});
  recInfoCount = 1;
  await vm.runInContext('refresh()', sandbox);
  await new Promise(r => setTimeout(r, 30));
  assert(elements.get('btnRecord').style.display === 'none', '9e1. 未配置时录制仍藏(不因有数据复活)');
  assert(elements.get('btnExpHar').style.display === '' && !elements.get('btnExpHar').disabled, '9e2. 未配置但有数据: 导出保留且可用');
  // 一键添加: granted stub 已自动 granted, 点按钮后清单入列 + siteReady 恢复
  lastRequest = null;
  await elements.get('btnAddSite').onclick();
  await new Promise(r => setTimeout(r, 50));
  const domainsNow = (storageData.get('toolbox.domains') || []);
  assert(domainsNow.includes('app.test.com'), '9f. 一键添加后域名入列: ' + JSON.stringify(domainsNow));
  assert(lastRequest && lastRequest.includes('https://app.test.com/*') && lastRequest.includes('http://app.test.com/*'),
    '9g. 申请的 origins 与 domainToOrigins 同款(两协议): ' + JSON.stringify(lastRequest));
  assert(elements.get('btnRecord').style.display === '' , '9h. 添加后录制按钮恢复');
  assert(String(elements.get('site').innerHTML).includes('已配置'), '9i. 添加后 site 行显示已配置态: ' + elements.get('site').innerHTML.slice(0, 80));
  // 9j. 手势约束静态断言: permissions.request 必须在 onclick 同步路径上发起
  //     (前面垫 await 手势必失效 —— v1.0.9 实锤教训, options addDomain 同款)。
  const popSrc = fs.readFileSync(ROOT + '/popup/popup.js', 'utf8');
  assert(/function onAddSite\(\) \{[\s\S]*?chrome\.permissions\.request/.test(popSrc)
    && !/onAddSite\(\) \{[\s\S]*?await[\s\S]*?chrome\.permissions\.request/.test(popSrc),
    '9j. onAddSite 内 request 同步发起(手势内零 await 前置)');
  // 9k. domains 推送盲区(v1.0.73, #168 方向①): onChanged 只听 recording/harvest 时,
  //     popup 开着 + 用户在 options 删当前域名 → siteReady 不重算 → 录制按钮还亮着,
  //     点了全被过滤丢。修: onChanged 增听 toolbox.domains → refresh 重判。
  //     行为级: 模拟 onChanged 推送 domains 变更, 断录制按钮藏回去。
  assert(String(popSrc).includes('changes["toolbox.domains"]'), '9k1. onChanged 增听 toolbox.domains(静态)');
  // 预置回就绪态再推送"清单清空"
  storageData.set('toolbox.domains', ['app.test.com']);
  await vm.runInContext('refresh()', sandbox);
  await new Promise(r => setTimeout(r, 30));
  assert(elements.get('btnRecord').style.display === '', '9k2. 预置: domains 有当前域 → 录制按钮亮');
  // onChanged 监听体在 popup.js 顶层挂载时已被 stub 捕获(onChangedFns[0]) ——
  // 顶层挂载只在脚本加载时发生一次, 中途替换 addListener 拿不到真身。
  const onChangedFn = onChangedFns.length ? onChangedFns[0] : null;
  assert(onChangedFn, '9k3. onChanged 监听体可达(captured: ' + onChangedFns.length + ')');
  // 推送"清单清空" → siteReady 重算 → 录制按钮藏
  storageData.delete('toolbox.domains');
  onChangedFn({ 'toolbox.domains': { newValue: undefined, oldValue: ['app.test.com'] } }, 'local');
  await new Promise(r => setTimeout(r, 50));
  assert(elements.get('btnRecord').style.display === 'none', '9k4. options 删当前域名(popup 开着) → 推送后录制按钮藏');
  // 尾态归位: 清单回填, 不污染后续场景
  storageData.set('toolbox.domains', ['app.test.com']);

  // 9l. 权限拒绝 → 回滚(v1.0.90): onAddSite 先同步存清单再申请权限(MV3 popup 在权限
  //     弹窗弹出时会被 Chrome 关闭, 回调不执行 —— 先存保证清单一定更新); 拒绝时回滚。
  //     此前旧码在 request 回调里才 setDomains, popup 关闭后回调不执行 → 域名根本没添加上。
  {
    storageData.delete('toolbox.domains');
    granted.clear();
    recInfoCount = 0;
    storageData.set('toolbox.harvest', { v: 1, entries: [] });
    await vm.runInContext('refresh()', sandbox);
    await new Promise(r => setTimeout(r, 30));
    const origRequest = sandbox.chrome.permissions.request;
    sandbox.chrome.permissions.request = (p, cb) => { lastRequest = [...p.origins]; cb(false); };
    await elements.get('btnAddSite').onclick();
    await new Promise(r => setTimeout(r, 50));
    const domainsAfterDeny = (storageData.get('toolbox.domains') || []);
    assert(!domainsAfterDeny.includes('app.test.com'), '9l. 权限拒绝: 域名回滚不入列: ' + JSON.stringify(domainsAfterDeny));
    sandbox.chrome.permissions.request = origRequest;
    storageData.set('toolbox.domains', ['app.test.com']);
    granted.add('https://app.test.com/*');
  }

  // 10. refreshSafe unhandled rejection 兜底(v1.0.75, #169 方向③): refresh() 的
  //     调用点大多不在可接 promise 的上下文(顶层加载/onChanged 回调/setTimeout 回调),
  //     tabs.query 等 API 异常若无人接就是 unhandled rejection —— v1.0.74 前探针实锤
  //     一次排 2 个(quickExport 主链 + 3s 定时器)。修: 全调用点改走 refreshSafe(接住
  //     后静默降级, 保持当前 UI 态, 下次手势/推送重拉自愈)。
  //     行为级: tabs.query 抛错 → quickExport/setExpNote 3s 定时器链全程零 unhandled
  //     rejection, 且 expCount 提示文本不被半截 refresh 覆盖(静默降级语义)。
  {
    let unhandledCount = 0;
    process.on('unhandledRejection', () => { unhandledCount++; });
    sandbox.__tabsQueryOrig = sandbox.chrome.tabs.query;
    vm.runInContext(`chrome.tabs.query = async () => { throw new Error('tabs.query rejected'); };`, sandbox);
    storageData.set('toolbox.harvest', { v: 1, entries: [] });
    await vm.runInContext('quickExport(["jmx"])', sandbox).catch(() => {}); // setExpNote("还没有录制数据") → 排 3s 定时器
    assert(String(elements.get('expCount').textContent).includes('还没有'), '10a. tabs.query 抛错时导出提示照常呈现: ' + elements.get('expCount').textContent);
    await new Promise(r => setTimeout(r, 3500)); // 过 3s 定时器窗口
    // refreshSafe 接住后不动 expCount(保持提示文本而非崩成裸 0) —— 静默降级
    console.log('  (3s 后 expCount: ' + JSON.stringify(elements.get('expCount').textContent) + ', unhandled: ' + unhandledCount + ')');
    assert(unhandledCount === 0, '10b. tabs.query 抛错全程零 unhandled rejection(refreshSafe 接住): ' + unhandledCount);
    vm.runInContext(`chrome.tabs.query = __tabsQueryOrig;`, sandbox);
    // 复原验证: 正常路径 quickExport 后条数照常还原
    storageData.set('toolbox.harvest', { v: 1, entries: [
      { id: 1, method: 'GET', url: 'https://app.test.com/a', path: '/a', headers: {}, body: '', status: 200, response: '', mime: '', ts: '' },
    ]});
    recInfoCount = 1;
    downloads.length = 0;
    await vm.runInContext('refreshSafe()', sandbox);
    await new Promise(r => setTimeout(r, 30));
    assert(String(elements.get('expCount').textContent) === '1', '10c. 复原后 refreshSafe 正常路径照常还原条数');
  }

  console.log('');
  console.log('=== E2E POPUP PASS ===');
})();
