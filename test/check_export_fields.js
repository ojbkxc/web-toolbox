// check_export_fields.js —— 四导出器字段消费差异契约(v1.0.52)。
// 差异表(条目字段 × 格式): 语义差异是设计(压测脚本不带档案数据), 但"哪个格式消费
// 哪个字段"要钉死 —— 未来某格式突然开始/停止消费某字段而无人知情, 就是静默漂移。
//
//   字段        JSONL/HAR(common)   JMX         PY
//   method      Y                   Y           Y
//   url         Y                   Y           Y
//   path/query  Y                   Y           Y
//   headers     Y                   Y(净化的)    Y(净化的)
//   body        Y                   Y           Y
//   id          Y(JSONL 行不导)     Y(前置判定)  Y(链 fromId)
//   response    Y                   -           -
//   status      Y                   -           -
//   mime        Y                   -           -
//   ts          Y                   -           -
//   durationMs  Y                   -           -
//
// 语义: JSONL/HAR 是保真档案(带 response/status/mime/ts/durationMs 全量);
// JMX/PY 是可执行脚本 —— 录制的响应体/状态码对压测无意义(运行时自己拿),
// status 在 PY 里的 r.status_code 是生成的 python 变量非条目字段。
//
// 历史漂移(已修复): mime/ts/durationMs 三字段此前仅 HAR 消费(buildHar),
// JSONL 行(harvestToExportRows)一直没带 —— 契约表标 Y 但行里没有, 属"声称消费"。
// v1.0.57 起补齐(行级断言在 test_regression.js 5d 节); id 行例外: JSONL 行不导
// (行内不稳定标识, 工具链不需要), HAR 保真导。
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const assert = (cond, msg) => { if (!cond) { console.log('FAIL: ' + msg); process.exit(1); } console.log('  OK ' + msg); };

const common = fs.readFileSync(path.join(ROOT, 'common.js'), 'utf8');
const jmx = fs.readFileSync(path.join(ROOT, 'jmx.js'), 'utf8');
const py = fs.readFileSync(path.join(ROOT, 'pyscript.js'), 'utf8');

// 全消费面: method/url/headers/body 三格式都在(脚本的最小执行集)
for (const [name, src] of [['common', common], ['jmx', jmx], ['py', py]]) {
  assert(src.includes('.method') && src.includes('.headers') && src.includes('.body'), `f1-${name}. method/headers/body 最小执行集在`);
}
// 档案面(JSONL/HAR): response/status/mime/durationMs 是保真格式专属
assert(common.includes('.response') && common.includes('.status') && common.includes('.mime') && common.includes('.durationMs'), 'f2. JSONL/HAR 保真字段(response/status/mime/durationMs)在');
// JMX 不消费 response/status(压测语义): e.status 出现即漂移
// (注意区分: jmx 里 r.status 是 python/运行时变量, 只查 e.xxx 条目字段形态)
// v1.0.88: jmx.js 读 e.response 推断成功指示字段(detectSuccessIndicator), 但只取
// 字段名+成功值(如 $.resultCode=ISC-000), 不嵌入完整响应体。改为运行时输出检查。
const { buildJmx } = require('../jmx.js');
const _mk = (id, method, url, extra) => Object.assign({ id, method, url, path: new URL(url).pathname, query: "", headers: {}, body: "", status: 200, mime: "application/json", response: "{}", ts: "2026-10-16T10:00:00Z" }, extra);
const _probeResp = '{"resultCode":"ISC-000","data":{"secret":"RESP_BODY_LEAK_PROBE_XYZ"}}';
const _jmxOut = buildJmx([_mk("p1", "POST", "https://h/api/x", { response: _probeResp })]);
assert(!_jmxOut.includes("RESP_BODY_LEAK_PROBE_XYZ"), 'f3. JMX 输出不包含录制响应体(只取成功指示字段, v1.0.88)');
assert(!/\be\.status\b/.test(jmx), 'f4. JMX 不消费 e.status(压测脚本不带录制状态码)');
assert(!/\be\.mime\b/.test(jmx) && !/\be\.durationMs\b/.test(jmx), 'f5. JMX 不消费 e.mime/e.durationMs');
// PY 同语义
assert(!/\be\.response\b/.test(py), 'f6. PY 不消费 e.response');
assert(!/\be\.mime\b/.test(py) && !/\be\.durationMs\b/.test(py), 'f7. PY 不消费 e.mime/e.durationMs');
// PY 消费 e.status? 检查(会话 marker 用 r.status_code 运行时变量, e.status 不该在):
assert(!/\be\.status\b/.test(py), 'f8. PY 不消费 e.status(r.status_code 是生成变量非条目字段)');
// JMX/PY 消费 id(前置判定/链匹配)
assert(/\be\.id\b/.test(jmx) && /preludeIds/.test(jmx), 'f9. JMX 消费 e.id(preludeIds 前置判定)');
assert(/fromId/.test(common), 'f10. AI 链 fromId/toId 在 common(链匹配消费 id)');

console.log('');

// ---- HAR 1.2 时间格式(v1.1.76) ----
// 起因: 样本库 96 条条目 100% 没有 ts, buildHar 直接写空串 → 产出"JSON 合法但 HAR 规范非法"
// 的文件(分析工具/DevTools 都会报错)。这里**真跑 buildHar** 验 startedDateTime 恒为 ISO 8601。
{
  const vm = require('vm');
  const sandbox = { console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, URL, URLSearchParams, Date, JSON, Math, Promise };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  sandbox.chrome = { storage: { local: { get: (k, cb) => cb && cb({}), set: (o, cb) => cb && cb() } }, runtime: { getManifest: () => ({ version: 't' }) } };
  sandbox.document = { querySelector: () => null };
  vm.createContext(sandbox);
  new vm.Script(common, { filename: 'common.js' }).runInContext(sandbox);
  const mk = (ts) => ([{ method: 'GET', url: 'https://a.test/x', path: '/x', query: '', headers: {}, body: '', status: 200, mime: '', response: '', ts, durationMs: 1 }]);
  const isoOk = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(v) && !Number.isNaN(Date.parse(v));
  const cases = [['正常 ts', '2026-11-24T01:02:03.000Z'], ['空 ts', ''], ['脏 ts', 'not-a-date'], ['无字段', undefined]];
  for (const [label, ts] of cases) {
    const har = sandbox.buildHar(mk(ts));
    const dt = har.log.entries[0].startedDateTime;
    assert(isoOk(dt), `har-time. ${label} → startedDateTime 是合法 ISO 8601(${dt})`);
  }
  // 同一份导出内, 多个缺 ts 条目共享同一基准(同批可比, 不是逐条 now)
  const two = sandbox.buildHar([...mk(''), ...mk('')]);
  const [a, b] = two.log.entries.map((e) => e.startedDateTime);
  assert(a === b, `har-time. 同份导出内缺 ts 条目共享同一基准(${a} == ${b})`);
}


// ---- 非绝对 url 的错误必须可定位(v1.1.77) ----
// 引擎只入库绝对 http(s), 所以正常录制不会触发; 但样本库(从 JMeter 官方 .jmx 解析的相对路径)
// 与未来的导入功能会 —— 裸 `Invalid URL` 既不说哪条、也不说该是什么形态。
{
  const jmxMod = require(path.join(ROOT, 'jmx.js'));
  const mkE = (url) => [{ method: 'GET', url, path: '/x', query: '', headers: {}, body: '', status: 200, response: '', ts: '' }];
  const shape = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };
  const m1 = shape(() => jmxMod.buildJmx(mkE('/index.html')));
  assert(m1 && /第 1 条请求/.test(m1), 'jmx-url. 相对路径 → 错误指明第几条请求: ' + m1);
  assert(m1 && /\/index\.html/.test(m1), 'jmx-url. 错误带上原始 url');
  assert(m1 && /https:\/\/host\/path|绝对地址/.test(m1), 'jmx-url. 错误说明期望形态(绝对地址)');
  assert(m1 && !/^Invalid URL$/.test(m1), 'jmx-url. 不再是裸 Invalid URL');
  const m2 = shape(() => jmxMod.buildJmx(mkE('')));
  assert(m2 && /url 为空/.test(m2), 'jmx-url. 空 url → 明说为空: ' + m2);
  const m3 = shape(() => jmxMod.buildJmx(mkE('ftp://a.test/x')));
  assert(m3 && /协议不是 http/.test(m3), 'jmx-url. 非 http(s) 协议 → 明说: ' + m3);
}


// ---- PY 与 JMX 的 url 错误语义必须一致(v1.1.78) ----
// 同一根因(非绝对 url)在两处实现: 只修一处 = 另一处仍是裸 Invalid URL。这里并列验证。
{
  const pyMod = require(path.join(ROOT, 'pyscript.js'));
  const jmxMod = require(path.join(ROOT, 'jmx.js'));
  const mkE = (url) => [{ method: 'GET', url, path: '/x', query: '', headers: {}, body: '', status: 200, response: '', ts: '' }];
  const msg = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };
  for (const [label, url, re] of [
    ['相对路径', '/index.html', /第 1 条请求.*不是绝对地址/],
    ['空 url', '', /第 1 条请求.*url 为空/],
    ['非 http(s)', 'ftp://a.test/x', /第 1 条请求.*协议不是 http/],
  ]) {
    const a = msg(() => jmxMod.buildJmx(mkE(url)));
    const b = msg(() => pyMod.buildPyScript(mkE(url)));
    assert(!!a && re.test(a), `url-err. JMX ${label} 错误可定位`);
    assert(!!b && re.test(b), `url-err. PY ${label} 错误可定位`);
  }
  // 两处都不得再出现裸错误
  for (const [nm, src] of [['jmx.js', fs.readFileSync(path.join(ROOT, 'jmx.js'), 'utf8')], ['pyscript.js', fs.readFileSync(path.join(ROOT, 'pyscript.js'), 'utf8')]]) {
    assert(!/const u = new URL\(e\.url\)/.test(src), `url-err. ${nm} 不再直接 new URL(e.url)`);
  }
}

console.log('=== 导出器字段差异契约 PASS ===');
