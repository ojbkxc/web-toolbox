// JMX 导出器: 已录条目 -> JMeter .jmx (5.6.3 兼容)
// SKIP_HEADERS/isSkipHeader 由 common.js 提供(勿重复声明, 同页 script 共享全局作用域)
// node 单测直接 require 本文件时没有 common.js 前置 —— 兜底定义
if (typeof isSkipHeader === "undefined") {
  const SKIP_HEADERS = ["cookie", "referer", "origin", "host", "content-length",
    "accept-encoding", "connection", "user-agent", "sec-ch-ua", "sec-ch-ua-mobile",
    "sec-ch-ua-platform", "sec-fetch-dest", "sec-fetch-mode", "sec-fetch-site",
    "sec-fetch-user", "authorization", "accept", "accept-language"];
  function isSkipHeader(k) {
    return SKIP_HEADERS.includes(String(k).toLowerCase());
  }
}
// detectSuccessIndicator 由 common.js 提供(同页全局); node 单测兜底 require
if (typeof detectSuccessIndicator === "undefined") {
  ({ detectSuccessIndicator } = require("./common.js"));
}
// 格式完全参照 iserver/scripts/gen_ktki_perf_jmx.py 的权威生成器
// (该脚本生成的 jmx 已在 SPM销售性能-UAT 实测 31 采样器 0 失败)。
//
// 生成结构:
//   TestPlan(UDF: BASE_URL 等) > HTTP默认值 > CookieManager > ThreadGroup(${threads}/${loops}/${rampup})
//     > [GET/POST 采样器...] 每个: HeaderManager(业务头) + 可选 JSON 提取器(关联变量)

// XML 转义(JMeter body 里换行还要转 &#10;)
function xmlEsc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\r\n|\r|\n/g, "&#10;");
}

// Once Only Controller：每个线程只执行一次内部子节点(登录等环境准备)。
// 之后的循环只跑线程组里 OnceOnly 之外的业务链路 —— 压测多轮时登录不重复。
// 与 iserver/scripts/gen_ktki_perf_jmx.py 的 once_only() 完全同构。
function onceOnly(inner) {
  return '<OnceOnlyController guiclass="OnceOnlyControllerGui" testclass="OnceOnlyController" testname="仅一次控制器(登录前置)" enabled="true"/><hashTree>' +
    inner +
    "</hashTree>";
}

// TransactionController(parent=true)：保留所有子采样器独立计时, 额外生成聚合父样本「登录前置条件」。
// 与生成器 tc_summary() 同构 —— 报告里多一行「登录前置条件」= 前置请求时间总和, 子采样器仍各自独立。
function tcSummary(name, inner) {
  return '<TransactionController guiclass="TransactionControllerGui" testclass="TransactionController" testname="' + xmlEsc(name) + '" enabled="true">' +
    '<boolProp name="TransactionController.includeTimers">false</boolProp><boolProp name="TransactionController.parent">true</boolProp>' +
    "</TransactionController><hashTree>" + inner + "</hashTree>";
}

// 会话失效自动重登(可选项, opts.autoRelogin=true 时生成):
//   前置链放 IfController「未登录则登录」: 线程变量 __logged_in 控制 —— 首循环为空 → 登录,
//   之后循环变量保持 true → 跳过(等价于 OnceOnly 的"只执行一次", 但会话失效后能自动重登)。
//   业务链放 IfController「已登录则执行」; 业务首采样器挂 JSR223 后处理器:
//   响应含登录页特征 → 置 __logged_in=false → 下一循环自动重登。
//   会话中途失效: 本循环业务照跑(会失败), 下一循环开头重登后再跑, 不丢链路。
function jsr223LoginReset(markers) {
  const checks = (markers || []).map((m) => `text.contains(${JSON.stringify(m)})`).join(" || ");
  return '<JSR223PostProcessor guiclass="TestBeanGui" testclass="JSR223PostProcessor" testname="会话失效检测" enabled="true">' +
    '<stringProp name="cacheKey">true</stringProp>' +
    '<stringProp name="filename"/>' +
    '<stringProp name="language">groovy</stringProp>' +
    '<stringProp name="script">def text = prev.getResponseDataAsString();\n' +
    "if (" + checks + ") { vars.put(\"__logged_in\", \"false\"); }</stringProp>" +
    "</JSR223PostProcessor><hashTree/>";
}

function loginGate(inner) {
  // __logged_in 未置 true 就执行登录(首循环 / 会话失效后的重登)
  return '<IfController guiclass="IfControllerPanel" testclass="IfController" testname="会话失效则重新登录(仅登录前置)" enabled="true">' +
    '<stringProp name="IfController.condition">${__jexl3(vars.get(\'__logged_in\') != \'true\')}</stringProp>' +
    '<boolProp name="IfController.evaluateAll">true</boolProp>' +
    '<boolProp name="IfController.useExpression">true</boolProp>' +
    "</IfController><hashTree>" + inner + "</hashTree>";
}

function bizGate(inner) {
  return '<IfController guiclass="IfControllerPanel" testclass="IfController" testname="已登录则执行业务链路" enabled="true">' +
    '<stringProp name="IfController.condition">${__jexl3(vars.get(\'__logged_in\') == \'true\')}</stringProp>' +
    '<boolProp name="IfController.evaluateAll">true</boolProp>' +
    '<boolProp name="IfController.useExpression">true</boolProp>' +
    "</IfController><hashTree>" + inner + "</hashTree>";
}

// BeanShell 采样器: 登录成功后置 __logged_in=true(线程变量, 循环间保留)
function loggedInSetter() {
  return '<BeanShellSampler guiclass="TestBeanGui" testclass="BeanShellSampler" testname="标记已登录" enabled="true">' +
    '<stringProp name="BeanShellSampler.query">vars.put("__logged_in","true");</stringProp>' +
    '<stringProp name="BeanShellSampler.filename"/>' +
    '<boolProp name="BeanShellSampler.resetInterpreter">false</boolProp>' +
    "</BeanShellSampler><hashTree/>";
}

// 会话失效自动重登的完整包裹: 登录前置链 + 业务链 分别进 IfController
// preludeSamplers/businessSamplers 均为拼接好的采样器 XML 文本
function reloginBlock(preludeSamplers, businessSamplers, sessionMarkers) {
  // 把失效检测(JSR223)挂到业务链第一个采样器后: 在首个 </hashTree> 之前插一个空 hashTree 放后置处理器
  let biz = businessSamplers || "";
  if (sessionMarkers && sessionMarkers.length && biz) {
    const firstEnd = biz.indexOf("</hashTree>");
    if (firstEnd !== -1) {
      const reset = jsr223LoginReset(sessionMarkers);
      biz = biz.slice(0, firstEnd) + "</hashTree>" + reset + biz.slice(firstEnd + "</hashTree>".length);
    }
  }
  return loginGate(preludeSamplers + loggedInSetter()) +
    (biz ? bizGate(biz) : ""); // 业务链为空(全部条目都是前置)时不挂空 IfController
}

// ---- setUp 线程组登录模式(v1.0.91, loginMode="setup", 对标 KTKI创建销售订单-UAT.jmx 权威结构) ----
// 与 OnceOnlyController(每线程一次, 10 线程=10 个独立会话)不同: setUp 线程组单线程跑一遍,
// 整个测试计划只登录 1 次, 主线程组线程数再多也共享同一会话 —— 巡检/单账号并发口径。
// 跨线程组登录态共享三件套(JMeter 线程变量与 CookieManager 都是线程隔离的, 不共享):
//   ① setUp 链尾 JSR223 把 CookieManager 的 cookie 拼串存 props.shared_cookie(全局属性)
//   ② 主线程组头部 HeaderManager 统一注入 Cookie: ${__P(shared_cookie)}
//   ③ 链变量桥: setUp 提取的 V_xxx 逐个 props.put; UDF 层 V_xxx=${__P(V_xxx,录制值)} 让
//      主线程组线程启动时经 __P 读到 props 值(未提取到时落录制默认值)。与 KTKI 的 CSV 传参
//      等价但免 CSV 文件; 勾了数据驱动时 CSV 行值仍优先(CSVDataSet 每迭代覆盖线程变量)。
// BeanShell 而非 groovy: 本机 Java 25 下 groovy 不兼容(实测), KTKI 用 beanshell 跑通。
function setupThreadGroup() {
  return '<SetupThreadGroup guiclass="SetupThreadGroupGui" testclass="SetupThreadGroup" testname="登录（全局一次）" enabled="true">' +
    '<stringProp name="ThreadGroup.on_sample_error">continue</stringProp>' +
    '<stringProp name="ThreadGroup.num_threads">1</stringProp>' +
    '<stringProp name="ThreadGroup.ramp_time">1</stringProp>' +
    '<stringProp name="ThreadGroup.same_user_on_next_iteration">true</stringProp>' +
    '<elementProp name="ThreadGroup.main_controller" elementType="LoopController" guiclass="LoopControlPanel" testclass="LoopController" testname="Loop Controller" enabled="true">' +
    '<boolProp name="LoopController.continue_forever">false</boolProp>' +
    '<stringProp name="LoopController.loops">1</stringProp>' +
    "</elementProp></SetupThreadGroup>";
}

// setUp 链尾共享 JSR223: cookie 拼串 + 链变量 dump 到全局属性(挂最后一个前置采样器的 hashTree 内)
function jsr223ShareState(varNames) {
  const dump = varNames.map((v) =>
    `String v = vars.get(${JSON.stringify(v)});\nif (v != null) props.put(${JSON.stringify(v)}, v);`).join("\n");
  const script =
    "import org.apache.jmeter.protocol.http.control.CookieManager;\n" +
    "CookieManager cm = sampler.getCookieManager();\n" +
    "if (cm != null) {\n" +
    "  StringBuffer sb = new StringBuffer();\n" +
    "  for (int i = 0; i < cm.getCookieCount(); i++) {\n" +
    "    org.apache.jmeter.protocol.http.control.Cookie c = cm.get(i);\n" +
    "    sb.append(c.getName()).append(\"=\").append(c.getValue()).append(\"; \");\n" +
    "  }\n" +
    "  props.put(\"shared_cookie\", sb.toString());\n" +
    "}\n" + dump;
  return '<JSR223PostProcessor guiclass="TestBeanGui" testclass="JSR223PostProcessor" testname="共享登录态到全局属性" enabled="true">' +
    '<stringProp name="cacheKey">true</stringProp>' +
    `<stringProp name="script">${xmlEsc(script)}</stringProp>` +
    '<stringProp name="scriptLanguage">beanshell</stringProp>' +
    "</JSR223PostProcessor><hashTree/>";
}

// 主线程组头部 Cookie 注入: 所有业务采样器统一带 setUp 会话的 Cookie 头
function sharedCookieHeader() {
  return '<HeaderManager guiclass="HeaderPanel" testclass="HeaderManager" testname="共享Session-Cookie" enabled="true">' +
    '<collectionProp name="HeaderManager.headers"><elementProp name="" elementType="Header">' +
    '<stringProp name="Header.name">Cookie</stringProp>' +
    '<stringProp name="Header.value">${__P(shared_cookie)}</stringProp>' +
    "</elementProp></collectionProp></HeaderManager><hashTree/>";
}

// 采样器命名: path 最后一段, 重名加序号
function samplerName(e, used) {
  let base = e.path.split("/").filter(Boolean).pop() || e.path || "req";
  let name = base, i = 2;
  while (used.has(name)) { name = base + "_" + i++; }
  used.add(name);
  return name;
}

// 单条请求 -> HTTPSamplerProxy + 挂 HeaderManager
// opts: { domain, protocol, correlated: Map<path+name, "${var}"> }
function httpSampler(e, opts) {
  const u = new URL(e.url);
  const name = e._samplerName;
  const parts = [];

  parts.push(`<HTTPSamplerProxy guiclass="HttpTestSampleGui" testclass="HTTPSamplerProxy" testname="${xmlEsc(name)}" enabled="true">`);

  if (e.body) {
    // raw body(POST JSON 等)
    parts.push('<boolProp name="HTTPSampler.postBodyRaw">true</boolProp>');
    parts.push('<elementProp name="HTTPsampler.Arguments" elementType="Arguments">');
    parts.push('<collectionProp name="Arguments.arguments">');
    parts.push('<elementProp name="" elementType="HTTPArgument"><boolProp name="HTTPArgument.always_encode">false</boolProp>');
    parts.push(`<stringProp name="Argument.value">${xmlEsc(e.body || "")}</stringProp>`);
    parts.push('<stringProp name="Argument.metadata">=</stringProp></elementProp>');
    parts.push("</collectionProp></elementProp>");
  } else {
    parts.push('<elementProp name="HTTPsampler.Arguments" elementType="Arguments" guiclass="HTTPArgumentsPanel" testclass="Arguments" enabled="true">');
    parts.push('<collectionProp name="Arguments.arguments"/>');
    parts.push("</elementProp>");
  }

  // path + query(query 里的 & 已在 xmlEsc 转义)
  let fullPath = e.path + (e.query ? "?" + e.query : "");
  parts.push(`<stringProp name="HTTPSampler.domain">${opts.domain}</stringProp>`);
  parts.push("<stringProp name=\"HTTPSampler.port\"/>");
  parts.push(`<stringProp name="HTTPSampler.protocol">${u.protocol.replace(":", "")}</stringProp>`);
  parts.push('<stringProp name="HTTPSampler.contentEncoding">UTF-8</stringProp>');
  parts.push(`<stringProp name="HTTPSampler.path">${xmlEsc(fullPath)}</stringProp>`);
  parts.push(`<stringProp name="HTTPSampler.method">${e.method}</stringProp>`);
  parts.push('<boolProp name="HTTPSampler.follow_redirects">true</boolProp>');
  parts.push('<boolProp name="HTTPSampler.auto_redirects">false</boolProp>');
  parts.push('<boolProp name="HTTPSampler.use_keepalive">true</boolProp>');
  parts.push('<boolProp name="HTTPSampler.DO_MULTIPART_POST">false</boolProp>');
  parts.push("</HTTPSamplerProxy>");
  parts.push("<hashTree>");

  // HeaderManager: 只带业务头(Cookie 由 CookieManager 管; sec-/UA/浏览器头剔除)。
  // _keepHeaders 是链注入头集合(applyAiChainToJmx 打标): 链注入的 Authorization 等
  // 是提取器 live 值, 不随录制快照头一起剔 —— 否则 Bearer 系统的链静默失效。
  const biz = Object.entries(e.headers).filter(([k]) =>
    !isSkipHeader(k) || (e._keepHeaders && e._keepHeaders.has(String(k).toLowerCase())));
  if (biz.length) {
    parts.push('<HeaderManager guiclass="HeaderPanel" testclass="HeaderManager" testname="HTTP HeaderManager" enabled="true">');
    parts.push('<collectionProp name="HeaderManager.headers">');
    for (const [k, v] of biz) {
      parts.push(`<elementProp name="" elementType="Header"><stringProp name="Header.name">${xmlEsc(k)}</stringProp><stringProp name="Header.value">${xmlEsc(v)}</stringProp></elementProp>`);
    }
    parts.push("</collectionProp></HeaderManager><hashTree/>");
  }

  // 关联提取器(如配置): _extractors 数组(applyAiChainToJmx 产出, 同一 from 多链多字段)
  for (const ex of (e._extractors || [])) {
    parts.push(`<JSONPostProcessor guiclass="JSONPostProcessorGui" testclass="JSONPostProcessor" testname="提取 ${xmlEsc(ex.var)}" enabled="true">`);
    parts.push(`<stringProp name="JSONPostProcessor.referenceNames">${xmlEsc(ex.var)}</stringProp>`);
    parts.push(`<stringProp name="JSONPostProcessor.jsonPathExprs">${xmlEsc(ex.expr)}</stringProp>`);
    parts.push('<stringProp name="JSONPostProcessor.match_numbers">1</stringProp>');
    parts.push(`<stringProp name="JSONPostProcessor.defaultValues">${xmlEsc(ex.default || "NOT_FOUND")}</stringProp>`);
    parts.push("</JSONPostProcessor><hashTree/>");
  }

  // 自动断言(v1.0.83): 导出即带, 开箱可巡检
  // ResponseAssertion: HTTP 200(所有请求)
  parts.push('<ResponseAssertion guiclass="AssertionGui" testclass="ResponseAssertion" testname="HTTP 200 断言" enabled="true">');
  parts.push('<collectionProp name="Asserion.test_strings"><stringProp name="0">200</stringProp></collectionProp>');
  parts.push('<stringProp name="Assertion.test_field">Assertion.response_code</stringProp>');
  parts.push('<boolProp name="Assertion.assume_success">false</boolProp>');
  parts.push('<intProp name="Assertion.test_type">8</intProp>');
  parts.push('</ResponseAssertion>');
  parts.push('<hashTree/>');
  // JSONPathAssertion(v1.0.88): 响应推断式 —— 从录制响应自动检测成功指示字段,
  // 不靠路径前缀/方法/硬编码成功码, 任何系统的 API 都能自动挂业务断言。
  const si = detectSuccessIndicator(e.response);
  if (si) {
    parts.push(`<JSONPathAssertion guiclass="JSONPathAssertionGui" testclass="JSONPathAssertion" testname="${xmlEsc(si.jsonPath)}=${xmlEsc(si.expectedValue)} 断言" enabled="true">`);
    parts.push(`<stringProp name="JSON_PATH">${xmlEsc(si.jsonPath)}</stringProp>`);
    parts.push(`<stringProp name="EXPECTED_VALUE">${xmlEsc(si.expectedValue)}</stringProp>`);
    parts.push('<boolProp name="JSONVALIDATION">true</boolProp>');
    parts.push('<boolProp name="EXPECT_NULL">false</boolProp>');
    parts.push('<boolProp name="INVERT">false</boolProp>');
    parts.push('<boolProp name="ISREGEX">false</boolProp>');
    parts.push('</JSONPathAssertion>');
    parts.push('<hashTree/>');
  }

  parts.push("</hashTree>");
  return parts.join("\n");
}

// M2(v1.0.86): saveConfig 提取为函数, 消除三段 39 行重复。
// View Results Tree 开启 responseData/requestHeaders/responseHeaders(GUI 调试看详情);
// Summary Report / jtl 保持精简(避免大文件)。
function saveConfigXml(o) {
  o = o || {};
  return '<objProp><name>saveConfig</name><value class="SampleSaveConfiguration">' +
    '<time>true</time><latency>true</latency><success>true</success>' +
    '<label>true</label><code>true</code><message>true</message>' +
    '<threadName>true</threadName><dataType>true</dataType>' +
    '<encoding>false</encoding><assertions>true</assertions>' +
    '<subresults>true</subresults>' +
    `<responseData>${o.responseData ? "true" : "false"}</responseData>` +
    '<samplerData>false</samplerData><xml>false</xml>' +
    '<fieldNames>true</fieldNames>' +
    `<responseHeaders>${o.responseHeaders ? "true" : "false"}</responseHeaders>` +
    `<requestHeaders>${o.requestHeaders ? "true" : "false"}</requestHeaders>` +
    '<responseDataOnError>true</responseDataOnError>' +
    '<saveAssertionResultsFailureMessage>true</saveAssertionResultsFailureMessage>' +
    '<bytes>true</bytes><sentBytes>true</sentBytes><url>true</url>' +
    '<threadCounts>true</threadCounts><idleTime>true</idleTime><connectTime>true</connectTime>' +
    '</value></objProp>';
}

// entries -> 完整 .jmx 文本
// opts: { threads, rampup, loops, think, domainOverride, title, prelude, autoRelogin, sessionMarkers, csvData }
//   prelude:      前置条目的 id 数组(或 null)。命中 → 这些采样器包进 OnceOnlyController
//                 (每线程只执行一次; autoRelogin 时改包 IfController 实现会话失效自动重登)。
//   autoRelogin:  会话失效自动重登开关。开启时前置链进「未登录则登录」IfController,
//                 业务链进「已登录则执行」IfController, 业务首采样器挂失效检测。
//   sessionMarkers: 判定会话失效的响应子串(如 ["统一认证", "请重新登录"])。
//   csvData:      [{var, default}] 数据驱动列(collectCsvData 产出)。勾选导出时:
//                 ThreadGroup 内生成 CSVDataSet(引用 ${csvPath}${csvFile}) + 每列
//                 UDF 兜底值(无 CSV 文件也能跑: JMeter 找不到文件时变量取 UDF 默认)。
//                 csvPath/csvFile UDF 在 TestPlan 层定义, -JcsvPath=../data/ 可换目录。
//                 CSV 第一行是表头, 首行数据=录制值(用户补多行即多数据驱动, 对标
//                 KTKI SPM_TIKT_UAT.csv 姿势)。
//   domainOverride: 「HTTP 请求默认值」块的 domain 用它(字面量)。采样器 domain 走 ${HOST_n}
//                 变量(v1.0.79), 与 defaults 互不依赖。参数对齐 iserver gen_ktki_perf_jmx.py
//                 签名(JMeter 跨环境切域名的标准姿势), 暂无 UI 入口; 真到跨环境重放需求
//                 出现时在导出页加输入框(届时可升级为"覆盖 HOST_1 值"语义)。
function buildJmx(entries, opts = {}) {
  // threads 默认 1(巡检安全口径: 单线程顺序跑一遍): 导出脚本的主用途是生产巡检,
  // 10 并发默认对生产是事故级压力。压测 -Jthreads=10 一参数即覆盖; 反向不成立 ——
  // 巡检用户不知道 -J 参数时, 10 并发默认直接打爆生产。
  const threads = opts.threads || "${__P(threads,1)}";
  const rampup = opts.rampup || "${__P(rampup,10)}";
  const loops = opts.loops || "${__P(loops,1)}";
  const think = opts.think ?? "${__P(think,500)}";
  const preludeIds = opts.prelude ? new Set(opts.prelude) : null;
  const autoRelogin = !!opts.autoRelogin;
  const sessionMarkers = Array.isArray(opts.sessionMarkers) ? opts.sessionMarkers : [];
  const first = entries[0];
  if (!first) throw new Error("没有已录请求");
  const u = new URL(first.url);
  // 主机变量化(v1.0.79): 唯一 hostname 按首现序编号 HOST_1/HOST_2..., 采样器 domain 一律
  // 引用 ${HOST_n}, UDF 值=录制 hostname —— 跨环境(UAT→PROD)只改 UDF 值, 不逐采样器手改。
  // 与手写 KTKI UAT.jmx 的 BASE_URL/LOGIN_URL 同款姿势(29 采样器全走 ${BASE_URL});
  // 通用化不能业务具名(主机名从录制条目派生, 谁是"BASE"不可知), 只能自动编号。
  // 单主机也变量化: 环境切换价值不因单域消失, 且行为一致(见 samples loader readJmx
  // 的变量分支 —— domain 变量形态回读需走相对路径解析, 两面同改)。
  const hostMap = new Map(); // hostname -> HOST_n(首现序)
  for (const e of entries) {
    const h = new URL(e.url).hostname;
    if (!hostMap.has(h)) hostMap.set(h, "HOST_" + (hostMap.size + 1));
  }
  const hostRef = (e) => "${" + hostMap.get(new URL(e.url).hostname) + "}";
  const domain = opts.domainOverride || "${" + hostMap.get(u.hostname) + "}";
  const title = opts.title || `web-toolbox 录制 ${new Date().toISOString().slice(0, 10)}`;
  // CSV 数据驱动列(v1.0.82): collectCsvData 产出 [{var, default}]。空则不生成 CSVDataSet。
  const csvData = Array.isArray(opts.csvData) ? opts.csvData : [];
  const csvFileName = opts.csvFileName || ("data_" + new Date().toISOString().slice(0, 10).replace(/-/g, "") + ".csv");
  // 变量覆盖检查: 链变量若与主机变量/保留 UDF 撞名, JMeter 会互相覆盖(CVS 列 vs 采样器引用错位)。
  // 保守跳过冲突列(宁可不数据驱动, 也不生成名字冲突的脚本)。HOST_n 由 hostMap 自动编号,
  // 链变量由 pathToVar/linkSeqDynamics 的 V_ 前缀生成 —— 实际冲突面极小, 防御性检查。
  const reserved = new Set([...hostMap.values(), "threads", "rampup", "loops", "think", "csvPath", "csvFile"]);
  const csvCols = csvData.filter((c) => !reserved.has(c.var) && c.var && !/^\d/.test(c.var));

  // 每条独立域名(录制可能跨域), 域名归属前置/业务各取第一条
  const used = new Set();
  for (const e of entries) e._samplerName = samplerName(e, used);
  const isPre = (e) => preludeIds && preludeIds.has(e.id);
  const preEntries = entries.filter(isPre);
  const bizEntries = entries.filter((e) => !isPre(e));
  // 域名一律 ${HOST_n} 变量引用(v1.0.79): 跨域各走各的变量, 环境切换改 UDF 值即可
  // (定义前置: setUp 线程组块在 TestPlan 组件段就调用它)
  const samplerXml = (list) => list.map((e) => {
    const eu = new URL(e.url);
    return httpSampler(e, { domain: hostRef(e), protocol: eu.protocol.replace(":", "") });
  }).join("\n");
  const body = [];
  body.push('<?xml version="1.0" encoding="UTF-8"?>');
  body.push('<jmeterTestPlan version="1.2" properties="5.0" jmeter="5.6.3">');
  body.push("<hashTree>");
  // ---- TestPlan ----
  body.push(`<TestPlan guiclass="TestPlanGui" testclass="TestPlan" testname="${xmlEsc(title)}" enabled="true">`);
  body.push('<boolProp name="TestPlan.functional_mode">false</boolProp>');
  body.push('<boolProp name="TestPlan.serialize_threadgroups">false</boolProp>');
  body.push('<boolProp name="TestPlan.tearDown_on_shutdown">true</boolProp>');
  body.push('<stringProp name="TestPlan.comments">由 web-toolbox 扩展导出。运行: jmeter -Jthreads=1 -Jloops=1 -Jthink=500 -n -t this.jmx (默认单线程巡检; 压测: -Jthreads=10 -Jrampup=10; think=0 关闭思考时间, 拉满压测)</stringProp>');
  body.push('<stringProp name="TestPlan.user_define_classpath"/>');
  // UDF: threads/loops/rampup/think(命令行 -J 可覆盖)
  body.push('<elementProp name="TestPlan.user_defined_variables" elementType="Arguments" guiclass="ArgumentsPanel" testclass="Arguments" testname="用户定义的文本变量" enabled="true">');
  body.push('<collectionProp name="Arguments.arguments">');
  const udf = (k, v) => `<elementProp name="${k}" elementType="Argument"><stringProp name="Argument.name">${k}</stringProp><stringProp name="Argument.value">${v}</stringProp><stringProp name="Argument.metadata">=</stringProp></elementProp>`;
  body.push(udf("threads", "${__P(threads,1)}"));
  body.push(udf("rampup", "${__P(rampup,10)}"));
  body.push(udf("loops", "${__P(loops,1)}"));
  body.push(udf("think", "${__P(think,500)}"));
  // 主机变量(v1.0.79): 值=录制 hostname, __P 形态与 threads/rampup/loops/think 统一
  // —— 跨环境(UAT→PROD)三种切法: 改 UDF 值(GUI/文件) / -JHOST_1=prod.midea.com 命令行
  // 覆盖(__P 的价值, 不改文件) / JMeter GUI 直接改。hostname 无逗号, __P 默认值安全。
  for (const [h, varName] of hostMap) body.push(udf(varName, "${__P(" + varName + "," + xmlEsc(h) + ")}"));
  // CSV 数据驱动(v1.0.82): csvPath/csvFile 两 UDF 供 CSVDataSet 引用 —— 用户改文件路径
  // 只动 UDF(或 -JcsvPath=../data/), 不逐采样器找。csvFile 默认走导出时生成的文件名。
  if (csvData && csvData.length) {
    body.push(udf("csvPath", "${__P(csvPath,)}"));
    body.push(udf("csvFile", "${__P(csvFile," + xmlEsc(csvFileName) + ")}"));
    // 每列 UDF 兜底(CSV 缺失/超行尾时变量仍可解析): 值为录制值, 与 CSV 首行数据同形。
    // JMeter CSVDataSet 在循环内逐行覆盖同名字段 —— UDF 兜底只在 CSV 没读到该行时生效。
    for (const col of csvData) body.push(udf(col.var, "${__P(" + col.var + "," + xmlEsc(col.default) + ")}"));
  }
  body.push("</collectionProp>");
  body.push("</elementProp></TestPlan>");
  body.push("<hashTree>");
  // ---- HTTP 默认值 ----
  body.push('<ConfigTestElement guiclass="HttpDefaultsGui" testclass="ConfigTestElement" testname="HTTP请求默认值" enabled="true">');
  body.push('<elementProp name="HTTPsampler.Arguments" elementType="Arguments" guiclass="HTTPArgumentsPanel" testclass="Arguments" testname="用户定义的文本变量" enabled="true"><collectionProp name="Arguments.arguments"/></elementProp>');
  body.push(`<stringProp name="HTTPSampler.domain">${xmlEsc(domain)}</stringProp>`);
  body.push("<stringProp name=\"HTTPSampler.port\"/>");
  body.push(`<stringProp name="HTTPSampler.protocol">${u.protocol.replace(":", "")}</stringProp>`);
  body.push('<stringProp name="HTTPSampler.contentEncoding">utf-8</stringProp>');
  body.push("<stringProp name=\"HTTPSampler.path\"/>");
  body.push('<stringProp name="HTTPSampler.concurrentPool">6</stringProp>');
  body.push("<stringProp name=\"HTTPSampler.connect_timeout\"/><stringProp name=\"HTTPSampler.response_timeout\"/>");
  body.push("</ConfigTestElement>");
  body.push("<hashTree/>");
  // ---- CookieManager ----
  body.push('<CookieManager guiclass="CookiePanel" testclass="CookieManager" testname="HTTP Cookie Manager" enabled="true">');
  body.push('<collectionProp name="CookieManager.cookies"/>');
  body.push('<boolProp name="CookieManager.clearEachIteration">false</boolProp>');
  body.push('<boolProp name="CookieManager.controlledByThreadGroup">false</boolProp>');
  body.push("</CookieManager>");
  body.push("<hashTree/>");
  // ---- setUp 线程组(登录全局一次, v1.0.91): JMeter 保证 setUp 组先于主线程组跑完 ----
  // autoRelogin 与 setup 互斥(setUp 线程组跑完即结束, 无法失效重登), setup 优先。
  const setupLogin = preEntries.length > 0 && opts.loginMode === "setup";
  if (setupLogin) {
    const pre = samplerXml(preEntries);
    // 共享 JSR223 插进最后一个前置采样器的 hashTree(PostProcessor 须是采样器子节点才执行)
    const lastHt = pre.lastIndexOf("</hashTree>");
    const preShared = lastHt >= 0 ? pre.slice(0, lastHt) + jsr223ShareState(csvCols.map((c) => c.var)) + pre.slice(lastHt) : pre;
    body.push(setupThreadGroup());
    body.push("<hashTree>");
    body.push(tcSummary("登录前置条件", preShared));
    body.push("</hashTree>");
  }
  // ---- ThreadGroup ----
  body.push('<ThreadGroup guiclass="ThreadGroupGui" testclass="ThreadGroup" testname="web-toolbox 回放" enabled="true">');
  body.push(`<stringProp name="ThreadGroup.on_sample_error">${opts.onSampleError || "continue"}</stringProp>`);
  body.push('<elementProp name="ThreadGroup.main_controller" elementType="LoopController" guiclass="LoopControlPanel" testclass="LoopController" testname="Loop Controller" enabled="true">');
  body.push('<boolProp name="LoopController.continue_forever">false</boolProp>');
  body.push(`<stringProp name="LoopController.loops">${loops}</stringProp>`);
  body.push("</elementProp>");
  body.push(`<stringProp name="ThreadGroup.num_threads">${threads}</stringProp>`);
  body.push(`<stringProp name="ThreadGroup.ramp_time">${rampup}</stringProp>`);
  body.push('<boolProp name="ThreadGroup.scheduler">false</boolProp>');
  body.push('<stringProp name="ThreadGroup.duration"/><stringProp name="ThreadGroup.delay"/>');
  body.push('<boolProp name="ThreadGroup.same_user_on_next_iteration">true</boolProp>');
  body.push("</ThreadGroup>");
  body.push("<hashTree>");
  // setUp 模式: 主线程组头部统一注入共享 Cookie(业务采样器全部带 setUp 会话)
  if (setupLogin && bizEntries.length) body.push(sharedCookieHeader());
  // ---- 采样器 ----
  // CSV 数据驱动(v1.0.82): 勾选「数据驱动」导出时在 ThreadGroup 内(采样器前)放 CSVDataSet。
  // 对齐 KTKI 手写 CSVDataSet 结构(delimiter/ignoreFirstLine/quotedData/recycle/shareMode)。
  // 引用 ${csvPath}${csvFile}(TestPlan UDF) —— 文件路径只改 UDF 或 -JcsvPath=../data/。
  // CSV 首行表头, 首行数据=录制值; JMeter 每循环逐行覆盖变量, 循环>行数时按 recycle 回绕。
  if (csvCols.length) {
    body.push('<CSVDataSet guiclass="TestBeanGUI" testclass="CSVDataSet" testname="CSV 数据文件设置" enabled="true">');
    body.push('<stringProp name="delimiter">,</stringProp>');
    body.push('<stringProp name="fileEncoding">UTF-8</stringProp>');
    body.push('<stringProp name="filename">${csvPath}${csvFile}</stringProp>');
    body.push('<boolProp name="ignoreFirstLine">true</boolProp>');
    body.push('<boolProp name="quotedData">true</boolProp>');
    body.push('<boolProp name="recycle">true</boolProp>');
    body.push('<stringProp name="shareMode">shareMode.all</stringProp>');
    body.push('<boolProp name="stopThread">false</boolProp>');
    body.push(`<stringProp name="variableNames">${csvCols.map((c) => c.var).join(",")}</stringProp>`);
    body.push("</CSVDataSet>");
    body.push("<hashTree/>");
  }

  if (preEntries.length) {
    if (setupLogin) {
      // setUp 模式: 前置链已在 SetupThreadGroup 生成(登录全局只 1 次), 主组只放业务链
      if (bizEntries.length) body.push(samplerXml(bizEntries));
    } else if (autoRelogin) {
      // 会话失效自动重登: 前置链 + 业务链 分别进 IfController
      body.push(reloginBlock(samplerXml(preEntries), samplerXml(bizEntries), sessionMarkers));
    } else {
      // 登录前置包 OnceOnly(每线程只执行一次) + 聚合事务「登录前置条件」
      body.push(onceOnly(tcSummary("登录前置条件", samplerXml(preEntries))));
      if (bizEntries.length) body.push(samplerXml(bizEntries));
    }
  } else {
    body.push(samplerXml(entries));
  }
  // ---- 思考时间(每轮循环末尾停 think 毫秒) ----
  // 权威生成器同款: 防"全链路无间隔"瞬间打爆 UAT; -Jthink=0 可关。
  body.push('<ConstantTimer guiclass="ConstantTimerGui" testclass="ConstantTimer" testname="思考时间" enabled="true">');
  body.push(`<stringProp name="ConstantTimer.delay">${think}</stringProp>`);
  body.push("</ConstantTimer>");
  body.push("<hashTree/>");
  body.push("</hashTree>"); // ThreadGroup
  // ---- View Results Tree(v1.0.85): 察看结果树, GUI 模式调试看每个请求详情(请求/响应/断言) ----
  // 非GUI(-n -t)下自动忽略不报错; GUI 下是定位失败采样器的核心工具。
  // M2(v1.0.86): 开启 responseData/requestHeaders/responseHeaders — 巡检定位失败必须看响应体
  body.push('<ResultCollector guiclass="ViewResultsFullVisualizer" testclass="ResultCollector" testname="察看结果树" enabled="true">');
  body.push('<boolProp name="ResultCollector.error_logging">false</boolProp>');
  body.push(saveConfigXml({ responseData: true, requestHeaders: true, responseHeaders: true }));
  body.push('<stringProp name="filename"/>');
  body.push('</ResultCollector>');
  body.push('<hashTree/>');
  // ---- Summary Report(v1.0.83): 导出即带, 运行后直接看汇总 ----
  body.push('<ResultCollector guiclass="SummaryReport" testclass="ResultCollector" testname="Summary Report" enabled="true">');
  body.push('<boolProp name="ResultCollector.error_logging">false</boolProp>');
  body.push(saveConfigXml());
  body.push('<stringProp name="filename"/>');
  body.push('</ResultCollector>');
  body.push('<hashTree/>');
  // ---- ResultCollector(.jtl)(v1.0.83): 结果落盘, 供 Jenkins/定时任务解析预警 ----
  body.push('<ResultCollector guiclass="SimpleDataWriter" testclass="ResultCollector" testname="结果写入jtl" enabled="true">');
  body.push('<boolProp name="ResultCollector.error_logging">false</boolProp>');
  body.push(saveConfigXml());
  body.push('<stringProp name="filename">result.jtl</stringProp>');
  body.push('</ResultCollector>');
  body.push('<hashTree/>');
  body.push("</hashTree>"); // TestPlan
  body.push("</hashTree>"); // root
  body.push("</jmeterTestPlan>");
  return body.join("\n");
}

// CSV 模板文本(v1.0.82): 表头 + 首行录制值(用户补多行即多数据驱动)。
// 逗号/换行在录制值里会撑破 CSV 列 —— 双引号包裹转义(JMeter quotedData=true 解析)。
// 与 buildJmx 的 csvData 列顺序/命名严格一致(同一份 [{var, default}] 喂两边)。
function csvTemplateText(csvData) {
  const escCsv = (s) => {
    const t = String(s ?? "");
    return /[",\n\r]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
  };
  const cols = Array.isArray(csvData) ? csvData.filter((c) => c && c.var) : [];
  if (!cols.length) return "";
  return cols.map((c) => c.var).join(",") + "\n" + cols.map((c) => escCsv(c.default)).join(",") + "\n";
}

// node 环境导出(供单测; 浏览器 script 标签加载时此分支不执行)
if (typeof module !== "undefined" && module.exports) {
  module.exports = { buildJmx, httpSampler, xmlEsc, onceOnly, tcSummary, csvTemplateText };
}
