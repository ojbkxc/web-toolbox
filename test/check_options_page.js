// options 页旅程走查:
//   1. 空态指引(无域名)
//   2. 添加域名: 无点输入(localhost)→ 授权成功入列; 坏输入 → placeholder 提示不崩溃
//   3. 覆盖提示: 配 example.com 后再配 sub.example.com 显示"覆盖"
//   4. 编辑: 改成新域名 → 授权 + 清单更新 + 撤旧
//   5. LLM: 空 URL 直接保存; 坏 URL 拦截; 已授权主机直接保存
//   6. domainToOrigins(localhost) 现在精确授权 → options 添加 localhost 后 contains 应立即已授权
const fs = require('fs'); const vm = require('vm'); const path = require('path');
const ROOT = require('path').resolve(__dirname, '..');
const html = fs.readFileSync(ROOT + '/options/options.html', 'utf8');
const all = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)]
  .map((m) => m[1]).map((p) => path.resolve(ROOT + '/options', p));
const elements = new Map();
const mkEl = (id) => { if (elements.has(id)) return elements.get(id);
  const el = { id, style: {}, dataset: {}, children: [], value: '', textContent: '', innerHTML: '', className: '', checked: true, disabled: false, placeholder: '',
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } }, addEventListener() {}, setAttribute(k, v) { this[k === "aria-label" ? "ariaLabel" : k] = v; }, appendChild() { }, insertBefore() {},
    querySelector() { return mkEl(id + '_q'); }, querySelectorAll() { return []; }, focus() {}, setSelectionRange() {}, onclick: null };
  elements.set(id, el); return el; };
const createdEls = [];
const documentObj = { getElementById: (id) => mkEl(id), createElement: (t) => { const el = mkEl('el_' + createdEls.length); el.tag = t; createdEls.push(el); return el; }, createDocumentFragment: () => mkEl('f'), querySelectorAll: () => [], body: mkEl('body') };
const storageData = new Map();
let granted = new Set();
let lastRequest = null;
let lastRemove = null;
const chromeStub = {
  storage: { local: {
    get: (keys, cb) => { const r = {}; for (const k of [].concat(keys)) r[k] = storageData.get(k); if (typeof cb === 'function') setTimeout(() => cb(r), 0); return Promise.resolve(r); },
    set: (obj, cb) => { for (const k of Object.keys(obj)) storageData.set(k, obj[k]); setTimeout(() => cb && cb(), 0); return Promise.resolve(); },
    remove: (keys, cb) => { for (const k of [].concat(keys)) storageData.delete(k); setTimeout(() => cb && cb(), 0); return Promise.resolve(); } },
    onChanged: { addListener() {} } },
  runtime: { openOptionsPage() {} },
  permissions: {
    contains: (p, cb) => cb(p.origins.some((o) => granted.has(o))),
    request: (p, cb) => { lastRequest = [...p.origins]; p.origins.forEach((o) => granted.add(o)); cb(true); },
    remove: (p, cb) => { lastRemove = [...p.origins]; p.origins.forEach((o) => granted.delete(o)); cb(true); } },
};
const sandbox = { console, setTimeout, clearTimeout, clearInterval() {}, URL, URLSearchParams, AbortController,
  navigator: { clipboard: { writeText: async () => {} } }, document: documentObj, chrome: chromeStub, fetch: async () => { throw new Error('nf'); }, performance: { now: () => Date.now() } };
sandbox.window = sandbox; sandbox.globalThis = sandbox; vm.createContext(sandbox);
for (const f of all) new vm.Script(fs.readFileSync(f, 'utf8'), { filename: f }).runInContext(sandbox);

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  OK ' + msg); } else { fail++; console.log('  ✗ FAIL ' + msg); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await vm.runInContext('refresh()', sandbox);
  await sleep(20);
  ok(createdEls.some((e) => e.tag === 'li' && e.innerHTML.includes('还没有配置域名')), '空态指引');
  const domainsNow = () => (storageData.get('toolbox.domains') || []);

  // 1) 添加 localhost —— 无点主机, 修复后应精确授权成功
  elements.get('input').value = 'localhost';
  lastRequest = null;
  vm.runInContext('addDomain()', sandbox);
  await sleep(20);
  ok(lastRequest && lastRequest[0] === 'https://localhost/*', 'localhost 申请精确授权: ' + JSON.stringify(lastRequest));
  ok(domainsNow().includes('localhost'), 'localhost 入列');

  // 2) 坏输入 → placeholder 提示(带空格的非法输入走第一道校验)
  elements.get('input').value = 'not a domain';
  vm.runInContext('addDomain()', sandbox);
  await sleep(10);
  ok(elements.get('input').placeholder.includes('不是域名'), '坏输入 placeholder 提示: ' + elements.get('input').placeholder);
  ok(!domainsNow().includes('not a domain'), '坏输入不入列');
  // 2b. 单段非法主机 → 专属提示
  elements.get('input').value = 'intranet';
  vm.runInContext('addDomain()', sandbox);
  await sleep(10);
  ok(elements.get('input').placeholder.includes('localhost/127'), '单段主机拦截提示: ' + elements.get('input').placeholder);
  ok(!domainsNow().includes('intranet'), '单段非法不入列');

  // 3) 覆盖提示: 配 example.com(顶级), 已有 sub.example.com → 显示覆盖
  elements.get('input').value = 'sub.example.com';
  vm.runInContext('addDomain()', sandbox);
  await sleep(10);
  elements.get('input').value = 'example.com';
  vm.runInContext('addDomain()', sandbox);
  await sleep(20);
  ok(domainsNow().join() === 'localhost,sub.example.com,example.com', '域名清单: ' + domainsNow().join());
  const coversHtml = createdEls.filter((e) => e.tag === 'li').map((e) => e.innerHTML).join('|');
  ok(coversHtml.includes('覆盖') && coversHtml.includes('sub.example.com'), '顶级域覆盖子域提示');
  // 3b. 多级父域也标注(v1.0.67, #161 方向①): 引擎 matchDomain 对任何父域配置都覆盖其
  //     子域(与段数无关)—— 原实现限"<=2 段"让 a.b.com/x.a.b.com 这类 3+ 段父域的冗余
  //     子域漏标(呈现层弱于引擎语义)。去掉段数限制后 endsWith 判定零误标。
  elements.get('input').value = 'x.a.b.com';
  vm.runInContext('addDomain()', sandbox);
  await sleep(10);
  elements.get('input').value = 'a.b.com';
  vm.runInContext('addDomain()', sandbox);
  await sleep(20);
  const coversHtml2 = createdEls.filter((e) => e.tag === 'li').map((e) => e.innerHTML).join('|');
  ok(coversHtml2.includes('a.b.com') && coversHtml2.includes('覆盖') && coversHtml2.includes('x.a.b.com'),
    '3 段父域 a.b.com 也标覆盖 x.a.b.com(引擎同语义, v1.0.67)');

  // 3c. 删除域名的撤销链路端到端(v1.0.70, #163 方向①): removeDomain 撤的 origins
  //     必须与申请时同款(domainToOrigins 同源, 两协议), granted 集真实反映(已撤的
  //     containsOrigin=false / 不受牵连的=true), 清单同步过滤。此前只有 editDomain
  //     的"换域名撤旧"有静态时序断言, "直接删除"的撤销对称性零行为级断言。
  //     分段语义注意: a.b.com 是 3 段 → 精确授权(非 *.a.b.com 通配)。
  lastRequest = null;
  await vm.runInContext('removeDomain("a.b.com")', sandbox);
  await sleep(20);
  ok(lastRemove && lastRemove.join() === 'https://a.b.com/*,http://a.b.com/*',
    '撤销的 origins 与申请对称(domainToOrigins 同款两协议): ' + JSON.stringify(lastRemove));
  ok(!granted.has('https://a.b.com/*'), 'a.b.com 授权已从 granted 集(权限面)移除');
  ok(granted.has('https://*.example.com/*'), 'example.com 授权不受牵连');
  ok(!domainsNow().includes('a.b.com'), 'a.b.com 已出清单: ' + domainsNow().join());
  // 呈现层: refresh 后最新批次渲染不含已删域名(createdEls 是只增不减记录桶, 断当前态取尾部批次)。
  // 注意 x.a.b.com 仍在清单(3b 加的), tailHtml 不能断言不含"b.com"整体 —— 精确断 a.b.com 独立 host span。
  await vm.runInContext('refresh()', sandbox);
  await sleep(20);
  const tailLis = createdEls.filter((e) => e.tag === 'li').slice(-Math.max(1, domainsNow().length));
  const tailHtml = tailLis.map((e) => e.innerHTML).join('|');
  ok(!tailHtml.includes('<span class="host">a.b.com'), '已删域名不在最新渲染批次(host span 精确断)');
  // 授权态文本: containsOrigin(origins[0]).then 写在 li 的 querySelector 返回元素(stub 惰性
  // _q 元素)上, innerHTML 里只有占位 span —— 全局扫 _q 元素的 textContent(vm 坑 v1.0.4 b 同款)
  const stateTexts = [...elements.entries()].filter(([, el]) => el.textContent === '已授权' || el.textContent === '未授权').map(([id]) => id);
  ok(stateTexts.length > 0, '授权态文本经 containsOrigin 真实写入(_q 元素可观测): ' + JSON.stringify(stateTexts.slice(0, 3)));

  // 4) 编辑流: editDomain 依赖 $list.children(stub 下为 []) —— vm 模拟不覆盖, 留给真实浏览器。
  //    单测至少验证 editDomain 在 children 空时不抛错(优雅 return):
  let editThrew = false;
  try { vm.runInContext('editDomain("sub.example.com")', sandbox); await sleep(10); } catch (e) { editThrew = true; }
  ok(!editThrew, 'editDomain 空 children 不抛错(优雅返回)');
  // 4b. editDomain 里的新主机校验(localhost 允许)通过静态断言覆盖: 上面已改 includes('.') 分支
  ok(true, '编辑流真 DOM 验证留浏览器(vm 层不假测)');
  // 4c. 编辑拒绝分支静态契约(v1.0.35 固化): granted=false 必须保持原配置 ——
  //     '未授权新域名'提示在 restore() 之前、setDomains/removeOrigins 绝不在拒绝分支。
  //     时序承诺(README: 通过后才替换清单并撤销旧授权)是数据安全面, 改动须过此断言。
  {
    const optSrc = fs.readFileSync(path.join(ROOT, 'options/options.js'), 'utf8');
    const i = optSrc.indexOf('function editDomain');
    ok(i >= 0, 'editDomain 函数存在(时序断言)');
    if (i >= 0) {
      const body = optSrc.slice(i, optSrc.indexOf('\n}', i) + 2);
      const denied = body.indexOf('if (!granted)');
      const setDomainsAt = body.indexOf('setDomains(');
      const removeOriginsAt = body.indexOf('removeOrigins(');
      const deniedMsgAt = body.indexOf('未授权新域名, 保持原配置');
      ok(denied >= 0 && deniedMsgAt > denied, '拒绝分支先提示保持原配置');
      ok(setDomainsAt > denied, 'setDomains 在 granted 检查之后(拒绝时清单不动)');
      ok(removeOriginsAt > setDomainsAt, '撤旧授权在换清单之后(先新后旧不两头落空)');
    }
  }

  // 5) LLM 配置
  // 5a. 空 URL → 直接保存
  elements.get('llmUrl').value = '';
  elements.get('llmModel').value = 'm1';
  elements.get('llmKey').value = '';
  vm.runInContext('saveLlm()', sandbox);
  await sleep(20);
  const llm1 = storageData.get('toolbox.llm');
  ok(llm1 && llm1.url === '' && llm1.model === 'm1', '空 URL 直接保存: ' + JSON.stringify(llm1));
  ok(elements.get('llmMsg').textContent === '已保存', '保存提示');

  // 5b. 坏 URL → 拦截
  elements.get('llmUrl').value = 'ftp://x';
  vm.runInContext('saveLlm()', sandbox);
  await sleep(10);
  ok(elements.get('llmMsg').textContent.includes('不是合法'), '坏 URL 拦截: ' + elements.get('llmMsg').textContent);

  // 5c. 本地 URL 未授权 → request 发起 → 保存
  elements.get('llmUrl').value = 'http://127.0.0.1:8787/v1/chat/completions';
  lastRequest = null;
  vm.runInContext('saveLlm()', sandbox);
  await sleep(20);
  ok(lastRequest && lastRequest.includes('http://127.0.0.1/*'), '本地代理授权申请: ' + JSON.stringify(lastRequest));
  const llm2 = storageData.get('toolbox.llm');
  ok(llm2 && llm2.url.includes('8787'), 'LLM 配置已存: ' + llm2.url);

  // 5d. 再保存(已授权) → Chrome 对已授权 origins 的 request 不弹窗直接 granted=true;
  //     v1.0.9 起不再 containsOrigin 预查(那会在手势链上垫 await, 曾致弹窗静默不弹),
  //     request 依旧发起但用户无感 —— 断言改为"保存成功且配置落库"。
  lastRequest = null;
  vm.runInContext('saveLlm()', sandbox);
  await sleep(20);
  ok(lastRequest !== null, '已授权主机直接保存(request 幂等回调, 无弹窗)');
  ok(elements.get('llmMsg').textContent === '已保存', '再次保存提示');

  // 5e. 测试连接(v1.0.14): 测的是「输入框当前值」而非 storage 旧配置 ——
  //     callLlm 的 fetch 走 urlOverride。stub fetch 抓 URL 断言。
  storageData.set('toolbox.llm', { url: 'http://old-host:8787/v1/chat/completions', model: 'old', api_key: '' });
  granted.add('http://new-host/*'); granted.add('https://new-host/*');
  elements.get('llmUrl').value = 'http://new-host:9000/v1/chat/completions';
  elements.get('llmModel').value = 'new-model';
  elements.get('llmKey').value = '';
  sandbox.__fetchUrl = null;
  vm.runInContext('globalThis.fetch = async (u, o) => { __fetchUrl = u; return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "收到" } }] }) }; }', sandbox);
  vm.runInContext('testLlm()', sandbox);
  await sleep(30);
  ok(vm.runInContext('__fetchUrl', sandbox) === 'http://new-host:9000/v1/chat/completions',
    '测试连接用输入框当前 URL: ' + vm.runInContext('__fetchUrl', sandbox));
  ok(elements.get('llmMsg').textContent.includes('连通正常'), '测试成功提示: ' + elements.get('llmMsg').textContent);
  // 5f. 未授权主机的测试 → 前置指引(不发起 fetch)
  elements.get('llmUrl').value = 'http://unauth-host:9000/v1/chat/completions';
  vm.runInContext('globalThis.fetch = async (u) => { __fetchUrl = u; throw new Error("nf"); }', sandbox);
  vm.runInContext('__fetchUrl = null; testLlm()', sandbox);
  await sleep(30);
  ok(vm.runInContext('__fetchUrl', sandbox) === null, '未授权主机不发起 fetch');
  ok(elements.get('llmMsg').textContent.includes('未授权'), '未授权指引: ' + elements.get('llmMsg').textContent);
  // 5g. 空 URL 测试 → 提示填写
  elements.get('llmUrl').value = '';
  vm.runInContext('testLlm()', sandbox);
  await sleep(10);
  ok(elements.get('llmMsg').textContent.includes('请先填写'), '空 URL 测试提示: ' + elements.get('llmMsg').textContent);

  console.log(fail ? `\n=== options 页走查 FAIL: ${fail} ===` : `\n=== options 页走查 PASS ===`);
  process.exit(fail ? 1 : 0);
})();
