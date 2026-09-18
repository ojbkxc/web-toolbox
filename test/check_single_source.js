// #131 探针: sessionMarkers/60s 看门狗单源化后, 两个页面 realm 的常量解析链验证
const fs = require('fs'), vm = require('vm'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const mkDoc = () => {
  const elements = new Map();
  const mkEl = (id) => { if (elements.has(id)) return elements.get(id);
    const el = { id, style: {}, dataset: {}, children: [], value: '', textContent: '', innerHTML: '', className: '', checked: true, disabled: false,
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } }, addEventListener() {}, appendChild() {}, setAttribute(k, v) { this[k === "aria-label" ? "ariaLabel" : k] = v; }, insertBefore() {},
      querySelector() { return mkEl(id + '_q'); }, querySelectorAll() { return []; }, focus() {}, onclick: null };
    elements.set(id, el); return el; };
  return { documentObj: { getElementById: (id) => mkEl(id), createElement: () => mkEl('a' + Math.random()), createDocumentFragment: () => mkEl('f'), querySelectorAll: () => [], body: mkEl('body') }, elements };
};
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  OK ' + m); } else { fail++; console.log('  ✗ FAIL ' + m); } };

for (const [page, dir] of [['popup', 'popup'], ['sidepanel', 'sidepanel']]) {
  const html = fs.readFileSync(path.join(ROOT, dir, dir + '.html'), 'utf8');
  const all = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => path.resolve(path.join(ROOT, dir), m[1]));
  const { documentObj } = mkDoc();
  const sb = { console, setTimeout, clearTimeout, URL, URLSearchParams, AbortController, performance: { now: () => Date.now() },
    navigator: { clipboard: { writeText: async () => {} } }, document: documentObj,
    chrome: { storage: { local: { get: async () => ({}), set: async () => {} }, onChanged: { addListener() {} } },
      runtime: { sendMessage: async () => ({ recState: 'idle', count: 0 }) }, openOptionsPage() {} },
    tabs: { query: async () => [{ id: 1, url: 'https://a.b.com/x' }] } };
  sb.window = sb; sb.globalThis = sb;
  vm.createContext(sb);
  for (const f of all) new vm.Script(fs.readFileSync(f, 'utf8'), { filename: f }).runInContext(sb);
  // vm 的顶层 const 不挂 sandbox 属性(词法声明不进全局对象), 但 <script> 链共享的是
  // 【同 realm 词法环境】—— 后续脚本按名字解析可见。这里用同 realm 后续脚本验证名字可达。
  try {
    const seen = vm.runInContext('SESSION_MARKERS', sb);
    ok(Array.isArray(seen) && seen.length === 3, `${page} realm SESSION_MARKERS 词法可达: ${JSON.stringify(seen)}`);
  } catch (e) {
    ok(false, `${page} realm SESSION_MARKERS 词法可达: ${e.message}`);
  }
  if (page === 'sidepanel') {
    try {
      const t = vm.runInContext('SINGLE_TIMEOUT_MS_OUTER', sb);
      ok(t === 60000, `sidepanel realm SINGLE_TIMEOUT_MS_OUTER: ${t}`);
    } catch (e) { ok(false, `sidepanel realm SINGLE_TIMEOUT_MS_OUTER: ${e.message}`); }
  }
}
// 消费面静态断言: 三处消费都引用常量, 不再留双字面量
const sp = fs.readFileSync(path.join(ROOT, 'sidepanel/sidepanel.js'), 'utf8');
ok(!/sessionMarkers: \[/.test(sp), 'sidepanel 不再有 sessionMarkers 内联数组');
ok((sp.match(/SESSION_MARKERS/g) || []).length >= 2, 'sidepanel SESSION_MARKERS 消费 >= 2 处');
// 慢阈值单源(v1.0.59 断言固化): 列表+详情两处消费都走 SLOW_MS/MID_MS 常量,
// 不留 3000/1000 双字面量(README L93 的"1s/3s"宣称随常量走)。
ok((sp.match(/\bSLOW_MS\b/g) || []).length >= 3, 'sidepanel SLOW_MS 声明+两处消费(>=3 次出现)');
ok((sp.match(/\bMID_MS\b/g) || []).length >= 3, 'sidepanel MID_MS 声明+两处消费(>=3 次出现)');
ok(!/[ms]s > 3000|[ms]s > 1000|durationMs > 3000|durationMs > 1000/.test(sp), '无残留 3000/1000 耗时字面量');
const pp = fs.readFileSync(path.join(ROOT, 'popup/popup.js'), 'utf8');
ok(/sessionMarkers: SESSION_MARKERS/.test(pp) && !/sessionMarkers: \[/.test(pp), 'popup SESSION_MARKERS 消费且无内联');
const rv = fs.readFileSync(path.join(ROOT, 'replay.js'), 'utf8');
ok(/opts\.singleTimeoutMs \?\? SINGLE_TIMEOUT_MS/.test(rv), 'replay.js runChain 兜底走单源常量');
ok(/timeoutMs = 60000\) \{/.test(rv) && /SINGLE_TIMEOUT_MS = 60000/.test(rv), 'replayFn 体内字面量保留(注入序列化限制) + 顶层常量存在');
ok(/module\.exports = \{ normalizeForCompare, verdict, runChain, createExecutionLease, SINGLE_TIMEOUT_MS \}/.test(rv), 'node 导出面含 SINGLE_TIMEOUT_MS');

console.log(fail ? `\n=== 单源化探针 FAIL: ${fail} ===` : '\n=== 单源化探针 PASS ===');
process.exit(fail ? 1 : 0);
