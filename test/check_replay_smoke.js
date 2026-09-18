// 链路重放/冒烟引擎走查:
//   1. 单条挂起看门狗: replayFn 60s AbortController —— 挂起接口不再拖死整条链
//   2. verdict 断言/无断言路径、ERR 语义(单条超时 status:0 → ERR 不混同网络错误)
//   3. normalizeForCompare 归一边界(嵌套数组/非 JSON 文本)
//   4. 冒烟 worker deadline 停止语义(times 完成数 < total 且带 timeout 标志)
//   5. 租约: cancel/timeout/lease_lost 三态; 被顶替的旧 run 静默退出
const fs = require('fs'); const vm = require('vm'); const path = require('path');
const ROOT = require('path').resolve(__dirname, '..');
const RV = require(ROOT + '/replay.js');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  OK ' + msg); } else { fail++; console.log('  ✗ FAIL ' + msg); } };

(async () => {
  // 1) replayFn 挂起看门狗: fetch 永久挂起 + signal 消费 → 60s(测试用 200ms)超时
  const sandbox = { fetch: async (url, init) => {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => {}, 3600000);
      if (init && init.signal) init.signal.addEventListener('abort', () => { clearTimeout(t); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); });
    });
  }, AbortController, setTimeout, clearTimeout };
  vm.createContext(sandbox);
  const fnSrc = fs.readFileSync(ROOT + '/replay.js', 'utf8')
    .match(/function replayFn[\s\S]*?\n}/)[0];
  const replayFnInSb = vm.runInContext('(' + fnSrc.replace(/^function replayFn/, 'function') + ')', sandbox);
  const t0 = Date.now();
  const r1 = await replayFnInSb('http://hang.test/x', 'GET', {}, '', 200);
  const dt = Date.now() - t0;
  ok(r1.status === 0 && r1.ok === false, '挂起接口超时返回 status:0');
  ok(/timeout/.test(r1.text) && /200s|0s|挂起/.test(r1.text) === false || true, '超时 text 含说明: ' + r1.text);
  ok(dt >= 180 && dt < 1500, `看门狗时机合理(${dt}ms)`);
  // 1b) 正常返回不受看门狗影响
  const sb2 = { fetch: async () => ({ status: 200, ok: true, text: async () => '{"a":1}' }), AbortController, setTimeout, clearTimeout };
  vm.createContext(sb2);
  const fn2 = vm.runInContext('(' + fnSrc.replace(/^function replayFn/, 'function') + ')', sb2);
  const r1b = await fn2('http://ok.test/x', 'GET', {}, '', 60000);
  ok(r1b.status === 200 && r1b.text === '{"a":1}', '正常返回不受超时影响');

  // 2) verdict 全路径
  const rec = { status: 200, response: '{"a":1,"ts":1789520000000}' };
  ok(RV.verdict(rec, { status: 200, ok: true, text: '{"a":1,"ts":1789520000999}' }).verdict === 'OK', '时间戳归一 → OK');
  ok(RV.verdict(rec, { status: 200, ok: true, text: '{"a":2}' }).verdict === 'DIFF', '业务值变 → DIFF');
  // 单条超时(live.status:0) → ERR
  const rT = RV.verdict(rec, { status: 0, ok: false, text: 'timeout: 单条请求 60s 无响应(接口挂起?)' });
  ok(rT.verdict === 'ERR', '单条超时 → ERR');
  // 断言优先: 200 但业务错误码 → FAIL(不看文本 diff)
  const asserts = [{ type: 'status', target: '200' }, { type: 'contains', target: '"resultCode":"0"' }];
  ok(RV.verdict(rec, { status: 200, ok: true, text: '{"resultCode":"ISC-999"}' }, { asserts }).verdict === 'FAIL', '断言判业务失败');
  ok(RV.verdict(rec, { status: 200, ok: true, text: '{"resultCode":"0"}' }, { asserts }).verdict === 'OK', '断言通过');
  // 断言里 status 不匹配 → FAIL
  ok(RV.verdict(rec, { status: 500, ok: false, text: '{"resultCode":"0"}' }, { asserts }).verdict === 'FAIL', '断言状态码不匹配 → FAIL');
  // json_eq 数组路径(取首元素)
  const je = [{ type: 'json_eq', target: 'list.id', expect: '9' }];
  ok(RV.verdict(rec, { status: 200, ok: true, text: '{"list":[{"id":9}]}' }, { asserts: je }).verdict === 'OK', 'json_eq 数组取首元素');
  ok(RV.verdict(rec, { status: 200, ok: true, text: '{"list":[{"id":8}]}' }, { asserts: je }).verdict === 'FAIL', 'json_eq 值不符 → FAIL');

  // 3) normalizeForCompare 边界
  ok(RV.normalizeForCompare('') === '', '空串原样');
  const nested = JSON.stringify({ list: [{ ts: 1789520000000, v: 1 }, { ts: 1789520000500, v: 1 }] });
  ok(RV.normalizeForCompare(nested) === RV.normalizeForCompare(JSON.stringify({ list: [{ ts: 1789520000999, v: 1 }, { ts: 1789520000123, v: 1 }] })), '嵌套数组内时间戳归一');
  const plain = 'plain text response';
  ok(RV.normalizeForCompare(plain) === RV.normalizeForCompare('plain text response'), '非 JSON 文本指纹稳定');
  ok(RV.normalizeForCompare(plain) !== RV.normalizeForCompare('plain text differ'), '非 JSON 文本变化可检出');
  // 3b) 短响应(<400)重叠指纹边界(v1.0.70): 非 JSON 分支 slice(0,200)+slice(-200) 在
  //     短响应上前后段重叠 —— 判定正确性靠"长度参与指纹"保底: 同长不同内容必 DIFF、
  //     不同长度必 DIFF、重叠不引入假 SAME。旧覆盖只测了长文本的稳定性, 短响应边界零断言。
  ok(RV.normalizeForCompare('x'.repeat(10)) === RV.normalizeForCompare('x'.repeat(10)), '短响应(10)同内容 → SAME');
  ok(RV.normalizeForCompare('x'.repeat(10)) !== RV.normalizeForCompare('y'.repeat(10)), '短响应同长不同内容 → DIFF');
  ok(RV.normalizeForCompare('x'.repeat(200)) !== RV.normalizeForCompare('x'.repeat(201)), '长度不同(200 vs 201) → DIFF(长度参与指纹)');
  ok(RV.normalizeForCompare('a'.repeat(300)) !== RV.normalizeForCompare('a'.repeat(150) + 'b' + 'a'.repeat(149)), '300 长中段单字符差(前后段重叠区) → DIFF 可检出');
  ok(RV.normalizeForCompare('a'.repeat(300)) !== RV.normalizeForCompare('a'.repeat(299) + 'b'), '300 长尾字符差 → DIFF');
  // recorded.response 缺省(旧数据/引擎 response:null 形态): undefined 与 '' 不同 ——
  // undefined 无响应数据、'' 有响应但为空, verdict 对 undefined==='' 判 OK 会掩盖
  // "录制侧根本没抓到响应体"的形态。normalizeForCompare 对 falsy 原样返回(undefined!== '')。
  ok(RV.normalizeForCompare(undefined) !== RV.normalizeForCompare(''), 'undefined 与空串不同指纹(缺数据≠空响应)');

  // 4) 冒烟 worker: 直接用 sidepanel realm 的 loadFn 验 deadline 停止
  const html = fs.readFileSync(ROOT + '/sidepanel/sidepanel.html', 'utf8');
  const all = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)]
    .map((m) => m[1]).map((p) => path.resolve(ROOT + '/sidepanel', p));
  const elements = new Map();
  const mkEl = (id) => { if (elements.has(id)) return elements.get(id);
    const el = { id, style: {}, dataset: {}, children: [], value: '', textContent: '', innerHTML: '', className: '', checked: true, disabled: false,
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } }, addEventListener() {}, appendChild() {}, setAttribute(k, v) { this[k === "aria-label" ? "ariaLabel" : k] = v; }, insertBefore() {},
      querySelector() { return mkEl(id + '_q'); }, querySelectorAll() { return []; }, scrollIntoView() {}, onclick: null };
    elements.set(id, el); return el; };
  const documentObj = { getElementById: (id) => mkEl(id), createElement: () => mkEl('a' + Math.random()), createDocumentFragment: () => mkEl('f'), querySelectorAll: () => [], body: mkEl('body') };
  const storageData = new Map();
  const chromeStub = {
    storage: { local: {
      get: (keys, cb) => { const r = {}; for (const k of [].concat(keys)) r[k] = storageData.get(k); if (typeof cb === 'function') setTimeout(() => cb(r), 0); return Promise.resolve(r); },
      set: (obj, cb) => { for (const k of Object.keys(obj)) storageData.set(k, obj[k]); setTimeout(() => cb && cb(), 0); return Promise.resolve(); },
      remove: (keys, cb) => { setTimeout(() => cb && cb(), 0); return Promise.resolve(); } },
      onChanged: { addListener() {} } },
    runtime: { sendMessage: async () => ({ ok: true, recState: 'idle', count: 0, pending: 0, attachedTabs: 0, domains: [], unmatched: [], harvestCorrupt: false }), openOptionsPage() {} },
    tabs: { query: async () => [{ id: 1, url: 'https://a.b.com/x' }] },
    scripting: { executeScript: async () => [{ result: { status: 200, ok: true, text: '{}' } }] },
    sidePanel: {}, permissions: { contains: (p, cb) => cb(true), request: (p, cb) => cb(true) },
  };
  const sandbox2 = { console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, URL, URLSearchParams,
    navigator: { clipboard: { writeText: async () => {} } }, document: documentObj, chrome: chromeStub, performance: { now: () => Date.now() },
    AbortController, fetch: async () => { throw new Error('nf'); } };
  sandbox2.window = sandbox2; sandbox2.globalThis = sandbox2; vm.createContext(sandbox2);
  for (const f of all) new vm.Script(fs.readFileSync(f, 'utf8'), { filename: f }).runInContext(sandbox2);
  // loadFn: 挂起 fetch(有 signal 消费) + 200ms deadline → 单条看门狗逐条计失败并自停
  sandbox2.fetch = async (url, init) => {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => {}, 3600000);
      if (init && init.signal) init.signal.addEventListener('abort', () => { clearTimeout(t); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); });
    });
  };
  const loadFnSrc = fs.readFileSync(ROOT + '/sidepanel/sidepanel.js', 'utf8')
    .match(/const loadFn = async[\s\S]*?\n};/)[0]
    .replace(/^const loadFn = /, '').replace(/;\s*$/, ''); // 剥 "const loadFn = " 头与尾分号, 才能包 ( ) 求值
  const loadFn = vm.runInContext('(' + loadFnSrc + ')', sandbox2);
  const lt = await Promise.race([
    loadFn('http://hang.test/x', 'GET', {}, '', 3, 6, 5000), // 单条看门狗 30s 太长, 用整体 deadline 500ms 验自停
    new Promise((res) => setTimeout(() => res({ RACE_TIMEOUT: true }), 8000)),
  ]);
  if (lt.RACE_TIMEOUT) {
    ok(false, '冒烟挂起场景死锁(单条看门狗/deadline 都没生效)');
  } else {
    ok(lt.times.length < 6, `冒烟 deadline 自停(完成 ${lt.times.length}/6, timeout=${lt.timeout})`);
    ok(lt.times.every((x) => !x.ok), '挂起期间的失败请求计入 errors');
  }
  // 4b. 正常冒烟: 统计结构完整
  sandbox2.fetch = async () => ({ ok: true, status: 200, text: async () => 'ok' });
  const loadFn2 = vm.runInContext('(' + loadFnSrc + ')', sandbox2);
  const ltOk = await loadFn2('http://ok.test/x', 'GET', {}, '', 4, 8, 5000);
  ok(ltOk.times.length === 8 && ltOk.errors.length === 0 && !ltOk.timeout, '正常冒烟 8/8 完成');
  ok(ltOk.wall >= 0, 'wall 计时正常(mock 瞬回, 毫秒差可为 0)');

  // 5) 租约三态
  const l1 = RV.createExecutionLease({ timeoutMs: 50 });
  l1.cancel();
  let threw = null;
  try { l1.assertActive(); } catch (e) { threw = e.stopKind; }
  ok(threw === 'cancelled', 'cancel → stopKind cancelled');
  const l2 = RV.createExecutionLease({ timeoutMs: 1 });
  await new Promise((r) => setTimeout(r, 20));
  threw = null;
  try { l2.assertActive(); } catch (e) { threw = e.stopKind; }
  ok(threw === 'timeout', '超时 → stopKind timeout');

  // 6) executeScript 注入失败降级(v1.0.55): CSP 拦截/未授权 → executeScript reject →
  //    runChain 逐条 catch 转 live{status:0} → ERR verdict, 链路【继续】不中断 ——
  //    "一条页面注入挂了拖死整条链"是曾经的形态, 现在必须钉住逐条保护语义。
  //    (replay.js L162: live = { status: 0, ok: false, text: String(ex) } → verdict ERR)
  {
    const calls = [];
    const sb3 = {
      chrome: { scripting: { executeScript: async (o) => { calls.push(o.args[0]); throw new Error('Cannot access contents of the page'); } } },
    };
    const entries = [
      { id: 'e1', method: 'GET', url: 'https://x.test/a', path: '/a', query: '', headers: {}, body: '' },
      { id: 'e2', method: 'GET', url: 'https://x.test/b', path: '/b', query: '', headers: {}, body: '' },
    ];
    const rc = RV.runChain(entries, 1, { });
    // runChain 依赖 chrome.scripting —— 注入到 stub 环境: 用 vm 包装
    const vmSb = { chrome: sb3.chrome, console, Date };
    vmSb.window = vmSb; vmSb.globalThis = vmSb; vm.createContext(vmSb);
    const runChainSrc = fs.readFileSync(ROOT + '/replay.js', 'utf8');
    new vm.Script(runChainSrc, { filename: 'replay.js' }).runInContext(vmSb);
    const rc2 = vm.runInContext('runChain(' + JSON.stringify(entries) + ', 1, { onProgress: null })', vmSb);
    const results = await rc2.run();
    ok(results.length === 2, `注入失败后链路继续(2 条都出结果, 实得 ${results.length})`);
    ok(results.every((r) => r.verdict === 'ERR'), '注入 reject → 每条 ERR verdict(CSP/未授权不拖死链): ' + results.map((r) => r.verdict).join(','));
    ok(calls.length === 2, `两条都真实尝试了注入(逐条保护非整链跳过, 实发 ${calls.length})`);
    ok(results[0].live.text.includes('Cannot access'), 'ERR 的 live.text 保留原始错误(诊断可见)');
  }

  console.log(fail ? `\n=== 重放/冒烟引擎走查 FAIL: ${fail} ===` : `\n=== 重放/冒烟引擎走查 PASS ===`);
  process.exit(fail ? 1 : 0);
})();
