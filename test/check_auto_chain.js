// check_auto_chain.js —— 轻量自动关联检测走查(v1.0.84)。
// autoDetectChain 不依赖 AI, 用规则扫描: from 响应叶子字段值出现在 to 请求 body/url → 生成 chain。
// mergeChain 合并轻量链和 AI 链(AI 优先, 轻量补充)。
// 端到端: autoDetectChain → mergeChain → applyAiChainToJmx → buildJmx → JMX 含 JSONPostProcessor + CSVDataSet。
// 核心场景: AI 不可用(aiChain=null/[])时, 轻量检测仍能产出关联。
const { autoDetectChain, mergeChain, applyAiChainToJmx, collectCsvData, filterSkippable } = require("../common.js");
const { buildJmx, csvTemplateText } = require("../jmx.js");
const assert = (cond, msg) => { if (!cond) { console.log("FAIL: " + msg); process.exit(1); } console.log("  OK " + msg); };

const mk = (id, method, url, extra) => Object.assign({ id, method, url, path: new URL(url).pathname, query: "", headers: {}, body: "", status: 200, mime: "application/json", response: "{}", ts: "2026-10-16T10:00:00Z" }, extra);

// --- 场景1: 基本关联检测 ---
// 接口0 响应含 orderNo=ORD20260001, 接口1 请求 body 含 "orderNo":"ORD20260001" → 检测到关联
const entries = [
  mk("e0", "POST", "https://host/web/iservice-order/create", {
    body: '{"customerCode":"C001"}',
    response: '{"resultCode":"ISC-000","data":{"orderNo":"ORD20260001","orderId":"ORD-XYZ-123"}}',
  }),
  mk("e1", "POST", "https://host/web/iservice-spareparts/query", {
    body: '{"orderNo":"ORD20260001","page":1}',
    response: '{"resultCode":"ISC-000","data":{"parts":[{"partNo":"P1"}]}}',
  }),
];

const chain = autoDetectChain(entries);
assert(chain.length >= 1, `检测到至少 1 条关联(实得 ${chain.length})`);
const link = chain.find((c) => c.toParam === "body.orderNo");
assert(!!link, "存在 toParam=body.orderNo 的关联");
assert(link.fromId === "e0" && link.toId === "e1", "from=e0, to=e1");
assert(link.fromJsonPath.includes("orderNo"), "fromJsonPath 含 orderNo: " + link.fromJsonPath);
assert(link.var.startsWith("V_"), "变量名 V_ 前缀: " + link.var);

// --- 场景2: 黑名单/短值/纯数字不匹配 ---
const entries2 = [
  mk("a0", "POST", "https://host/api/login", { response: '{"resultCode":"ISC-000","ok":true,"code":"1"}' }),
  mk("a1", "POST", "https://host/api/use", { body: '{"resultCode":"ISC-000","ok":"true","code":"1"}' }),
];
const chain2 = autoDetectChain(entries2);
assert(chain2.length === 0, `黑名单/短值/纯数字不匹配(实得 ${chain2.length} 条)`);

// --- 场景3: URL query 参数关联 ---
const entries3 = [
  mk("u0", "GET", "https://host/api/create", { response: '{"data":{"token":"tok-abc-123-xyz"}}' }),
  mk("u1", "GET", "https://host/api/list", { query: "token=tok-abc-123-xyz&page=1" }),
];
const chain3 = autoDetectChain(entries3);
const urlLink = chain3.find((c) => c.toParam === "url.token");
assert(!!urlLink, "URL query 参数关联检测到: " + JSON.stringify(chain3.map((c) => c.toParam)));

// --- 场景4: mergeChain AI 优先, 轻量补充 ---
const autoChain = [
  { from: 0, fromId: "a", fromJsonPath: "data.x", to: 1, toId: "b", toParam: "body.x", var: "V_x" },
  { from: 0, fromId: "a", fromJsonPath: "data.y", to: 1, toId: "b", toParam: "body.y", var: "V_y" },
];
const aiChain = [
  { from: 0, fromId: "a", fromJsonPath: "data.x", to: 1, toId: "b", toParam: "body.x", var: "AI_x" },
];
const merged = mergeChain(autoChain, aiChain);
assert(merged.length === 2, `合并后 2 条(AI 1 + 轻量补充 1, 实得 ${merged.length})`);
const aiOne = merged.find((c) => c.toParam === "body.x");
assert(aiOne.var === "AI_x", "AI 链优先(body.x 用 AI 的变量名)");
const autoOne = merged.find((c) => c.toParam === "body.y");
assert(autoOne.var === "V_y", "轻量链补充 AI 没有的(body.y)");

// --- 场景5: AI 不可用时轻量链独立工作 ---
const mergedNoAi = mergeChain(autoChain, null);
assert(mergedNoAi.length === 2, "AI=null 时轻量链独立: 2 条");
const mergedEmptyAi = mergeChain(autoChain, []);
assert(mergedEmptyAi.length === 2, "AI=[] 时轻量链独立: 2 条");

// --- 场景6: 端到端 — AI 不可用, 轻量检测 → JMX 含 JSONPostProcessor + CSV ---
// 用场景1的 entries, aiChain=null(模拟 AI 未配置)
const cleanEntries = filterSkippable(entries).entries;
const autoOnly = autoDetectChain(cleanEntries);
const mergedChain = mergeChain(autoOnly, null); // AI 不可用
const csvData = collectCsvData(cleanEntries, mergedChain);
assert(csvData.length >= 1, `CSV 数据驱动列 >= 1(实得 ${csvData.length}): ` + JSON.stringify(csvData));
const jmxApplied = applyAiChainToJmx(cleanEntries.map((e) => ({ ...e })), mergedChain);
const jmx = buildJmx(jmxApplied, { csvData, csvFileName: "data_test.csv" });
// JSONPostProcessor
assert(jmx.includes("<JSONPostProcessor "), "JMX 含 JSONPostProcessor(轻量检测产出)");
assert(jmx.includes("$.data.orderNo"), "JSONPostProcessor 路径 $.data.orderNo: " + jmx.match(/jsonPathExprs[^<]*<stringProp[^>]*>([^<]*)/)?.[1]);
// CSVDataSet
assert(jmx.includes("<CSVDataSet "), "JMX 含 CSVDataSet(轻量检测产出数据驱动)");
assert(jmx.includes("data_test.csv"), "CSV 文件名 data_test.csv");
// body 替换为 ${var}
assert(jmx.includes("${V_orderNo}"), "JMX body 中 orderNo 替换为 ${V_orderNo}");
// CSV 模板
const csvText = csvTemplateText(csvData);
assert(csvText.includes("V_orderNo"), "CSV 模板表头含 V_orderNo: " + csvText.trim());
assert(csvText.includes("ORD20260001"), "CSV 模板首行含录制值 ORD20260001");

// --- 场景7: 无关联时不出产(不误加) ---
const noRel = [
  mk("n0", "GET", "https://host/api/a", { response: '{"data":{"name":"alpha-beta-gamma"}}' }),
  mk("n1", "GET", "https://host/api/b", { body: '{"different":"zzz-www-xxx"}' }),
];
const noChain = autoDetectChain(noRel);
assert(noChain.length === 0, `无关联时 0 条(不误加, 实得 ${noChain.length})`);

// --- 场景8: 嵌套 JSON 路径正确 ---
const nested = [
  mk("d0", "POST", "https://host/api/deep", { response: '{"result":{"data":{"list":[{"id":"DEEP-ID-999"}]}}}' }),
  mk("d1", "POST", "https://host/api/use", { body: '{"id":"DEEP-ID-999"}' }),
];
const nestedChain = autoDetectChain(nested);
const deepLink = nestedChain.find((c) => c.toParam === "body.id");
assert(!!deepLink, "嵌套 JSON 关联检测到");
assert(deepLink && deepLink.fromJsonPath.includes("list"), "嵌套路径含 list: " + deepLink?.fromJsonPath);

// --- 场景9: 大集不设硬上限 ---
// autoDetectChain 是 O(n²), 但不截断 —— 超 200 条也正常计算(用户自行控制集大小)。
const big = [];
for (let i = 0; i < 300; i++) big.push(mk("b" + i, "GET", "https://host/api/b" + i, { response: '{"d":{"v":"val-xxxx"}}' }));
const bigChain = autoDetectChain(big);
assert(Array.isArray(bigChain), `300 条不截断, 返回数组(实得 ${typeof bigChain})`);

// --- 场景10: 边界 case — 空entries / 单条目 / 非JSON response ---
assert(autoDetectChain([]).length === 0, "空 entries 返回 []");
assert(autoDetectChain([mk("s0", "GET", "https://host/api/x", {})]).length === 0, "单条目返回 []");
// 非 JSON response(XML) — H6 正则提取 <tag>value</tag>
const xmlEntries = [
  mk("x0", "POST", "https://host/api/xml", { response: '<root><orderId>XML-ORD-12345</orderId></root>' }),
  mk("x1", "POST", "https://host/api/use", { body: '{"orderId":"XML-ORD-12345"}' }),
];
const xmlChain = autoDetectChain(xmlEntries);
assert(xmlChain.length >= 1, `XML 响应正则提取检测到关联(实得 ${xmlChain.length})`);

// --- 场景11: header 关联(H5) ---
const hdrEntries = [
  mk("h0", "POST", "https://host/api/login", { response: '{"data":{"token":"tok-xyz-abc-001"}}' }),
  mk("h1", "GET", "https://host/api/data", { headers: { "X-Token": "tok-xyz-abc-001" } }),
];
const hdrChain = autoDetectChain(hdrEntries);
const hdrLink = hdrChain.find((c) => c.toParam === "header.X-Token");
assert(!!hdrLink, `header 关联检测到(实得 ${hdrChain.length} 条): ` + JSON.stringify(hdrChain.map((c) => c.toParam)));

// --- 场景12: mergeChain 变量名冲突重命名(H4) ---
const conflictAuto = [
  { from: 0, fromId: "a", fromJsonPath: "data.x", to: 1, toId: "b", toParam: "body.x", var: "V_orderNo" },
];
const conflictAi = [
  { from: 0, fromId: "a", fromJsonPath: "data.y", to: 1, toId: "b", toParam: "body.y", var: "V_orderNo" },
];
const conflictMerged = mergeChain(conflictAuto, conflictAi);
const autoVar = conflictMerged.find((c) => c.toParam === "body.x");
const aiVar = conflictMerged.find((c) => c.toParam === "body.y");
assert(aiVar && aiVar.var === "V_orderNo", "AI 链变量名保留原样");
assert(autoVar && autoVar.var === "V_orderNo_auto", "轻量链同名变量加 _auto 后缀: " + autoVar?.var);

// --- 场景13: 中文值关联 ---
const cnEntries = [
  mk("c0", "POST", "https://host/api/cn", { response: '{"data":{"name":"北京分公司"}}' }),
  mk("c1", "POST", "https://host/api/use", { body: '{"branch":"北京分公司"}' }),
];
const cnChain = autoDetectChain(cnEntries);
assert(cnChain.length >= 1, `中文值关联检测到(实得 ${cnChain.length}): ` + JSON.stringify(cnChain.map((c) => c.var)));

// --- 场景14: 超大 response 跳过(M5) ---
const hugeResp = '{"d":{"v":"' + "x".repeat(100001) + '"}}';
const hugeEntries = [
  mk("hg0", "POST", "https://host/api/huge", { response: hugeResp }),
  mk("hg1", "POST", "https://host/api/use", { body: '{"v":"' + "x".repeat(100001) + '"}' }),
];
const hugeChain = autoDetectChain(hugeEntries);
assert(hugeChain.length === 0, `超大 response(>100KB) 跳过(实得 ${hugeChain.length})`);

console.log("\n=== 轻量自动关联检测 PASS ===");