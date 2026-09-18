// AI 全链路走查:
//   1. callLlm 超时: AbortController —— 挂起网关在 timeoutMs 后返回可读错误
//   2. aiDebugFailures 消息结构: system 只在开头, 多条 bad 用【失败 N】分节进单 user
//   3. aiBuildAsserts: >30 接口前置拒绝; 进度显示 n/总数; 单接口失败不拖累整体
//   4. 卫生: 诊断/报告 prompt 不含 Cookie/Authorization; 长 token 打码
const fs = require('fs'); const vm = require('vm'); const path = require('path');
const ROOT = require('path').resolve(__dirname, '..');
const html = fs.readFileSync(ROOT + '/sidepanel/sidepanel.html', 'utf8');
const all = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)]
  .map((m) => m[1]).map((p) => path.resolve(ROOT + '/sidepanel', p));
const elements = new Map();
const mkEl = (id) => { if (elements.has(id)) return elements.get(id);
  const el = { id, style: {}, dataset: {}, children: [], value: '', textContent: '', innerHTML: '', className: '', checked: true, disabled: false,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } }, addEventListener() {}, setAttribute(k, v) { this[k === "aria-label" ? "ariaLabel" : k] = v; }, appendChild() { }, insertBefore() {},
    querySelector() { return mkEl(id + '_q'); }, querySelectorAll() { return []; }, scrollIntoView() {}, onclick: null };
  elements.set(id, el); return el; };
const documentObj = { getElementById: (id) => mkEl(id), createElement: () => mkEl('a' + Math.random()), createDocumentFragment: () => mkEl('f'), querySelectorAll: () => [], body: mkEl('body') };
const storageData = new Map();
storageData.set('toolbox.llm', { url: 'http://127.0.0.1:18787/v1/chat/completions', model: 'm', api_key: '' });
// fetch mock: 默认永久挂起(测试超时); 可切换为正常返回/慢返回
let fetchMode = { mode: 'hang' };
const chromeStub = {
  storage: { local: {
    get: (keys, cb) => { const r = {}; for (const k of [].concat(keys)) r[k] = storageData.get(k); if (typeof cb === 'function') setTimeout(() => cb(r), 0); return Promise.resolve(r); },
    set: (obj, cb) => { for (const k of Object.keys(obj)) storageData.set(k, obj[k]); setTimeout(() => cb && cb(), 0); return Promise.resolve(); },
    remove: (keys, cb) => { for (const k of [].concat(keys)) storageData.delete(k); setTimeout(() => cb && cb(), 0); return Promise.resolve(); } },
    onChanged: { addListener() {} } },
  runtime: { sendMessage: async () => ({ ok: true, recState: 'idle', count: 0, pending: 0, attachedTabs: 0, domains: [], unmatched: [], harvestCorrupt: false }), openOptionsPage() {} },
  tabs: { query: async () => [{ id: 1, url: 'https://a.b.com/x' }] },
  scripting: { executeScript: async () => [{ result: { status: 200, ok: true, text: '{}' } }] },
  sidePanel: {}, permissions: { contains: (p, cb) => cb(true), request: (p, cb) => cb(true) },
};
const sandbox = { console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, URL, URLSearchParams,
  navigator: { clipboard: { writeText: async () => {} } }, document: documentObj, chrome: chromeStub, performance: { now: () => Date.now() }, confirm: () => true, alert() {},
  AbortController,
  fetch: async (url, init) => {
    if (fetchMode.mode === 'ok') return { ok: true, json: async () => ({ choices: [{ message: { content: fetchMode.content ?? '[]' } }] }) };
    if (fetchMode.mode === 'hang') {
      // 永久挂起但必须消费 abort signal —— 否则 controller.abort() 无法唤醒,
      // 事件循环枯竭后 node 静默退出(表现为测试无输出但 exit 0)
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => {}, 3600000);
        if (init && init.signal) {
          init.signal.addEventListener('abort', () => { clearTimeout(t); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); });
        }
      });
    }
    if (fetchMode.mode === 'slow') { await new Promise((r) => setTimeout(r, fetchMode.delay ?? 5000)); return { ok: true, json: async () => ({ choices: [{ message: { content: 'x' } }] }) }; }
    throw new Error('nf');
  } };
sandbox.window = sandbox; sandbox.globalThis = sandbox; vm.createContext(sandbox);
for (const f of all) new vm.Script(fs.readFileSync(f, 'utf8'), { filename: f }).runInContext(sandbox);

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  OK ' + msg); } else { fail++; console.log('  ✗ FAIL ' + msg); } };

(async () => {
  // 1) callLlm 超时: 挂起网关 + timeoutMs=300
  fetchMode = { mode: 'hang' };
  const t0 = Date.now();
  const r1 = await vm.runInContext('callLlm([{role:"user",content:"hi"}], {timeoutMs: 300})', sandbox);
  const dt = Date.now() - t0;
  ok(!r1.ok, '超时返回失败');
  ok(r1.error.includes('中止') || r1.error.includes('无响应'), '超时可读错误: ' + r1.error);
  ok(dt >= 280 && dt < 1500, `超时时机合理(${dt}ms)`);
  // 1b. 正常返回不受影响
  fetchMode = { mode: 'ok', content: '你好' };
  const r1b = await vm.runInContext('callLlm([{role:"user",content:"hi"}])', sandbox);
  ok(r1b.ok && r1b.content === '你好', '正常调用不受超时影响');
  // 1c. 无 key 行为级(v1.0.63, #156 方向③): api_key 可空是 memory 里用户确认的核心
  // 设计(本地代理 8787 形态), 空 key 必须不发 Authorization —— 对需要 Bearer 的公网
  // 网关, 发空 Authorization 头会 401/格式错; 对不认头的本地代理多发头也无害但脏。
  // testLlm 的 opts.apiKey 空串(输入框当前值)同样走"不发"分支。
  let seenHeaders = null;
  sandbox.fetch = async (url, init) => { seenHeaders = init.headers; return { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) }; };
  storageData.set('toolbox.llm', { url: 'http://127.0.0.1:8787/v1/chat/completions', model: 'm', api_key: '' });
  await vm.runInContext('callLlm([{role:"user",content:"hi"}])', sandbox);
  ok(!('Authorization' in seenHeaders), 'storage 空 key → 不发 Authorization 头(本地代理形态)');
  storageData.set('toolbox.llm', { url: 'http://x:8787/v1/chat/completions', model: 'm', api_key: 'sk-123' });
  await vm.runInContext('callLlm([{role:"user",content:"hi"}])', sandbox);
  ok(seenHeaders.Authorization === 'Bearer sk-123', 'storage 有 key → Bearer 头');
  storageData.set('toolbox.llm', { url: 'http://x:8787/v1/chat/completions', model: 'm', api_key: 'sk-storage' });
  await vm.runInContext('callLlm([{role:"user",content:"hi"}], { apiKey: "" })', sandbox);
  ok(!('Authorization' in seenHeaders), 'opts.apiKey 空串覆盖 → 不发 Authorization(testLlm 测输入框当前值)');

  // 2) aiDebugFailures 消息结构: 拦截 fetch 记录 messages
  let lastBody = null;
  fetchMode = { mode: 'ok' };
  sandbox.fetch = async (url, init) => { lastBody = JSON.parse(init.body); return { ok: true, json: async () => ({ choices: [{ message: { content: '诊断结果' } }] }) }; };
  // 构造 chainResults + entries
  const mk = (id, m, p, body, resp) => ({ id, method: m, url: `https://a.b.com${p}`, path: p, query: '', headers: {}, body, status: 500, mime: 'application/json', response: resp, ts: '2026-09-17T10:00:00Z' });
  const e1 = JSON.stringify(mk('f1', 'POST', '/api/a', '{"a":1}', 'err'));
  const e2 = JSON.stringify(mk('f2', 'GET', '/api/b', '', 'nf'));
  vm.runInContext(`
    entries = [${e1}, ${e2}];
    chainResults = [
      { verdict: 'FAIL', entry: entries[0], msg: 'x', live: { status: 500, text: '' } },
      { verdict: 'FAIL', entry: entries[1], msg: 'y', live: { status: 404, text: '' } },
    ];
  `, sandbox);
  elements.get('btnChainAiDiag').disabled = false;
  await vm.runInContext('aiDebugFailures()', sandbox);
  const sysCount = lastBody.messages.filter((m) => m.role === 'system').length;
  const userCount = lastBody.messages.filter((m) => m.role === 'user').length;
  ok(sysCount === 1, `消息结构 system 恰好 1 条(实得 ${sysCount})`);
  ok(userCount === 1, `user 恰好 1 条(实得 ${userCount})`);
  ok(lastBody.messages[1].content.includes('【失败 1】') && lastBody.messages[1].content.includes('【失败 2】'), '多 bad 分节合并进单 user');
  ok(lastBody.messages[0].content.includes('逐条给结论'), 'system 声明多条语义');
  ok(elements.get('chainOut').innerHTML.includes('诊断完成') || elements.get('chainOut').innerHTML.includes('AI 失败调试'), '结果渲染');

  // 3) aiBuildAsserts: >30 接口拒绝
  storageData.set('toolbox.harvest', { v: 1, entries: Array.from({ length: 35 }, (_, i) => mk('a' + i, 'GET', '/api/x' + i, '', '{}')) });
  await vm.runInContext('loadHarvest()', sandbox);
  elements.get('btnAiAssert').disabled = false;
  await vm.runInContext('aiBuildAsserts()', sandbox);
  ok(elements.get('btnAiAssert').disabled === false, '超限后按钮恢复可点');
  const recMsg = elements.get('chainMsg').textContent;
  ok(recMsg.includes('上限 30') || recMsg.includes('缩小'), '超限指引: ' + recMsg);
  // 3b. 小集 + 进度显示
  storageData.set('toolbox.harvest', { v: 1, entries: [mk('s1', 'POST', '/api/s', '{"a":1}', '{"ok":1}')] });
  await vm.runInContext('loadHarvest()', sandbox);
  lastBody = null;
  fetchMode = { mode: 'ok', content: '[{"type":"status","target":"status","expect":"200"}]' };
  // 场景 2 曾整体覆盖 sandbox.fetch(不再读 fetchMode) —— 3b 重设回读 fetchMode 的 mock
  sandbox.fetch = async (url, init) => ({ ok: true, json: async () => ({ choices: [{ message: { content: fetchMode.content ?? '[]' } }] }) });
  await vm.runInContext('aiBuildAsserts()', sandbox);
  ok(storageData.get('toolbox.aiAsserts') !== undefined, '小集正常发起断言请求(存库为证)');
  ok(storageData.get('toolbox.aiAsserts') && storageData.get('toolbox.aiAsserts').length === 1, '断言存库');
  const assertMsg = elements.get('chainMsg').textContent;
  ok(assertMsg.includes('1 组接口断言'), '断言完成提示: ' + assertMsg);

  // 3c. 行为级: 坏 url 条目 → buildReportPrompt throw(pathLine new URL) → 按钮恢复 + 可读错误(v1.0.24 修复)
  // 静态契约(check_ai_guard)只证明 try/catch 在; 这里证明 catch 真的接住 throw 且 finally 解锁。
  storageData.set('toolbox.harvest', { v: 1, entries: [{ id: 'bad1', method: 'GET', url: '', path: '', query: '', headers: {}, body: '', status: 200, mime: 'application/json', response: '{}', ts: '2026-09-17T10:00:00Z' }] });
  await vm.runInContext('loadHarvest()', sandbox);
  elements.get('btnAiReport').disabled = false;
  await vm.runInContext('aiReport()', sandbox);
  ok(elements.get('btnAiReport').disabled === false, '行为级: prompt throw 后按钮恢复(v1.0.24 修复)');
  const repMsg = elements.get('expMsg').textContent;
  ok(/异常/.test(repMsg), '行为级: catch 给可读错误: ' + repMsg);

  // 4) 卫生: 诊断 prompt 无 Cookie 头
  const A = require(ROOT + '/aireport.js');
  const dirtyEntry = { method: 'POST', url: 'https://x.com/api', headers: { Cookie: 'SESS=abc; tok=xyz', Authorization: 'Bearer ttt', 'X-Biz': '1' }, body: 'user=admin&password=SuperSecret123', response: '{"token":"abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz0123456789", "data":1}' };
  const s = A.aiSanitizeEntry(dirtyEntry);
  ok(!s.headers.includes('SESS=abc') && !s.headers.includes('Bearer'), 'Cookie/Authorization 剥除');
  ok(s.headers.includes('X-Biz'), '业务头保留');
  ok(s.response.includes('***MASKED***'), '长 token 打码');
  ok(!s.body.includes('SuperSecret123') === false, '密码在 body 中保留(截断至 1200, 打码仅对 40+ 长串) —— 已知边界: 短密码可外发, prompt 声明送 LLM');

  // 4b) query 呈现与卫生(v1.0.20): prompt 条目行含 query(LLM 才能建 url. 链), 长 token 同规则打码
  const qEntry = { method: 'GET', url: 'https://x.com/list?cursor=AAA&access_token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9eyJhbGciOiJIUzI1NiJ9', headers: {}, body: '', status: 200, response: '' };
  const chainMsgs = A.buildChainPrompt([qEntry]);
  const chainLine = chainMsgs[1].content.split('\n').find((l) => l.includes('### [1]'));
  ok(chainLine.includes('cursor=AAA'), 'chain prompt 条目行呈现 query 参数: ' + chainLine);
  ok(chainLine.includes('***MASKED***') && !chainLine.includes('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9eyJhbGciOiJIUzI1NiJ9'), 'query 里 40+ 长 token 打码(与 body 同规则)');
  const noQ = A.buildChainPrompt([{ method: 'GET', url: 'https://x.com/plain', headers: {}, body: '', status: 200, response: '' }]);
  ok(noQ[1].content.includes('### [1] GET /plain\n'), '无 query 的条目行不拼 ?(形态不变)');
  const longQ = A.buildChainPrompt([{ method: 'GET', url: 'https://x.com/list?' + 'k='.padEnd(4, 'k') + 'v'.repeat(500), headers: {}, body: '', status: 200, response: '' }]);
  ok(longQ[1].content.split('\n')[0].length < 400, '超长 query 截断到 300(防挤爆条目行)');
  // 4b2) 打码×截断交叠边界(v1.0.22 走查): 源头打码后 query 仍 >300 时, slice(1,301) 的切点
  // 可能落在 ***MASKED*** 星号串内部 —— 尾部呈现破碎(如 '***MASKED**')。断言两件事:
  //   ① 不泄漏: 截断只可能切掉打码串或参数名, 真值段(40+)在 sanitize 时已缩成 8 前缀
  //   ② 形态可识别: 呈现行即使断在打码串内, 参数结构(&分隔/键名前缀)对 LLM 仍可读
  // 断言的回归性设计: 打码缩合(45→21)使 query 总长恰好落 300~400 区间才测得到交叠。
  // 若 scrubLong 正则/阈值演进(如 40→64), 'v'.repeat(45) 不再命中 → 真值段原样进 line
  // → 断言① FAIL = 正确报警(scrubLong 退化), 不存在"静默失效"形态。
  const mqUrl = 'https://x.com/a?pad=' + 'p'.repeat(3) + '&' + Array.from({ length: 20 }, (_, i) => 'k' + i + '=' + 'v'.repeat(45)).join('&');
  const mqLine = A.buildChainPrompt([{ method: 'GET', url: mqUrl, headers: {}, body: '', status: 200, response: '' }])[1].content.split('\n').find((l) => l.includes('### [1]'));
  ok(mqLine.length > 300, `前置: 打码后仍超 300 触发截断(实得 ${mqLine.length}, 断言才有交叠面)`);
  ok(!/[A-Za-z0-9_=.+-]{40,}/.test(mqLine), '打码×截断交叠后条目行无 40+ 残值段(不泄漏)');
  ok(mqLine.includes('pad=ppp') && mqLine.includes('k0='), '交叠截断保留参数结构(键名可识别)');
  // 4b3) pathLine 直测(v1.0.22 导出): 条目行 helper 的基础形态 + 已打码 url 的幂等
  ok(A.pathLine('https://x.com/a/b?k=1') === '/a/b?k=1', 'pathLine 基础形态: pathname+query');
  ok(A.pathLine('https://x.com/nq') === '/nq', 'pathLine 无 query 不拼 ?');
  ok(A.pathLine('https://x.com/a?access_t***MASKED***') === '/a?access_t***MASKED***', 'pathLine 对已打码 url 幂等(不再命中 scrubLong)');

  // 4c) 全量 url 呈现的卫生(v1.0.21): diagnose/assert/perf/diffTriage 的 user 消息直接呈现
  // s.url 全量 —— aiSanitizeEntry 源头打码后, query 里 40+ 长 token 不得原样外发
  const LEAK = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9eyJzdWIiOiIxMjM0NTY3ODkw';
  const dirtyQ = { method: 'GET', url: 'https://x.com/a?access_token=' + LEAK + '&page=1', headers: {}, body: '', status: 500, response: '{"code":"ERR"}' };
  const stats = { concurrency: 1, total: 2, completed: 2, wallMs: 100, rps: 20, success: 2, failed: 0, failRate: 0, p50: 1, p90: 1, p95: 1, p99: 1, maxMs: 2, errors: [] };
  ok(!A.buildDiagnosePrompt(dirtyQ, [])[1].content.includes(LEAK), 'diagnose user 消息 url 打码');
  ok(!A.buildAssertPrompt(dirtyQ)[1].content.includes(LEAK), 'assert user 消息 url 打码');
  ok(!A.buildPerfPrompt(dirtyQ, stats)[1].content.includes(LEAK), 'perf user 消息 url 打码');
  ok(!A.buildDiffTriagePrompt(dirtyQ, dirtyQ)[1].content.includes(LEAK), 'diffTriage user 消息 url 打码');
  ok(A.buildPerfPrompt(dirtyQ, stats)[1].content.includes('page=1'), '短 query 参数保留(诊断/解读不受损)');
  // 4d) diffTriage 真实快照形态(v1.0.63 修复): skill 消费的是 runChainReplay 落 storage 的
  // 快照 {recorded: 完整条目, live: {status, text}} —— live 无 headers/method/url/body,
  // aiSanitizeEntry 的 Object.entries(e.headers) 直炸, 「AI 契约判定」对真实 DIFF 不可用
  // (try/catch 接住后用户只看到"分析异常")。修复后 live 字段映射继承 + text→response。
  const snapLive = { status: 200, text: '{"a":2}' };
  const dmsgs = A.buildDiffTriagePrompt(dirtyQ, snapLive);
  ok(!dmsgs[1].content.includes('undefined'), 'diffTriage live 快照形态不炸且无 undefined 行(真实 DIFF 可判定)');
  const dTail = dmsgs[1].content.split('## 重放结果')[1];
  ok(dTail.includes('GET') && dTail.includes('/a'), 'live 侧方法/URL 继承 recorded(同一条接口)');
  ok(dTail.includes('"a":2'), 'live 响应体 text→response 呈现(LLM 才有判定材料)');
  ok(!dmsgs[1].content.includes(LEAK), '继承 URL 后打码同规则(live 侧不泄漏)');
  // 4e) verdict↔diffTriage 截断口径对齐(v1.0.63, #156 方向②): verdict 的非 JSON diff 指纹
  // 是"前 200 + 后 200"(replay.js), 大响应差异在尾部时 verdict 判 DIFF —— 但 aiSanitizeEntry
  // 原来只砍头(slice(0,respMax)), 尾部差异段不进 prompt, LLM 拿不到判定材料("看起来一致"瞎猜)。
  // 修后: 超预算响应保留前段+尾段两头(中间省略明示), 判定面与呈现面口径对齐。
  // (填充须用非字母字符: 字母串 40+ 会被 scrubLong 正确打码, 差异标记跟着被吞 —— 那是
  // 打码防护的既定语义, 不是截断逻辑的 bug。)
  const bigResp = '一'.repeat(3000) + '尾巴-旧';
  const bigLive = { status: 200, text: '一'.repeat(3000) + '尾巴-新' };
  const bmsgs = A.buildDiffTriagePrompt(
    { method: 'GET', url: 'https://x.com/a', headers: {}, body: '', status: 200, response: bigResp }, bigLive);
  ok(bmsgs[1].content.includes('尾巴-旧') && bmsgs[1].content.includes('尾巴-新'), '尾部差异段进 prompt(verdict 判 DIFF 的证据送得到 LLM)');
  ok(bmsgs[1].content.includes('中间省略'), '省略段对 LLM 明示(非静默裁剪)');
  const short = A.aiSanitizeEntry({ method: 'GET', url: '', headers: {}, body: '', status: 200, response: '{"a":1}' });
  ok(short.response === '{"a":1}', '短响应(<respMax)原样不进省略分支');
  ok(!A.aiSanitizeEntry({ method: 'GET', url: '', headers: {}, body: '', status: 200, response: 'y'.repeat(1500) }, { respMax: 1500 }).response.includes('省略'), '恰好 respMax 边界不省略(>才触发)');

  console.log(fail ? `\n=== AI 全链路 FAIL: ${fail} ===` : `\n=== AI 全链路走查 PASS ===`);
  process.exit(fail ? 1 : 0);
})();
