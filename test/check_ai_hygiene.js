// check_ai_hygiene.js —— AI 管线两级脱敏 + 顶级 prompt 升级走查(v1.0.95)。
// 背景: scrubLong 只兜 40+ 长串, "password=123456" 短值明文外发是真实泄漏面
// (此前 check_ai_full 149 钉底"已知边界", 本轮消除)。两级设计:
//   ① scrubLong(40+ 长串) —— 旧有
//   ② scrubSensitiveKeys(硬敏感键名: password/secret/sign 类, 值无论长短) —— 新增
//   token 类键名【不】进 ②: chain 建链靠短 token 值匹配, 打码即断链。
// 同时钉: 4 个 prompt 升级(few-shot/性能速览/公共参数)、温度分档、术语"高阶"。
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const assert = (cond, msg) => { if (!cond) { console.log("FAIL: " + msg); process.exit(1); } console.log("  OK " + msg); };

const A = require(ROOT + "/aireport.js");
const S = require(ROOT + "/skill.js");

// ================= ① scrubSensitiveKeys 形态覆盖 =================
assert(A.scrubSensitiveKeys("user=admin&password=SuperSecret123&x=1").includes("password=***MASKED***")
  && !A.scrubSensitiveKeys("user=admin&password=SuperSecret123&x=1").includes("SuperSecret123"),
  "① 表单体 password= 值打码");
assert(A.scrubSensitiveKeys('{"user":"a","password":"abc123"}').includes('"password":"***MASKED***'),
  "① JSON 体 \"password\": 值打码(引号形态)");
assert(A.scrubSensitiveKeys('{"pwd" : "p@ss"}').includes('"***MASKED***"'),
  "① JSON 体带空格 pwd 键打码");
assert(A.scrubSensitiveKeys("?password=abc&sign=3f2a").includes("password=***MASKED***")
  && A.scrubSensitiveKeys("?password=abc&sign=3f2a").includes("sign=***MASKED***"),
  "① URL query password/sign 打码");
assert(A.scrubSensitiveKeys("clientSecret=hunter2").includes("clientSecret=***MASKED***"),
  "① 驼峰 clientSecret 打码(i 标志 + _? 可选)");
assert(A.scrubSensitiveKeys('{"api_key":"k123"}').includes('"api_key":"***MASKED***'),
  "① api_key 打码");

// ================= ② 边界: 子串不误伤 =================
const design = A.scrubSensitiveKeys("https://x.com/design?id=1&assign=2");
assert(design.includes("design?id=1") && design.includes("assign=2"),
  "② design/assign 不被 sign 子串误伤(\\b 边界)");

// ================= ③ token 短值保留(建链不破坏) =================
const tokenKeep = A.scrubSensitiveKeys('{"token":"tk123"}');
assert(tokenKeep.includes('"token":"tk123"'),
  "③ token 短值保留(chain 建链靠短值匹配, 40+ 长值由 scrubLong 兜)");
const tokenLong = A.scrubAi('{"token":"' + "A".repeat(60) + '"}');
assert(tokenLong.includes("***MASKED***") && !tokenLong.includes("A".repeat(60)),
  "③ token 60+ 长值仍被 scrubLong 打码(两级互补)");

// ================= ④ 幂等性 =================
const once = A.scrubAi("password=abc123");
assert(A.scrubAi(once) === once, "④ scrubAi 幂等(已打码串再跑不变)");

// ================= ⑤ aiSanitizeEntry 集成: 全字段走两级 =================
const dirty = {
  method: "POST", url: "https://x.com/login?password=q1w2e3&tenant=acme",
  headers: { "X-Biz": "1", "X-Api-Key": "should-not-appear" },
  body: "user=admin&password=SuperSecret123&sign=3f2a&token=tk123",
  status: 200, response: '{"secret":"s1","data":{"ok":1}}',
};
const s = A.aiSanitizeEntry(dirty);
assert(!s.url.includes("q1w2e3") && s.url.includes("password=***MASKED***"), "⑤ url query 短密码打码");
assert(!s.body.includes("SuperSecret123") && s.body.includes("sign=***MASKED***"), "⑤ body 密码/签名打码");
assert(s.body.includes("token=tk123"), "⑤ body 短 token 保留(建链)");
assert(!s.headers.includes("should-not-appear"), "⑤ X-Api-Key 头剥除(AI_SKIP_HEADERS 扩展)");
assert(!s.response.includes('"secret":"s1"'), "⑤ response secret 键打码");

// ================= ⑥ pathLine: query 键名打码 =================
assert(A.pathLine("https://x.com/login?password=abc&cursor=AAA") === "/login?password=***MASKED***&cursor=AAA",
  "⑥ pathLine query 密码打码, 短业务参数保留");

// ================= ⑦ prompt 升级: chain few-shot =================
const chainMsgs = A.buildChainPrompt([{ method: "POST", url: "https://x.com/login", path: "/login", query: "", headers: {}, body: "{}", status: 200, response: "{}", mime: "application/json", ts: "2026-10-16T10:00:00Z" }]);
const chainSys = chainMsgs[0].content;
assert(chainSys.includes("完整示例(输入流量节选)"), "⑦ chain prompt 含 few-shot 完整示例段");
assert(chainSys.includes('"from":1,"fromJsonPath":"data.token"'), "⑦ chain 示例含 token 链(建链范型)");
assert(chainSys.includes('"from":2,"fromJsonPath":"data.orderNo","to":3,"toParam":"url.orderNo"'), "⑦ chain 示例含 url 参数链(toParam 三形态之 url)");

// ================= ⑧ prompt 升级: assert 示例 =================
const assertSys = A.buildAssertPrompt(dirty)[0].content;
assert(assertSys.includes("示例(响应"), "⑧ assert prompt 含输出示例");
assert(assertSys.includes('{"type":"json_eq","target":"resultCode"'), "⑧ assert 示例含 json_eq 形态");

// ================= ⑨ prompt 升级: report 性能速览 =================
const reportSys = A.buildReportPrompt([])[0].content;
assert(reportSys.includes("性能速览"), "⑨ report prompt 含性能速览段");
assert(reportSys.includes("最慢 3 条"), "⑨ 性能速览点名最慢 3 条(量化洞察)");
assert(reportSys.includes("无耗时数据则整段省略"), "⑨ 无耗时时明示省略(不编造)");

// ================= ⑩ prompt 升级: doc 公共参数 =================
const docSys = A.buildDocPrompt([])[0].content;
assert(docSys.includes("公共参数"), "⑩ doc prompt 含公共参数提取段");

// ================= ⑪ 温度分档(sidepanel 源码形态) =================
const spJs = fs.readFileSync(path.join(ROOT, "sidepanel/sidepanel.js"), "utf8");
assert(spJs.includes('SKILL_TEMP0 = new Set(["chain", "assert", "sensitive", "inventory"])'),
  "⑪ 确定性任务温度 0: chain/assert/sensitive/inventory");
assert(spJs.includes("SKILL_TEMP0.has(skill.name) ? 0 : 0.2"), "⑪ 叙述性分析保留 0.2");

// ================= ⑫ 术语: 高阶 =================
for (const sk of S.BUILTIN_SKILLS) {
  assert(["基础", "高阶"].includes(sk.category), "⑫ skill.category 合法: " + sk.name + "=" + sk.category);
}
assert(S.BUILTIN_SKILLS.filter((sk) => sk.category === "高阶").length === 5, "⑫ 高阶技能 5 个");
assert(S.BUILTIN_SKILLS.filter((sk) => sk.category === "基础").length === 5, "⑫ 基础技能 5 个");

console.log("PASS check_ai_hygiene");