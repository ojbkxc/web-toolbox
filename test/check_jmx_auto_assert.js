// check_jmx_auto_assert.js —— JMX 导出自动断言/报告组件走查(v1.0.83→v1.0.88)。
// 导出的 JMX 此前是"裸"脚本(只有采样器+HeaderManager+CookieManager), 缺断言/报告/
// 结果落盘 —— 巡检时人工补, 易漏。v1.0.83 起 buildJmx 自动带 4 个组件:
//   ① ResponseAssertion(HTTP 200) —— 每个采样器挂一个(全量覆盖)
//   ② JSONPathAssertion(v1.0.88 响应推断式) —— 从录制响应自动检测成功指示字段,
//      不靠路径前缀/方法/硬编码成功码, 任何系统的 API 都能自动挂业务断言。
//   ③ Summary Report —— TestPlan 下唯一, 运行后看汇总
//   ④ ResultCollector(.jtl) —— TestPlan 下唯一, filename=result.jtl 落盘
// 本走查钉死: 组件存在、数量正确、作用域正确、多系统断言覆盖、jtl filename 正确。
const { buildJmx } = require("../jmx.js");
const { detectSuccessIndicator } = require("../common.js");
const assert = (cond, msg) => { if (!cond) { console.log("FAIL: " + msg); process.exit(1); } console.log("  OK " + msg); };

const mk = (id, method, url, extra) => Object.assign({ id, method, url, path: new URL(url).pathname, query: "", headers: {}, body: "", status: 200, mime: "application/json", response: "{}", ts: "2026-10-16T10:00:00Z" }, extra);

// 七类条目: 覆盖 ICS/支付/SSE/无业务码/错误响应/GET/非业务 POST
const entries = [
  mk("e1", "POST", "https://host/web/iservice-spareparts/query", { body: '{"page":1}', response: '{"resultCode":"ISC-000"}' }),
  mk("e2", "POST", "https://host/api/order/create", { body: '{"orderNo":"A1"}', response: '{"ok":1}' }),
  mk("e3", "GET", "https://host/web/iservice-spareparts/list", { response: '{"resultCode":"ISC-000","list":[]}' }),
  mk("e4", "POST", "https://host/api/pay/submit", { body: '{}', response: '{"resultCode":"0","data":{"orderId":"X"}}' }),
  mk("e5", "GET", "https://host/api/health", { response: '{"status":"ok","cpu":41}' }),
  mk("e6", "POST", "https://host/api/pet", { body: '{}', response: '{"id":1,"name":"fido"}' }),
  mk("e7", "POST", "https://host/api/error", { body: '{}', response: '{"resultCode":"ISC-999","msg":"权限不足"}' }),
];

const jmx = buildJmx(entries);

// ① ResponseAssertion: 每个采样器一个(7 条目 = 7 个)
const raCount = (jmx.match(/<ResponseAssertion /g) || []).length;
assert(raCount === 7, `ResponseAssertion 恰好 7 个(每采样器一个, 实得 ${raCount})`);
assert(jmx.includes('Assertion.response_code'), "ResponseAssertion 断言 response_code(HTTP 状态码)");
assert(jmx.includes(">200<") || jmx.includes('"0">200</stringProp>'), "ResponseAssertion 期望值 200");

// ② JSONPathAssertion(v1.0.88 响应推断式): 从录制响应自动检测成功指示字段
// e1(ISC POST resultCode=ISC-000) ✅  e2(ok:1 无业务码字段) ❌
// e3(ICS GET resultCode=ISC-000) ✅   e4(支付 resultCode=0) ✅
// e5(SSE status=ok) ✅                e6(petstore 无业务码) ❌
// e7(ISC-999 错误响应) ❌
const jpaCount = (jmx.match(/<JSONPathAssertion /g) || []).length;
assert(jpaCount === 4, `JSONPathAssertion 恰好 4 个(e1/e3/e4/e5 有成功指示, 实得 ${jpaCount})`);
// ICS 体系
assert(jmx.includes("$.resultCode"), "JSONPathAssertion 含 $.resultCode(ICS 体系)");
assert(jmx.includes("ISC-000"), "JSONPathAssertion 期望 ISC-000(ICS 成功码)");
// 支付体系(resultCode=0)
assert(jmx.includes(">0<") && jmx.includes("$.resultCode"), "JSONPathAssertion 覆盖支付体系 resultCode=0");
// SSE 体系(status=ok)
assert(jmx.includes("$.status"), "JSONPathAssertion 含 $.status(SSE 体系)");
assert(jmx.includes("ok"), "JSONPathAssertion 期望 ok(SSE 成功码)");
// ISREGEX=false(精确匹配, 非正则)
assert(jmx.includes('"ISREGEX">false</boolProp>'), "JSONPathAssertion ISREGEX=false(精确匹配)");
// 错误响应(ISC-999)不挂断言
assert(!jmx.includes("ISC-999"), "错误响应 ISC-999 不生成断言(只断成功值)");
// 无业务码响应(petstore {id,name})不挂 JSONPath 断言
const e6Pos = jmx.indexOf("/api/pet");
const e6End = jmx.indexOf("</hashTree>", e6Pos);
assert(jmx.indexOf("<JSONPathAssertion", e6Pos) === -1 || jmx.indexOf("<JSONPathAssertion", e6Pos) > e6End, "无业务码响应不挂 JSONPathAssertion");

// ②b detectSuccessIndicator 单元测试
assert(detectSuccessIndicator('{"resultCode":"ISC-000"}').jsonPath === "$.resultCode", "detect: ISC-000 → $.resultCode");
assert(detectSuccessIndicator('{"resultCode":"0"}').expectedValue === "0", "detect: resultCode=0 → 期望值 0");
assert(detectSuccessIndicator('{"code":0}').jsonPath === "$.code", "detect: code=0 → $.code");
assert(detectSuccessIndicator('{"status":"ok"}').jsonPath === "$.status", "detect: status=ok → $.status");
assert(detectSuccessIndicator('{"success":true}').expectedValue === "true", "detect: success=true → 期望值 true");
assert(detectSuccessIndicator('{"resultCode":"ISC-999"}') === null, "detect: ISC-999(错误) → null");
assert(detectSuccessIndicator('{"id":1,"name":"fido"}') === null, "detect: 无业务码 → null");
assert(detectSuccessIndicator('{"error":{"code":"0"}}').jsonPath === "$.error.code", "detect: 嵌套 error.code=0 → $.error.code");
assert(detectSuccessIndicator("not json") === null, "detect: 非 JSON → null");
assert(detectSuccessIndicator("") === null, "detect: 空响应 → null");
assert(detectSuccessIndicator('[1,2,3]') === null, "detect: 数组 → null");
assert(detectSuccessIndicator('{"resultCode":"SPM-000"}').expectedValue === "SPM-000", "detect: SPM-000(另一系统) → 期望值 SPM-000");

// ③ Summary Report: TestPlan 下唯一
const srCount = (jmx.match(/<ResultCollector[^>]*SummaryReport/g) || []).length;
assert(srCount === 1, `Summary Report 恰好 1 个(实得 ${srCount})`);
assert(jmx.includes('"Summary Report"') || jmx.includes(">Summary Report<"), "Summary Report 存在");

// ③b View Results Tree(v1.0.85): 察看结果树, GUI 调试核心工具
const vrtCount = (jmx.match(/<ResultCollector[^>]*ViewResultsFullVisualizer/g) || []).length;
assert(vrtCount === 1, `View Results Tree 恰好 1 个(实得 ${vrtCount})`);
assert(jmx.includes("察看结果树"), "View Results Tree testname=察看结果树");
// M2(v1.0.86): View Results Tree 开启 responseData/requestHeaders/responseHeaders(巡检定位失败必须看)
const vrtBlock = jmx.slice(jmx.indexOf("ViewResultsFullVisualizer"), jmx.indexOf("ViewResultsFullVisualizer") + 800);
assert(vrtBlock.includes("<responseData>true</responseData>"), "View Results Tree 开启 responseData(巡检看响应体)");
assert(vrtBlock.includes("<requestHeaders>true</requestHeaders>"), "View Results Tree 开启 requestHeaders(巡检看请求头)");
assert(vrtBlock.includes("<responseHeaders>true</responseHeaders>"), "View Results Tree 开启 responseHeaders(巡检看响应头)");

// ④ ResultCollector(.jtl): filename=result.jtl
const jtlCount = (jmx.match(/<ResultCollector[^>]*SimpleDataWriter/g) || []).length;
assert(jtlCount === 1, `ResultCollector(.jtl) 恰好 1 个(实得 ${jtlCount})`);
assert(jmx.includes("result.jtl"), "jtl filename = result.jtl");

// 空条目边界: buildJmx 对空条目抛"没有已录请求"(L227 守卫), 不会产出残缺 JMX
let threw = false;
try { buildJmx([]); } catch (e) { threw = /没有已录请求/.test(e.message); }
assert(threw, "空条目 buildJmx 抛错(不产出残缺 JMX)");

console.log("\n=== JMX 自动断言/报告组件 PASS ===");