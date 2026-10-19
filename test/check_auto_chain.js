// check_auto_chain.js —— 轻量自动关联检测走查(v1.0.84, v1.0.96 扩充)。
// autoDetectChain 不依赖 AI, 用规则扫描: from 响应叶子字段值出现在 to 请求 body/url → 生成 chain。
// v1.0.96: 纯数字单号(>=8 位)/裸值 JSON/表单体 k=v 三形态纳入检测; 链携带 value 快照
// 供下游值锚定替换; mergeChain 键归一 body. 前缀(corr 链与轻量链同关联去重)。
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

// --- 场景2: 黑名单/短值/短纯数字不匹配 ---
const entries2 = [
  mk("a0", "POST", "https://host/api/login", { response: '{"resultCode":"ISC-000","ok":true,"code":"1"}' }),
  mk("a1", "POST", "https://host/api/use", { body: '{"resultCode":"ISC-000","ok":"true","code":"1"}' }),
];
const chain2 = autoDetectChain(entries2);
assert(chain2.length === 0, `黑名单/短值/短纯数字不匹配(实得 ${chain2.length} 条)`);

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

// --- 场景14: 大响应建链上限对齐 + 超长叶子值防御(v1.0.96) ---
// 检测上限与录制截断(200KB)对齐 —— 100~200KB 大查询响应此前录了但静默不链;
// 超长叶子值(>500 字符, base64/大文本)不入链: 无业务关联意义, 且进正则会触发
// V8 编译上限直接抛错(150KB 值实测炸穿管线)。
const midResp = '{"d":{"v":"CHAIN-VALUE-OK","pad":"' + "x".repeat(150000) + '"}}';
const midEntries = [
  mk("mg0", "POST", "https://host/api/mid", { response: midResp }),
  mk("mg1", "POST", "https://host/api/use", { body: '{"v":"CHAIN-VALUE-OK","pad":"' + "x".repeat(150000) + '"}' }),
];
const midChain = autoDetectChain(midEntries);
assert(midChain.length >= 1, `150KB response 正常建链(上限对齐录制截断, 实得 ${midChain.length})`);
assert(midChain.every((c) => !c.fromJsonPath.includes("pad")), "超长叶子值(pad 150KB)不入链(防 V8 正则上限)");
const hugeResp = '{"d":{"v":"' + "x".repeat(200001) + '"}}';
const hugeEntries = [
  mk("hg0", "POST", "https://host/api/huge", { response: hugeResp }),
  mk("hg1", "POST", "https://host/api/use", { body: '{"v":"' + "x".repeat(200001) + '"}' }),
];
const hugeChain = autoDetectChain(hugeEntries);
assert(hugeChain.length === 0, `超大 response(>200KB) 跳过(实得 ${hugeChain.length})`);

// --- 场景15: 纯数字单号建链(v1.0.96: >=8 位纯数字放行, 与 correlate 单号识别同口径) ---
// 65 开头 13 位单号: 数字类型响应叶子 + 裸值 body(无引号) —— 此前双重建不上。
const numEntries = [
  mk("o0", "POST", "https://host/order/create", { response: '{"resultCode":"0","data":{"orderNo":6512345678901}}' }),
  mk("o1", "POST", "https://host/order/submit", { body: '{"orderNo":6512345678901}' }),
];
const numChain = autoDetectChain(numEntries);
assert(numChain.length >= 1, `纯数字单号(65 开头 13 位)检测到关联(实得 ${numChain.length})`);
const numLink = numChain.find((c) => c.toParam === "body.orderNo");
assert(!!numLink, "裸值 body 的 orderNo 建链(无引号形态)");
assert(numLink && numLink.value === "6512345678901", "链携带录制值 value(供值锚定替换): " + numLink?.value);

// --- 场景16: 表单体 k=v 建链(v1.0.96: 检测端补表单扫描, 与替换端表单分支对齐) ---
const formEntries = [
  mk("f0", "POST", "https://host/api/login", { response: '{"data":{"token":"tok-abc-123-xyz"}}' }),
  mk("f1", "POST", "https://host/api/submit", { body: "token=tok-abc-123-xyz&page=1" }),
];
const formChain = autoDetectChain(formEntries);
const formLink = formChain.find((c) => c.toParam === "body.token");
assert(!!formLink, `表单体 k=v 关联检测到(实得 ${formChain.length}): ` + JSON.stringify(formChain.map((c) => c.toParam)));

// --- 场景17: 短纯数字仍不建链(页码/计数类噪音, <8 位) ---
const shortEntries = [
  mk("p0", "GET", "https://host/api/list", { response: '{"data":{"total":123456,"flag":"1"}}' }),
  mk("p1", "GET", "https://host/api/page", { body: '{"total":123456}' }),
];
assert(autoDetectChain(shortEntries).length === 0, "6 位计数类数字不建链(长度阈值挡住)");

// --- 场景18: mergeChain 键归一(v1.0.96): corr 链裸叶名与轻量链 body.前缀同关联去重 ---
const corrLike = [{ from: 0, fromId: "a", fromJsonPath: "data.x", to: 1, toId: "b", toParam: "x", var: "V_x" }];
const autoLike = [{ from: 0, fromId: "a", fromJsonPath: "data.x", to: 1, toId: "b", toParam: "body.x", var: "V_x" }];
const dedupMerged = mergeChain(autoLike, corrLike);
assert(dedupMerged.length === 1, `同关联不同 toParam 写法(x vs body.x)去重(实得 ${dedupMerged.length})`);

// --- 场景19: 值锚定替换(v1.0.96): 同名异值字段, 链 value 精确定位不换错位 ---
const anchorEntries = [
  mk("an0", "POST", "https://host/api/create", { response: '{"data":{"id":"ID-AAA"}}' }),
  mk("an1", "POST", "https://host/api/use", { body: '{"item":{"id":"ID-BBB"},"ref":{"id":"ID-AAA"}}' }),
];
const anchorChain = autoDetectChain(anchorEntries);
assert(anchorChain.length === 1, `同名异值 id 只链录制值命中的那处(实得 ${anchorChain.length})`);
const anchored = applyAiChainToJmx(anchorEntries.map((e) => ({ ...e })), anchorChain);
assert(anchored[1].body.includes('"id":"ID-BBB"'), "未关联的同名字段保持原值: " + anchored[1].body);
assert(anchored[1].body.includes("${" + anchorChain[0].var + "}"), "录制值命中的那处被参数化(值锚定)");

console.log("\n=== 轻量自动关联检测 PASS ===");