// check_jmx_setup_login.js —— setUp 线程组登录模式走查(v1.0.91)。
// 背景: OnceOnlyController 是「每线程一次」—— 10 并发线程 = 10 次登录(10 个独立会话),
// 巡检/单账号口径不想要。对标 KTKI创建销售订单-UAT.jmx 权威结构: setUp 线程组单线程
// 跑一遍, 全局只登 1 次; 跨线程组共享三件套(JMeter 线程变量/CookieManager 均线程隔离):
//   ① setUp 链尾 JSR223: cookie 拼串存 props.shared_cookie + 链变量 dump 到 props
//   ② 主线程组头部 HeaderManager: Cookie: ${__P(shared_cookie)}
//   ③ UDF 桥 V_xxx=${__P(V_xxx,录制值)}(勾数据驱动时) + JSONPostProcessor 提取在 setUp 线程
// 本走查钉死: setUp 结构/共享三件套/主组不含前置链/once 模式回归/全前置边界/autoRelogin 互斥。
const { buildJmx } = require("../jmx.js");
const assert = (cond, msg) => { if (!cond) { console.log("FAIL: " + msg); process.exit(1); } console.log("  OK " + msg); };

const mk = (id, method, url, extra) => {
  const u = new URL(url);
  return Object.assign({ id, method, url, path: u.pathname, query: u.search.slice(1), headers: {}, body: "", status: 200, mime: "application/json", response: "{}", ts: "2026-10-16T10:00:00Z" }, extra);
};

// 2 前置(登录) + 2 业务, 含 CSV 链变量
const entries = [
  mk("p1", "GET", "https://login.test.com/login?service=x", { response: "<html>login</html>" }),
  mk("p2", "POST", "https://login.test.com/login", { body: "username=u&password=p", response: '{"resultCode":"ISC-000"}' }),
  mk("b1", "POST", "https://api.test.com/web/iservice-wom/list", { body: '{"orderId":"${V_orderId}"}', response: '{"resultCode":"ISC-000"}' }),
  mk("b2", "POST", "https://api.test.com/web/iservice-wom/detail", { body: "{}", response: '{"resultCode":"ISC-000"}' }),
];
const prelude = ["p1", "p2"];
const csvData = [{ var: "V_orderId", default: "SO123" }];

// ================= 场景一: loginMode="setup"(默认导出口径) =================
const jmx = buildJmx(entries, { prelude, loginMode: "setup", csvData, csvFileName: "data_test.csv" });

// ① SetupThreadGroup: 单线程 1 循环, 在主 ThreadGroup 之前
const setupPos = jmx.indexOf('testclass="SetupThreadGroup" testname="登录（全局一次）"');
const tgPos = jmx.indexOf('testclass="ThreadGroup" testname="web-toolbox 回放"');
assert(setupPos > -1, "SetupThreadGroup「登录（全局一次）」存在");
assert(tgPos > setupPos, "setUp 线程组在主线程组之前(JMeter 保证先跑完)");
const setupSeg = jmx.slice(setupPos, tgPos);
assert(setupSeg.includes(">1</stringProp>") && setupSeg.includes('name="ThreadGroup.num_threads"'), "setUp 线程数 1(全局只登 1 次)");
assert(/name="LoopController\.loops">1</.test(setupSeg), "setUp 循环 1 次");
assert(setupSeg.includes("/login?service=x") && setupSeg.includes('testname="login"'), "前置登录链在 setUp 线程组内");

// ② 共享 JSR223: cookie 存 props.shared_cookie + 链变量 dump(BeanShell, 挂最后一个前置采样器)
const jsrPos = jmx.indexOf('testname="共享登录态到全局属性"');
assert(jsrPos > -1, "共享登录态 JSR223 存在");
assert(jmx.includes("props.put(&quot;shared_cookie&quot;, sb.toString());"), "cookie 拼串存 props.shared_cookie");
assert(jmx.includes("props.put(&quot;V_orderId&quot;, v);"), "链变量 V_orderId dump 到 props");
assert(jmx.includes('<stringProp name="scriptLanguage">beanshell</stringProp>'), "脚本语言 beanshell(本机 Java25 groovy 不兼容)");
// JSR223 在 setUp 段内(最后一个前置采样器的 hashTree 里)
assert(jsrPos > setupPos && jsrPos < tgPos, "共享 JSR223 挂在 setUp 线程组内");

// ③ 主线程组头部 Cookie 注入
assert(jmx.includes('testname="共享Session-Cookie"'), "主线程组头部「共享Session-Cookie」HeaderManager");
assert(jmx.includes("${__P(shared_cookie)}"), "Cookie 头引用 ${__P(shared_cookie)}");

// ④ 主线程组不含前置链/OnceOnly(前置全在 setUp)
const tgSeg = jmx.slice(tgPos);
assert(!tgSeg.includes("/login?service"), "主线程组不含登录前置采样器");
assert(!jmx.includes("OnceOnlyController"), "setup 模式不生成 OnceOnlyController");
assert(tgSeg.includes("list") && tgSeg.includes("detail"), "业务采样器在主线程组");

// ⑤ UDF 桥(跨组变量): V_orderId=${__P(V_orderId,录制值)} —— 主线程组线程启动时经 __P 读 setUp 存的 props 值
assert(jmx.includes(">V_orderId</stringProp><stringProp name=\"Argument.value\">${__P(V_orderId,SO123)}<"), "UDF 桥 V_orderId=__P(V_orderId,录制值)");

// ================= 场景二: 默认(不传 loginMode)回归 once 模式 =================
const jmxOnce = buildJmx(entries, { prelude, csvData, csvFileName: "d.csv" });
assert(!jmxOnce.includes("SetupThreadGroup"), "默认不传 loginMode → 无 setUp 线程组(行为不变)");
assert(jmxOnce.includes("OnceOnlyController"), "默认模式前置链包 OnceOnlyController(每线程一次)");
assert(!jmxOnce.includes("shared_cookie"), "默认模式无共享 Cookie 注入");

// ================= 场景三: setup + autoRelogin 同传 → setup 优先(互斥) =================
const jmxBoth = buildJmx(entries, { prelude, loginMode: "setup", autoRelogin: true, sessionMarkers: ["统一认证"], csvData: [], csvFileName: "d.csv" });
assert(jmxBoth.includes("SetupThreadGroup"), "setup+autoRelogin 同传: setUp 优先");
assert(!jmxBoth.includes("IfController"), "互斥: 不生成失效重登 IfController");

// ================= 场景四: 全部前置(无业务链) =================
const jmxAllPre = buildJmx(entries.slice(0, 2), { prelude: ["p1", "p2"], loginMode: "setup" });
assert(jmxAllPre.includes("SetupThreadGroup"), "全前置: setUp 线程组仍生成");
assert(!jmxAllPre.includes("共享Session-Cookie"), "全前置: 无业务链不注入共享 Cookie 头(无请求可带)");

// ================= 场景五: 无前置 → loginMode=setup 不生效(无登录可言) =================
const jmxNoPre = buildJmx(entries, { prelude: null, loginMode: "setup" });
assert(!jmxNoPre.includes("SetupThreadGroup"), "无前置链: 不生成空 setUp 线程组");

// ================= 场景六: setup + 数据驱动 CSV 共存 =================
// CSV 行值优先于 props 桥(CSVDataSet 每迭代覆盖线程变量), 两者不冲突
assert(jmx.includes('testname="CSV 数据文件设置"'), "setup 模式下 CSVDataSet 照常生成");
assert(jmx.includes("${csvPath}${csvFile}"), "CSV 引用路径 UDF");

console.log("\ncheck_jmx_setup_login 全部通过");