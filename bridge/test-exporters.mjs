// bridge/test-exporters.mjs —— 导出口径单测(不连浏览器) + 单源证明。
//
// 三件事:
//   1. 口径: HAR 保真(不剔除, 含静态资源与 0 状态) vs JMX/PY 压测口径(先剔除静态资源/预检/SSE);
//   2. 形态: HAR 必带 1.2 骨架与 time/status; JMX 线程参数可被 opts.threads 覆盖; PY 有 def step_;
//   3. 单源: 猴补扩展模块导出(buildJmx/buildPyScript/buildHar)后 bridge 侧输出必须立刻变 ——
//      证明 bridge 加载的就是扩展那份源码, 不是复制品(复制品改不动)。
// 用法: node bridge/test-exporters.mjs(wbridge/ 需 npm install)

import assert from "node:assert";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as EX from "./src/exporters.js";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = path.resolve(here, "..");

let pass = 0, fail = 0;
const ok = (name, cond, got) => {
  if (cond) { pass++; console.log("  OK " + name); }
  else { fail++; console.log("  ✗ FAIL " + name + " → " + JSON.stringify(got)); }
};

// ---- 样本 ----
const api = [
  { id: "a1", method: "POST", path: "/login", query: "", url: "https://h.test/login", headers: { "Content-Type": "application/json" }, body: '{"u":"x","nonce":111}', status: 200, response: '{"token":"T1"}', mime: "application/json", ts: "2026-11-23T00:00:00Z", durationMs: 123 },
  { id: "a2", method: "POST", path: "/login", query: "", url: "https://h.test/login", headers: { "Content-Type": "application/json" }, body: '{"u":"x","nonce":222}', status: 200, response: '{"token":"T2"}', mime: "application/json", ts: "2026-11-23T00:00:01Z", durationMs: 45 },
  { id: "a3", method: "GET", path: "/list", query: "page=1", url: "https://h.test/list?page=1", headers: {}, body: "", status: 0, response: "", mime: "", ts: "", durationMs: undefined },
];
const noise = [
  { id: "n1", method: "GET", path: "/a.css", query: "", url: "https://h.test/a.css", headers: {}, body: "", status: 200, response: "body{}", mime: "text/css", ts: "" },
  { id: "n2", method: "OPTIONS", path: "/login", query: "", url: "https://h.test/login", headers: {}, body: "", status: 204, response: "", mime: "", ts: "" },
  { id: "n3", method: "GET", path: "/sse", query: "", url: "https://h.test/sse", headers: {}, body: "", status: 200, response: "data: 1", mime: "text/event-stream", ts: "" },
];

// ============================================================ pick
{
  console.log("\n[pick] 导出集圈定");
  ok("不给 ids → 全量", EX.pick(api).length === api.length, EX.pick(api).length);
  ok("空 ids 数组 → 全量", EX.pick(api, []).length === api.length, EX.pick(api, []).length);
  const sub = EX.pick(api, ["a2", "zzz"]);
  ok("按 id 过滤(未知 id 忽略)", sub.length === 1 && sub[0].id === "a2", sub.map((e) => e.id));
  const before = api.map((e) => e.id).join();
  EX.pick(api, ["a1"]);
  ok("pick 不改原数组", api.map((e) => e.id).join() === before, api.map((e) => e.id));
}

// ============================================================ HAR: 保真口径
{
  console.log("\n[HAR] 保真口径(不剔除静态/预检/SSE)");
  const all = [...api, ...noise];
  const har = JSON.parse(EX.buildHarText(all));
  ok("HAR 1.2 骨架", har.log.version === "1.2" && har.log.creator && Array.isArray(har.log.entries), Object.keys(har.log));
  ok("HAR 条数与输入一致(保真, 不剔除)", har.log.entries.length === all.length, har.log.entries.length);
  const e1 = har.log.entries[0];
  ok("HAR request.method/url 原样", e1.request.method === "POST" && e1.request.url === "https://h.test/login", e1.request);
  ok("HAR time 用 durationMs", e1.time === 123, e1.time);
  ok("HAR 缺 durationMs → time = -1(未知)", har.log.entries[2].time === -1, har.log.entries[2].time);
  ok("HAR status=0 原样保留(错误态不失真)", har.log.entries[2].response.status === 0, har.log.entries[2].response.status);
  const cssRow = har.log.entries.find((e) => e.request.url.endsWith("/a.css"));
  ok("HAR 含静态资源条目", !!cssRow, "缺 a.css");
}

// ============================================================ JMX: 压测口径
{
  console.log("\n[JMX] 压测口径(剔除静态/预检/SSE)");
  const all = [...api, ...noise];
  const xml = EX.buildJmxText(all);
  // 采样器按开标签数: 同名元素还有闭合标签与 hashTree 引用, 直接数子串会翻倍
  const samplers = (xml.match(/<HTTPSamplerProxy /g) || []).length;
  ok("剔除静态/预检/SSE 后只剩 3 个采样器", samplers === 3, samplers);
  ok("JMX 不含被剔除的路径", !xml.includes("/a.css") && !xml.includes("/sse"), "仍有噪音路径");
  ok("默认线程 1(__P 可覆盖)", xml.includes("__P(threads,1)"), "缺 __P(threads,1)");
  const xml5 = EX.buildJmxText(all, { threads: 5 });
  // buildJmx 口径: opts.threads 缺省写 ${__P(threads,1)}; 显式给数字就写死该值(压测口径)
  ok("opts.threads 生效(线程组写死 5)", xml5.includes('name="ThreadGroup.num_threads">5</stringProp>'),
    (xml5.match(/ThreadGroup\.num_threads">[^<]*/g) || [])[0]);
  ok("有 TestPlan 与 ThreadGroup 骨架", xml.includes("<TestPlan") && xml.includes("ThreadGroup"), "骨架缺失");
  let threw = "";
  try { EX.buildJmxText(noise); } catch (e) { threw = e.message; }
  ok("全是噪音 → 明确报错(不产出空脚本)", /过滤后没有条目/.test(threw), threw);
}

// ============================================================ PY: 压测口径
{
  console.log("\n[PY] 脚本形态");
  const all = [...api, ...noise];
  const py = EX.buildPyText(all);
  ok("PY 有 requests 导入与 step 定义", /import requests/.test(py) && /def step_/.test(py), py.slice(0, 80));
  ok("PY 不含被剔除的路径", !py.includes("/a.css") && !py.includes("/sse"), "仍有噪音路径");
  let threw = "";
  try { EX.buildPyText(noise); } catch (e) { threw = e.message; }
  ok("全是噪音 → 明确报错", /过滤后没有条目/.test(threw), threw);
}

// ============================================================ correlate
{
  console.log("\n[correlate] 关联结果");
  const r = EX.correlateText(api);
  ok("返回对象含 summary 数字", r && typeof r.summary === "number", r && Object.keys(r));
  ok("同接口两次录制产出 groups(差异面)", Array.isArray(r.groups), Object.keys(r));
}

// ============================================================ 单源证明
{
  console.log("\n[单源] bridge 真加载扩展源码(猴补即生效)");
  const jmx = require(path.join(EXT_ROOT, "jmx.js"));
  const pyMod = require(path.join(EXT_ROOT, "pyscript.js"));
  const common = require(path.join(EXT_ROOT, "common.js"));
  const origJ = jmx.buildJmx, origP = pyMod.buildPyScript, origH = common.buildHar;
  try {
    jmx.buildJmx = () => "SENTINEL-JMX";
    ok("改扩展 jmx.buildJmx → bridge 输出立刻变", EX.buildJmxText(api) === "SENTINEL-JMX", EX.buildJmxText(api));
    jmx.buildJmx = origJ;

    pyMod.buildPyScript = () => "SENTINEL-PY";
    ok("改扩展 pyscript.buildPyScript → bridge 输出立刻变", EX.buildPyText(api) === "SENTINEL-PY", "未生效");
    pyMod.buildPyScript = origP;

    common.buildHar = () => ({ sentinel: true });
    ok("改扩展 common.buildHar → bridge 输出立刻变", JSON.parse(EX.buildHarText(api)).sentinel === true, "未生效");
    common.buildHar = origH;
  } finally {
    jmx.buildJmx = origJ;
    pyMod.buildPyScript = origP;
    common.buildHar = origH;
  }
  assert.ok(typeof EX.buildJmxText(api) === "string");
  ok("还原后输出恢复正常", EX.buildJmxText(api).includes("HTTPSamplerProxy"), "未恢复");
}

// ============================================================ 降级分支
// exporters.clean() 有"扩展侧没有 filterSkippable 就原样返回"的降级分支(旧扩展/被裁剪的源码包)。
// 这条分支不测就等于没有 —— 用猴补把函数摘掉, 断言"不炸 + 不剔除"。
{
  console.log("\n[降级] 扩展侧缺 filterSkippable 时不清洗");
  const common = require(path.join(EXT_ROOT, "common.js"));
  const orig = common.filterSkippable;
  try {
    common.filterSkippable = undefined;
    const all = [...api, ...noise];
    const xml = EX.buildJmxText(all);
    const samplers = (xml.match(/<HTTPSamplerProxy /g) || []).length;
    ok("函数缺失 → 不炸且全量导出(6 个采样器)", samplers === 6, samplers);
    const py = EX.buildPyText(all);
    ok("PY 同样降级为全量", py.includes("/a.css") || py.includes("a_css") || py.includes("/sse"), "未见噪音路径");
  } catch (e) {
    ok("降级分支不抛错", false, e.message);
  } finally {
    common.filterSkippable = orig;
  }
  ok("还原后恢复剔除口径", (EX.buildJmxText([...api, ...noise]).match(/<HTTPSamplerProxy /g) || []).length === 3,
    (EX.buildJmxText([...api, ...noise]).match(/<HTTPSamplerProxy /g) || []).length);
}

// ============================================================ 异常形态条目
// 抓到的真实流量不止 GET/POST+JSON: HEAD 没有响应体、POST 可能没有 body、204 没有正文、
// query 可能长到几十个参数。这些分支此前没有任何断言 —— 导出器一改就可能静默错。
{
  console.log("\n[边界] HEAD / 空 body / 204 / 超长 query");
  const longQuery = Array.from({ length: 30 }, (_, i) => `p${i}=value${i}`).join("&");
  const edges = [
    { id: "h1", method: "HEAD", path: "/health", query: "", url: "https://h.test/health", headers: {}, body: "", status: 200, response: "", mime: "", ts: "", durationMs: 3 },
    { id: "h2", method: "POST", path: "/empty", query: "", url: "https://h.test/empty", headers: {}, body: "", status: 201, response: "{}", mime: "application/json", ts: "", durationMs: 8 },
    { id: "h3", method: "DELETE", path: "/gone", query: "", url: "https://h.test/gone", headers: {}, body: "", status: 204, response: "", mime: "", ts: "", durationMs: 4 },
    { id: "h4", method: "GET", path: "/q", query: longQuery, url: "https://h.test/q?" + longQuery, headers: {}, body: "", status: 200, response: "ok", mime: "text/plain", ts: "", durationMs: 5 },
  ];

  const har = JSON.parse(EX.buildHarText(edges));
  ok("HAR 保留 HEAD 方法", har.log.entries[0].request.method === "HEAD", har.log.entries[0].request.method);
  ok("HAR 204 无正文时 content.text 为空串", har.log.entries[2].response.content.text === "", har.log.entries[2].response.content);
  ok("HAR 超长 query 原样保留在 url", har.log.entries[3].request.url.endsWith(longQuery), har.log.entries[3].request.url.slice(-30));
  const cnHar = JSON.parse(EX.buildHarText([{ id: "c1", method: "GET", path: "/cn", query: "", url: "https://h.test/cn", headers: {}, body: "", status: 200, response: "世界", mime: "text/plain", ts: "", durationMs: 1 }]));
  ok("HAR content.size 是 UTF-8 字节(中文 2 字符 → 6)", cnHar.log.entries[0].response.content.size === 6,
    cnHar.log.entries[0].response.content);

  const xml = EX.buildJmxText(edges);
  ok("JMX 4 条边界条目都出采样器", (xml.match(/<HTTPSamplerProxy /g) || []).length === 4, (xml.match(/<HTTPSamplerProxy /g) || []).length);
  ok("JMX 保留 HEAD 方法", /<stringProp name="HTTPSampler.method">HEAD<\/stringProp>/.test(xml), "缺 HEAD 采样器");
  ok("空 body 的 POST 不生成 postBodyRaw 参数体", !xml.includes("{&quot;&quot;}"), "出现空 body 残留");
  // 口径: buildJmx 把 query 原样拼进 HTTPSampler.path(不拆成 Arguments), 保证 URL 与录制完全一致;
  // 参数化靠变量注入/CSV, 不是逐参数展开。这条断言钉住既有语义, 防止"顺手拆参数"改变导出结果。
  // XML 里 & 会转义成 &amp;, 断言按真实产物写
  // 契约变更(v1.2.0, 用户批准): query 超过 300 字符拆成 Arguments 参数表 ——
  // 数千字符的 query 内联在 JMeter 的 path 输入框里几乎无法阅读和修改。短 query 仍内联。
  ok("超长 query 拆成 Arguments 参数表(path 不含 ?query)",
    !/name="HTTPSampler\.path">\/q\?/.test(xml) && /Argument\.name">p0</.test(xml) && /Argument\.name">p29</.test(xml),
    (xml.match(/name="HTTPSampler\.path">[^<]{0,40}/g) || []).slice(0, 2));

  const py = EX.buildPyText(edges);
  ok("PY 生成 4 个 step", (py.match(/^def step_/gm) || []).length === 4, (py.match(/^def step_/gm) || []).length);
  ok("PY 的 HEAD 走 sess.request(\"HEAD\", ...)", /sess\.request\("HEAD"/.test(py), py.slice(0, 120));
}

// ============================================================ 方法与编码形态
// PATCH(改资源) / OPTIONS(预检, 应被清洗掉) / multipart 上传(带 boundary 的原始体)。
// 这些形态走的是不同分支: 方法白名单、预检剔除、以及"非 JSON 体按原文重放"。
{
  console.log("\n[边界] PATCH / OPTIONS / multipart");
  const mpBody = '--X\r\nContent-Disposition: form-data; name="f"; filename="a.txt"\r\n\r\ndata\r\n--X--\r\n';
  const entries = [
    { id: "p1", method: "PATCH", path: "/patch", query: "", url: "https://h.test/patch", headers: { "Content-Type": "application/json" }, body: '{"a":1}', status: 200, response: "{}", mime: "application/json", ts: "", durationMs: 6 },
    { id: "p2", method: "OPTIONS", path: "/pre", query: "", url: "https://h.test/pre", headers: {}, body: "", status: 204, response: "", mime: "", ts: "", durationMs: 1 },
    { id: "p3", method: "POST", path: "/upload", query: "", url: "https://h.test/upload", headers: { "Content-Type": "multipart/form-data; boundary=X" }, body: mpBody, status: 200, response: "ok", mime: "text/plain", ts: "", durationMs: 9 },
  ];

  const xml = EX.buildJmxText(entries);
  ok("OPTIONS 预检被清洗掉(不算业务请求)", !xml.includes("/pre"), "仍含 /pre");
  ok("PATCH 采样器保留且方法正确", /<stringProp name="HTTPSampler.method">PATCH<\/stringProp>/.test(xml), "缺 PATCH");
  ok("multipart 体走 postBodyRaw(原文重放, 不伪造 DO_MULTIPART_POST)",
    /<boolProp name="HTTPSampler.postBodyRaw">true<\/boolProp>/.test(xml) && xml.includes("filename="), "multipart 处理形态变了");

  const py = EX.buildPyText(entries);
  ok("PY 里 OPTIONS 同样被清洗", !py.includes("/pre"), "仍含 /pre");
  ok("PY 用 sess.request(\"PATCH\", ...)", /sess\.request\("PATCH"/.test(py), "缺 PATCH 调用");
  ok("PY 保留 multipart 的 Content-Type(含 boundary)", /multipart\/form-data; boundary=X/.test(py), "boundary 丢了");
  ok("PY 对非 JSON 体按原文 data= 发送", /data=payload\.encode\("utf-8"\)/.test(py), "body 发送形态变了");
}

console.log(`\n=== bridge exporters: ${pass} PASS / ${fail} FAIL ===`);
process.exit(fail ? 1 : 0);
