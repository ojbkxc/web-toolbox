// Cookie 页与 domainToOrigins 旅程走查:
//   1. domainToOrigins(localhost) 无点主机 → 精确授权(原 *.localhost 匹配不了裸主机)
//   2. Cookie 页加载: 授权成功 → 状态行明示数量/域名/父域来源; 0 个 Cookie → 空态指引
//   3. 未授权 → 按钮禁用 + 指引文案; 父域继承 → viaParent 提示
//   4. 搜索无命中 → 空态指引(不再白屏表)
//   5. localhost 域 Cookie 查询不因无点跳过
const fs = require('fs'); const vm = require('vm'); const path = require('path');
const ROOT = require('path').resolve(__dirname, '..');
const html = fs.readFileSync(ROOT + '/sidepanel/sidepanel.html', 'utf8');
const all = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)]
  .map((m) => m[1]).map((p) => path.resolve(ROOT + '/sidepanel', p));
const elements = new Map();
const mkEl = (id) => { if (elements.has(id)) return elements.get(id);
  const el = { id, style: {}, dataset: {}, children: [], value: '', textContent: '', innerHTML: '', className: '', checked: true, disabled: false,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } }, addEventListener() {}, appendChild() {}, setAttribute(k, v) { this[k === "aria-label" ? "ariaLabel" : k] = v; }, insertBefore() {},
    querySelector() { return mkEl(id + '_q'); }, querySelectorAll() { return []; }, scrollIntoView() {}, onclick: null };
  elements.set(id, el); return el; };
const documentObj = { getElementById: (id) => mkEl(id), createElement: () => { const el = mkEl('el_' + createdEls.length + '_' + Math.random().toString(36).slice(2, 6)); createdEls.push(el); return el; }, createDocumentFragment: () => mkEl('f'), querySelectorAll: () => [], body: mkEl('body') };
const createdEls = []; // createElement 记录桶: appendChild 是空操作, 断言行渲染要看 tr 的 innerHTML
const storageData = new Map();
let grantedOrigins = new Set(['https://a.b.com/*']); // options 添加 a.b.com(3 段 → 精确授权 a.b.com)
const cookieStore = [
  { domain: 'a.b.com', name: 'sess', value: 'S1', path: '/', httpOnly: true },
  { domain: '.a.b.com', name: 'tok', value: 'T1', path: '/', httpOnly: false },
  { domain: 'localhost', name: 'loc', value: 'L1', path: '/', httpOnly: false },
];
// 注意: containsOrigin 是 new Promise(回调式 chrome.permissions.contains) 包装 ——
// mock 必须同步调 cb, 签名错了 Promise 永不 resolve, 整条 await 链卡死(测试 3s 超时的根因)。
const chromeStub = {
  storage: { local: {
    get: (keys, cb) => { const r = {}; for (const k of [].concat(keys)) r[k] = storageData.get(k); if (typeof cb === 'function') setTimeout(() => cb(r), 0); return Promise.resolve(r); },
    set: (obj, cb) => { for (const k of Object.keys(obj)) storageData.set(k, obj[k]); setTimeout(() => cb && cb(), 0); return Promise.resolve(); },
    remove: (keys, cb) => { for (const k of [].concat(keys)) storageData.delete(k); setTimeout(() => cb && cb(), 0); return Promise.resolve(); } },
    onChanged: { addListener() {} } },
  runtime: { sendMessage: async () => ({ ok: true, recState: 'idle', count: 0, pending: 0, attachedTabs: 0, domains: [], unmatched: [], harvestCorrupt: false }), openOptionsPage() {} },
  tabs: { query: async () => [{ id: 1, url: 'https://sub.a.b.com/x' }] },
  scripting: { executeScript: async () => [{ result: { status: 200, ok: true, text: '{}' } }] },
  sidePanel: {}, permissions: {
    contains: (p, cb) => cb(p.origins.some((o) => grantedOrigins.has(o))),
    request: (p, cb) => { p.origins.forEach((o) => grantedOrigins.add(o)); cb(true); } },
  cookies: { getAll: async (q) => cookieStore.filter((c) => c.domain === q.domain || c.domain === '.' + q.domain
    || c.domain.endsWith('.' + q.domain)) }, // Chrome 真实语义: domain 参数是后缀匹配(含子域)
};
const sandbox = { console, setTimeout, setInterval: () => 0, clearInterval() {}, URL, URLSearchParams, fetch: async () => { throw new Error('nf'); },
  navigator: { clipboard: { writeText: async () => {} } }, document: documentObj, chrome: chromeStub, performance: { now: () => Date.now() }, confirm: () => true, alert() {} };
sandbox.window = sandbox; sandbox.globalThis = sandbox; vm.createContext(sandbox);
for (const f of all) new vm.Script(fs.readFileSync(f, 'utf8'), { filename: f }).runInContext(sandbox);

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  OK ' + msg); } else { fail++; console.log('  ✗ FAIL ' + msg); } };

(async () => {
  // 0) 纯函数: domainToOrigins 无点主机
  const o1 = vm.runInContext('domainToOrigins("localhost")', sandbox);
  ok(JSON.stringify(o1) === JSON.stringify(['https://localhost/*', 'http://localhost/*']), 'localhost → 精确授权: ' + JSON.stringify(o1));
  const o2 = vm.runInContext('domainToOrigins("127.0.0.1")', sandbox);
  ok(JSON.stringify(o2) === JSON.stringify(['https://127.0.0.1/*', 'http://127.0.0.1/*']), '127.0.0.1(带点但 IP 语义)照旧: ' + JSON.stringify(o2));
  const o3 = vm.runInContext('domainToOrigins("example.com")', sandbox);
  ok(o3[0] === 'https://*.example.com/*', '普通域仍 *.host 通配: ' + o3[0]);

  // 1) 父域授权的子站: sub.a.b.com(a.b.com 已配)→ viaParent 提示 + 域 Cookie 取到。
  // host-only Cookie(sess, domain=a.b.com 无点)不跨子域发送(RFC 6265), 滤掉是正确行为;
  // 子站只能拿域 Cookie(.a.b.com)。
  await vm.runInContext('loadCookiesForActiveTab()', sandbox);
  const ckCount = vm.runInContext('cookies.length', sandbox);
  ok(ckCount === 1, 'sub.a.b.com 经父域授权取到 1 个域 Cookie(host-only 不跨子域, 实得 ' + ckCount + ')');
  ok(vm.runInContext('cookies[0].name', sandbox) === 'tok', '取到的正是域 Cookie tok');
  const msg = elements.get('ckMsg').textContent;
  ok(msg.includes('1 个 Cookie') && msg.includes('sub.a.b.com'), '状态行明示数量与域名: ' + msg);
  ok(msg.includes('父域'), '父域来源提示: ' + msg);

  // 2) localhost 旅程: 无点主机, 授权 localhost 后取到 loc Cookie
  grantedOrigins.add('https://localhost/*'); grantedOrigins.add('http://localhost/*');
  vm.runInContext(`chrome.tabs.query = async () => [{ id: 2, url: 'http://localhost:8080/app' }];`, sandbox);
  await vm.runInContext('loadCookiesForActiveTab()', sandbox);
  ok(vm.runInContext('cookies.length', sandbox) === 1, 'localhost 取到 1 个 Cookie(原实现授权即被拒, 取不到)');
  ok(vm.runInContext('cookies[0].name', sandbox) === 'loc', 'localhost Cookie 名正确');

  // 3) 未授权站点 → 按钮禁用 + 指引
  grantedOrigins.clear(); // 撤掉全部授权
  vm.runInContext(`chrome.tabs.query = async () => [{ id: 3, url: 'https://evil.example.com/x' }];`, sandbox);
  await vm.runInContext('loadCookiesForActiveTab()', sandbox);
  ok(vm.runInContext('cookies.length', sandbox) === 0, '未授权站点 cookies 清空');
  const msg3 = elements.get('ckMsg').textContent;
  ok(msg3.includes('未授权') && msg3.includes('配置'), '未授权指引: ' + msg3);
  ok(elements.get('expState').disabled === true, '导出按钮禁用');

  // 4) 搜索无命中 → 空态指引而非白屏
  grantedOrigins.add('https://a.b.com/*');
  vm.runInContext(`chrome.tabs.query = async () => [{ id: 1, url: 'https://sub.a.b.com/x' }];`, sandbox);
  await vm.runInContext('loadCookiesForActiveTab()', sandbox);
  elements.get('search').value = 'zzz-no-hit';
  vm.runInContext('renderCookie()', sandbox);
  const tblHtml = elements.get('tbl').innerHTML;
  ok(tblHtml.includes('没有 Cookie 名含') && tblHtml.includes('清空搜索词'), '搜索无命中空态指引: ' + tblHtml.slice(0, 60));
  // 搜索有命中 → 正常渲染行(appendChild 是 stub 空操作, 看 createElement 生成的 tr)
  elements.get('search').value = 'tok';
  createdEls.length = 0;
  vm.runInContext('renderCookie()', sandbox);
  ok(createdEls.some((e) => e.innerHTML.includes('>tok<')), '搜索命中渲染行: ' + createdEls.map((e) => e.innerHTML).filter(Boolean).join(' | ').slice(0, 80));
  // httpOnly 标 H —— 需要一个 httpOnly Cookie 可见; 本站域 Cookie 里补一个
  vm.runInContext('cookies.push({domain:".a.b.com",name:"hx",value:"X",path:"/",httpOnly:true})', sandbox);
  elements.get('search').value = '';
  createdEls.length = 0;
  vm.runInContext('renderCookie()', sandbox);
  ok(createdEls.some((e) => e.innerHTML.includes('d93025') && e.innerHTML.includes('>H<')), 'httpOnly 标红 H: ' + createdEls.map((e) => e.innerHTML).filter(Boolean).join(' | ').slice(0, 100));

  // 5) state/curl 导出内容(此时 cookies = tok + 补的 httpOnly hx)
  const state = vm.runInContext('JSON.stringify(buildState())', sandbox);
  const st = JSON.parse(state);
  ok(st.cookies.length === 2 && st.cookies.some((c) => c.httpOnly), 'state 形态正确(含 httpOnly)');
  ok(st.cookies[0].expires === -1 && st.cookies[0].sourceScheme, 'state 字段齐(expires/sourceScheme)');
  const curl = vm.runInContext('buildCurlLine()', sandbox);
  ok(curl === 'Cookie: tok=T1; hx=X', 'curl 串形态: ' + curl);
  // 5b0) buildState 派生分支(v1.0.63, #156 方向①): 既有断言只锚 expires:-1 兜底与
  // sourceScheme 存在, expiresDate 有值(持久 cookie)与 sameSite 带引号(CDP 原始形态)
  // 两条派生分支零断言 —— 字段消费方(PY build_session/Playwright storage_state)靠
  // expires/sameSite 的正确性判会话语义, 漂移即静默错。
  const stFull = JSON.parse(vm.runInContext(`JSON.stringify(buildState())`, sandbox)
    .replace('"cookies"', '"cookies"')); // 旁路: 直接重算一次拿全字段
  ok(stFull.cookies[0].expires === -1 && stFull.cookies[0].sameSite === 'unspecified',
    '会话 cookie: expires=-1 兜底 + sameSite unspecified 兜底(无值形态)');
  vm.runInContext(`cookies.push({domain:".a.b.com",name:"persist",value:"P",path:"/",httpOnly:false,secure:true,sameSite:'"lax"',expiresDate:1893456000})`, sandbox);
  const stP = JSON.parse(vm.runInContext('JSON.stringify(buildState())', sandbox));
  const pc = stP.cookies.find((c) => c.name === 'persist');
  ok(pc && pc.expires === 1893456000, '持久 cookie: expiresDate 原值透传(非 -1)');
  ok(pc && pc.sameSite === 'lax', 'sameSite 去引号(CDP 原始形态清洗)');
  ok(pc && pc.sourceScheme === 'Secure' && pc.sourcePort === 443, 'secure cookie 派生 Secure/443');
  vm.runInContext('cookies.pop()', sandbox); // 还原, 不污染后续场景

  // 5b) getAll 后缀匹配语义(v1.0.62, #155 方向③): Chrome 的 getAll({domain:X}) 是
  //     后缀匹配 —— 查 'b.com' 时连子域 host-only cookie(other.b.com)也返回。
  //     loadCookies 的过滤条件必须按 RFC 6265 domain-match 收: 域 cookie(.X)跨子域
  //     发送 → 保留; 兄弟子域的 host-only cookie 不发给当前主机 → 丢弃。
  //     上面的 stub 已改成后缀匹配(还原 Chrome 行为), 这里钉住"兄弟子域被滤掉"。
  {
    cookieStore.push({ domain: 'other.b.com', name: 'intruder', value: 'I1', path: '/', httpOnly: false });
    grantedOrigins.clear(); grantedOrigins.add('https://a.b.com/*');
    vm.runInContext(`chrome.tabs.query = async () => [{ id: 4, url: 'https://a.b.com/x' }];`, sandbox);
    await vm.runInContext('loadCookiesForActiveTab()', sandbox);
    const names = vm.runInContext('cookies.map(c=>c.name).join(",")', sandbox);
    ok(!names.includes('intruder'), '兄弟子域 host-only(other.b.com)不混入(RFC 6265 domain-match 收口): ' + names);
    ok(names.split(',').includes('sess') && names.split(',').includes('tok'), '自身 host-only + 域 cookie 取到: ' + names);
    cookieStore.pop(); // 还原, 不污染后续场景
  }

  // 6) cookies API 异常兜底(v1.0.54 权限路径盘点): chrome.cookies.getAll 抛错(cookie
  //    store 瞬时不可用等)时, 调用点在 activate(t) 切 tab 内 —— 无 try/catch 就是
  //    unhandled rejection, Cookie 页停留旧状态无提示。行为级: 抛错 → 不冒泡、
  //    cookies 清空(按钮禁用)、错误可见。
  vm.runInContext(`chrome.cookies.getAll = async () => { throw new Error('cookie store unavailable'); };`, sandbox);
  let loadThrew = false;
  try { await vm.runInContext('loadCookiesForActiveTab()', sandbox); } catch (e) { loadThrew = true; }
  ok(!loadThrew, 'getAll 抛错不冒泡(loadCookiesForActiveTab 不炸)');
  ok(vm.runInContext('cookies.length', sandbox) === 0, '异常时 cookies 清空(按钮随 0 禁用)');
  const errMsg = elements.get('ckMsg').textContent;
  ok(errMsg.includes('读取 Cookie 失败'), '异常提示可见: ' + errMsg);

  // 6b) currentTab/授权链 API 异常兜底(v1.0.76, #170 方向① 与 popup refreshSafe 对齐):
  //     v1.0.54 的 catch 只包了 loadCookies 段, 首行 currentTab(裸 await tabs.query)与
  //     containsOrigin 判定在 try 之外 —— activate(t) 是同步 onclick, 本函数的 promise
  //     无人接, tabs.query reject 时是真 unhandled rejection。修: 抽 inner 函数全包。
  //     行为级: 恢复 getAll 正常 + tabs.query 抛错 → 零 unhandled rejection(宿主计数)、
  //     不冒泡、cookies 清空、错误可见(与 getAll 异常同文案语义)。
  vm.runInContext(`chrome.cookies.getAll = async (q) => cookieStore.filter((c) => c.domain === q.domain || c.domain === '.' + q.domain || c.domain.endsWith('.' + q.domain)); chrome.tabs.query = async () => { throw new Error('tabs.query rejected'); };`, sandbox);
  let unhandledCount = 0;
  process.on('unhandledRejection', () => { unhandledCount++; });
  let tabThrew = false;
  try { vm.runInContext('loadCookiesForActiveTab()', sandbox); } catch (e) { tabThrew = true; }
  await new Promise(r => setTimeout(r, 80));
  ok(!tabThrew, 'tabs.query 抛错不冒泡(activate 同步调用语境)');
  ok(unhandledCount === 0, 'tabs.query 抛错零 unhandled rejection(兜底接住): ' + unhandledCount);
  ok(vm.runInContext('cookies.length', sandbox) === 0, 'tabs.query 异常时 cookies 清空');
  const errMsg2 = elements.get('ckMsg').textContent;
  ok(errMsg2.includes('读取 Cookie 失败'), 'tabs.query 异常提示可见(与 getAll 异常同文案): ' + errMsg2);

  console.log(fail ? `\n=== Cookie 页走查 FAIL: ${fail} ===` : `\n=== Cookie 页走查 PASS ===`);
  process.exit(fail ? 1 : 0);
})();
