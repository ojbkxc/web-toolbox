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
// JMX 不消费 response/status(压测语义): e.response/e.status 出现即漂移
// (注意区分: jmx 里 r.status 是 python/运行时变量, 只查 e.xxx 条目字段形态)
assert(!/\be\.response\b/.test(jmx), 'f3. JMX 不消费 e.response(压测脚本不带响应体)');
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
console.log('=== 导出器字段差异契约 PASS ===');
