// check_jmx_auto_assert.js —— JMX 导出自动断言/报告组件走查(v1.0.83)。
// 导出的 JMX 此前是"裸"脚本(只有采样器+HeaderManager+CookieManager), 缺断言/报告/
// 结果落盘 —— 巡检时人工补, 易漏。v1.0.83 起 buildJmx 自动带 4 个组件:
//   ① ResponseAssertion(HTTP 200) —— 每个采样器挂一个(全量覆盖)
//   ② JSONPathAssertion($.resultCode==ISC-000) —— 仅 /web/iservice-* POST 挂
//   ③ Summary Report —— TestPlan 下唯一, 运行后看汇总
//   ④ ResultCollector(.jtl) —— TestPlan 下唯一, filename=result.jtl 落盘
// 本走查钉死: 组件存在、数量正确、作用域正确(iservice 才挂 JSONPath)、jtl filename 正确。
const { buildJmx } = require("../jmx.js");
const assert = (cond, msg) => { if (!cond) { console.log("FAIL: " + msg); process.exit(1); } console.log("  OK " + msg); };

const mk = (id, method, url, extra) => Object.assign({ id, method, url, path: new URL(url).pathname, query: "", headers: {}, body: "", status: 200, mime: "application/json", response: "{}", ts: "2026-10-16T10:00:00Z" }, extra);

// 三类条目: iservice POST(应挂 JSONPath) / 非 iservice POST(不挂) / GET(不挂)
const entries = [
  mk("e1", "POST", "https://host/web/iservice-spareparts/query", { body: '{"page":1}', response: '{"resultCode":"ISC-000"}' }),
  mk("e2", "POST", "https://host/api/order/create", { body: '{"orderNo":"A1"}', response: '{"ok":1}' }),
  mk("e3", "GET", "https://host/web/iservice-spareparts/list", { response: '{"resultCode":"ISC-000","list":[]}' }),
];

const jmx = buildJmx(entries);

// ① ResponseAssertion: 每个采样器一个(3 条目 = 3 个)
const raCount = (jmx.match(/<ResponseAssertion /g) || []).length;
assert(raCount === 3, `ResponseAssertion 恰好 3 个(每采样器一个, 实得 ${raCount})`);
assert(jmx.includes('Assertion.response_code'), "ResponseAssertion 断言 response_code(HTTP 状态码)");
assert(jmx.includes(">200<") || jmx.includes('"0">200</stringProp>'), "ResponseAssertion 期望值 200");

// ② JSONPathAssertion: 仅 iservice POST 挂(e1), 非 iservice POST(e2)与 GET(e3)不挂
const jpaCount = (jmx.match(/<JSONPathAssertion /g) || []).length;
assert(jpaCount === 1, `JSONPathAssertion 恰好 1 个(仅 iservice POST, 实得 ${jpaCount})`);
assert(jmx.includes("$.resultCode"), "JSONPathAssertion 路径 $.resultCode");
assert(jmx.includes("ISC-000"), "JSONPathAssertion 期望 ISC-000");
// 确认挂在 iservice POST 上: e1 的 path 出现在 JSONPath 之前(同一 hashTree 内)
const e1Pos = jmx.indexOf("/web/iservice-spareparts/query");
const jpaPos = jmx.indexOf("<JSONPathAssertion");
assert(e1Pos > -1 && jpaPos > -1 && jpaPos > e1Pos, "JSONPathAssertion 挂在 iservice POST 采样器之后");
// e2(非 iservice POST)与 e3(GET)附近不应有 JSONPathAssertion
const e2Pos = jmx.indexOf("/api/order/create");
const e3Pos = jmx.indexOf("/web/iservice-spareparts/list");
assert(jmx.indexOf("<JSONPathAssertion", e2Pos) === -1 || jmx.indexOf("<JSONPathAssertion", e2Pos) > jmx.indexOf("</hashTree>", jpaPos), "非 iservice POST 不挂 JSONPathAssertion");
assert(jmx.indexOf("<JSONPathAssertion", e3Pos) === -1 || jmx.indexOf("<JSONPathAssertion", e3Pos) > jmx.indexOf("</hashTree>", jpaPos), "GET 请求不挂 JSONPathAssertion");

// ③ Summary Report: TestPlan 下唯一
const srCount = (jmx.match(/<ResultCollector[^>]*SummaryReport/g) || []).length;
assert(srCount === 1, `Summary Report 恰好 1 个(实得 ${srCount})`);
assert(jmx.includes('"Summary Report"') || jmx.includes(">Summary Report<"), "Summary Report 存在");

// ④ ResultCollector(.jtl): filename=result.jtl
const jtlCount = (jmx.match(/<ResultCollector[^>]*SimpleDataWriter/g) || []).length;
assert(jtlCount === 1, `ResultCollector(.jtl) 恰好 1 个(实得 ${jtlCount})`);
assert(jmx.includes("result.jtl"), "jtl filename = result.jtl");

// 空条目边界: buildJmx 对空条目抛"没有已录请求"(L227 守卫), 不会产出残缺 JMX
let threw = false;
try { buildJmx([]); } catch (e) { threw = /没有已录请求/.test(e.message); }
assert(threw, "空条目 buildJmx 抛错(不产出残缺 JMX)");

console.log("\n=== JMX 自动断言/报告组件 PASS ===");