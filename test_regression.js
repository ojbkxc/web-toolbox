// 回归测试: 全模块单测(node 直跑, 无依赖)。
// 用法: node test_regression.js
const assert = require("assert");
const { execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

// 所有临时文件一律放系统临时目录(WORK), 绝不落在扩展根目录:
// Chrome 拒载任何含 "_" 开头文件/目录的扩展(__pycache__/_tmp.* 都会炸),
// 而 py_compile 无视 -B 必定在源文件旁生成 __pycache__ —— 只能让源文件不在扩展目录。
// 历史残留(上次测试中途失败留下的)在开头清一次。
const WORK = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "webtoolbox_test_"));
for (const junk of ["_tmp.jmx", "_tmp.py"]) {
  if (fs.existsSync(path.join(__dirname, junk))) fs.unlinkSync(path.join(__dirname, junk));
}
for (const junk of fs.readdirSync(__dirname).filter((n) => n === "__pycache__" || /^_tmpdir_/.test(n))) {
  fs.rmSync(path.join(__dirname, junk), { recursive: true, force: true });
}

// ---------- correlate ----------
const C = require("./correlate.js");
const j = (o) => JSON.stringify(o);

// 1) diff 找动态值(数字 + 字符串时间戳)
{
  const bodies = [
    j({ ts: 1789520000000, name: "a", orderNo: "6512345678901", fixed: "x" }),
    j({ ts: 1789520005000, name: "a", orderNo: "6512345678902", fixed: "x" }),
  ];
  const dyn = C.diffJsonBodies(bodies);
  assert.ok(dyn.some((d) => d.path === "ts"), "ts 应被识别为动态");
  assert.ok(dyn.some((d) => d.path === "orderNo"), "orderNo 应被识别为动态");
  assert.ok(!dyn.some((d) => d.path === "fixed"), "fixed 不应出现");
  assert.ok(!dyn.some((d) => d.path === "name"), "name 不应出现");
}

// 2) 分类
{
  const ts = C.classifyDynamic("ts", ["1789520000000"]);
  assert.strictEqual(ts.kind, "timestamp");
  assert.strictEqual(ts.fn, "${__time()}");
  const dt = C.classifyDynamic("createTime", ["2026-09-16 10:00:00"]);
  assert.strictEqual(dt.kind, "timestamp");
  const seq = C.classifyDynamic("orderNo", ["6512345678901"]);
  assert.strictEqual(seq.kind, "seq");
  const uuid = C.classifyDynamic("uid", ["550e8400-e29b-41d4-a716-446655440000"]);
  assert.strictEqual(uuid.kind, "seq");
  const fx = C.classifyDynamic("foo", ["v1"]);
  assert.strictEqual(fx.kind, "fixed");
  // 2b) 混合集判定序(v1.0.73, #166 方向①): 单值断言(L40-50)都在"形态唯一"集上,
  //     真实录制同一接口两次, 动态字段的 values 是【两次的值】—— 形态可能不同:
  //     单号两次都是 65 开头 13 位(seq 优先判定) / 一次 13 位毫秒一次其他(timestamp)。
  //     classifyDynamic 只看 values[0], 判定序是 65 单号 → 13 位时间戳 → 12+ 位 seq。
  //     钉"首值优先"语义: 首值是单号 → seq(哪怕次值像时间戳); 首值是时间戳 → timestamp。
  assert.strictEqual(C.classifyDynamic("orderNo", ["6512345678901", "6512345678999"]).kind, "seq",
    "混合集: 两次都 65 单号 → seq");
  assert.strictEqual(C.classifyDynamic("bizNo", ["6512345678901", "9998244000000"]).kind, "seq",
    "混合集: 首值 65 单号 + 次值 13 位数字 → 首值优先 seq");
  assert.strictEqual(C.classifyDynamic("reqTime", ["1789520000000", "6512345678901"]).kind, "timestamp",
    "混合集: 首值 13 位时间戳 + 次值 65 单号 → 首值优先 timestamp");
  // 12+ 位非 65 开头且非 13 位毫秒形态(如 12 位流水)仍走 seq 兜底
  assert.strictEqual(C.classifyDynamic("serial", ["123456789012"]).kind, "seq",
    "12 位流水号(非 65/非 13 位毫秒)→ seq 兜底");
}

// 3) applyDynamics: 数字值(裸)与字符串值(带引号)都要替换, 静态不动
{
  const dyn = [
    { path: "ts", values: ["1789520000000", "1789520005000"], replace: "${__time()}" },
    { path: "strTs", values: ["2026-09-16 10:00:00", "2026-09-16 10:00:05"], replace: "${__time(yyyy-MM-dd HH:mm:ss)}" },
  ];
  const out = C.applyDynamics(j({ ts: 1789520000000, strTs: "2026-09-16 10:00:00", keep: 1 }), dyn);
  assert.ok(out.includes('"ts": "${__time()}"'), "数字时间戳应被替换: " + out);
  assert.ok(out.includes('"strTs": "${__time(yyyy-MM-dd HH:mm:ss)}"'), "字符串时间戳应被替换");
  assert.ok(/"keep":\s*1/.test(out), "静态字段不动: " + out);
  // 替换后的 body 必须仍是合法 JSON
  assert.strictEqual(JSON.parse(out).ts, "${__time()}");
}

// 4) analyzeCorrelation 分组
{
  const entries = [
    { method: "POST", path: "/a", body: j({ x: 1, t: 1 }) },
    { method: "POST", path: "/a", body: j({ x: 1, t: 2 }) },
    { method: "GET", path: "/b", body: null },
  ];
  const r = C.analyzeCorrelation(entries);
  assert.strictEqual(r.groups.length, 1);
  assert.strictEqual(r.groups[0].path, "/a");
  assert.strictEqual(r.groups[0].dynamics.length, 1);
}

// 4b) query 参数 diff(v1.0.19): query 与 body 同管线, path 加 Q_ 前缀区分;
//     timestamp 替换经 applyDynamicsToQuery 生效(剥前缀取键); Q_ 动态不挂溯源链(保守)
{
  const entries = [
    { method: "GET", path: "/list", body: "", query: "cursor=AAA&page=1&ts=1789520000000" },
    { method: "GET", path: "/list", body: "", query: "cursor=BBB&page=1&ts=1789520060000" },
  ];
  const r = C.analyzeCorrelation(entries);
  const paths = r.groups[0].dynamics.map((d) => d.path).sort();
  assert.deepStrictEqual(paths, ["Q_cursor", "Q_ts"], "query 两个动态字段: " + JSON.stringify(paths));
  const tsDyn = r.groups[0].dynamics.find((d) => d.path === "Q_ts");
  assert.strictEqual(tsDyn.classify.kind, "timestamp");
  const out = C.applyDynamicsToQuery("cursor=AAA&page=1&ts=1789520000000", r.groups[0].dynamics);
  assert.ok(out.includes("ts=${__time()}"), "Q_ 前缀剥掉后按原键替换: " + out);
  assert.ok(out.includes("cursor=AAA"), "fixed 类无 replace, query 保持原值: " + out);
  // Q_ 动态不挂链(body 里无值可取, 纵深防御 continue 也挡住)
  const links = C.linkSeqDynamics(entries, r, []);
  assert.strictEqual(links.filter((l) => l.toParam === "Q_cursor" || l.toParam === "cursor").length, 0,
    "query 动态不得挂 body 溯源链");
  // body 与 query 混合: 同组两者都 diff, 命名空间不打架
  const mix = C.analyzeCorrelation([
    { method: "POST", path: "/m", body: j({ a: 1 }), query: "page=1&v=x" },
    { method: "POST", path: "/m", body: j({ a: 2 }), query: "page=1&v=y" },
  ]);
  assert.deepStrictEqual(mix.groups[0].dynamics.map((d) => d.path).sort(), ["Q_v", "a"],
    "body 与 query 动态并存: " + JSON.stringify(mix.groups[0].dynamics.map((d) => d.path)));
}

// 5) 值溯源: seq 动态值 → 上游响应同值叶 → 合成参数链(corr↔aiChain 联动, v1.0.2)
{
  const mk = () => ([
    { id: "c0", method: "POST", path: "/order/create", body: "{}", response: '{"data":{"orderNo":"6512345678901"}}' },
    { id: "c1", method: "POST", path: "/order/submit", body: '{"orderNo":"6512345678901"}', response: "" },
    { id: "c2", method: "POST", path: "/order/create", body: "{}", response: '{"data":{"orderNo":"6599999999999"}}' },
    { id: "c3", method: "POST", path: "/order/submit", body: '{"orderNo":"6599999999999"}', response: "" },
  ]);
  const corr = C.analyzeCorrelation(mk());
  const links = C.linkSeqDynamics(mk(), corr, []);
  assert.strictEqual(links.length, 2, "两条 submit 都应溯源到上游 create: " + JSON.stringify(links));
  const l0 = links[0];
  assert.strictEqual(l0.from, 0);
  assert.strictEqual(l0.to, 1);
  assert.strictEqual(l0.fromJsonPath, "data.orderNo");
  assert.strictEqual(l0.fromId, "c0");
  assert.strictEqual(l0.toId, "c1");
  assert.strictEqual(l0.origin, "corr");
  assert.strictEqual(l0.toParam, "orderNo");
  assert.strictEqual(links[1].from, 2, "第二条 submit 就近溯源到第二个 create");
  // 变量名错开: AI 链已占 V_orderNo 时合成链加后缀
  const links2 = C.linkSeqDynamics(mk(), corr, ["V_orderNo"]);
  assert.ok(links2.some((c) => c.var === "V_orderNo_2"), "taken 占用时变量名应错开: " + JSON.stringify(links2.map((c) => c.var)));
  // timestamp 类不溯源(已有 ${__time()} 参数化)
  const tsEntries = [
    { id: "ts0", method: "POST", path: "/x", body: "{}", response: '{"data":{"ts":1730000000000}}' },
    { id: "ts1", method: "POST", path: "/y", body: '{"ts":1730000001000}', response: "" },
    { id: "ts2", method: "POST", path: "/y", body: '{"ts":1730000002000}', response: "" },
  ];
  const tsCorr = C.analyzeCorrelation(tsEntries);
  assert.strictEqual(C.linkSeqDynamics(tsEntries, tsCorr, []).length, 0, "timestamp 不溯源");
  // 同值多路径且无同名叶 → 保守不链
  const ambEntries = [
    { id: "am0", method: "POST", path: "/q", body: "{}", response: '{"a":{"x":"DUP"},"b":{"y":"DUP"}}' },
    { id: "am1", method: "POST", path: "/w", body: '{"f1":"DUP"}', response: "" },
    { id: "am2", method: "POST", path: "/w", body: '{"f1":"DUP2"}', response: "" },
  ];
  const ambCorr = C.analyzeCorrelation(ambEntries);
  assert.strictEqual(C.linkSeqDynamics(ambEntries, ambCorr, []).length, 0, "溯源不确定时不链(宁可不链也不链错)");
  // indexResponseLeaves / jsonPathGet 基础形态
  const leaves = C.indexResponseLeaves('{"data":{"list":[{"id":1},{"id":2}]}}');
  assert.ok(leaves.some((l) => l.path === "data.list.0.id" && l.value === "1"), "数组下标路径: " + JSON.stringify(leaves));
  assert.strictEqual(C.indexResponseLeaves("not json"), null);
  assert.strictEqual(C.jsonPathGet('{"a":{"b":"v"}}', "a.b"), "v");
  assert.strictEqual(C.jsonPathGet("bad", "a"), null);
}

// 5b) 导出净化: JMX/PY 剔除预检/静态资源/SSE, JSONL/HAR 保真全量(common.js, 双 realm 共用)。
// STATIC_EXT 不含 .json —— 内网业务接口大量是 /xx.json 形态, 误杀不可逆。
{
  const CM = require("./common.js");
  assert.strictEqual(typeof CM.filterSkippable, "function", "common.js 应导出 filterSkippable");
  assert.strictEqual(typeof CM.isSkippable, "function", "common.js 应导出 isSkippable");
  const es = [
    { id: "s1", method: "OPTIONS", path: "/api/o", headers: {} },
    { id: "s2", method: "GET", path: "/static/app.js", headers: {} },
    { id: "s3", method: "GET", path: "/sse/push", headers: { "Content-Type": "text/event-stream" } },
    { id: "s4", method: "GET", path: "/api/list.json", headers: {} },
    { id: "s5", method: "POST", path: "/api/order", headers: {} },
  ];
  const { entries: kept, dropped } = CM.filterSkippable(es);
  assert.strictEqual(dropped, 3, "预检/静态/SSE 共剔除 3 条");
  assert.deepStrictEqual(kept.map((e) => e.id), ["s4", "s5"], ".json 业务接口不误杀: " + JSON.stringify(kept.map((e) => e.id)));
  assert.strictEqual(CM.filterSkippable([]).dropped, 0, "空集 dropped=0");
  assert.strictEqual(CM.filterSkippable(null).entries.length, 0, "null 容错");
  assert.strictEqual(CM.isSkipHeader("Cookie"), true, "isSkipHeader 大小写不敏感");
  // 5c) SSE 判定双形态(v1.0.56 修死分支): 录制引擎产出的真实条目 SSE 信号在响应 mime
  // (item.mime 来自 CDP responseReceived), 请求头表 headers 从不含响应 Content-Type ——
  // 旧行只查 headers 对引擎产出永远不命中; headers 兜底同时兼容小写头(HTTP 头大小写不敏感)。
  assert.ok(CM.isSkippable({ method: "GET", path: "/sse/push", headers: { "Accept": "text/event-stream" }, mime: "text/event-stream" }), "真实录制形态: mime 命中 SSE");
  assert.ok(CM.isSkippable({ method: "GET", path: "/sse", headers: { "content-type": "text/event-stream" } }), "headers 兜底: 小写 content-type 命中");
  assert.ok(CM.isSkippable({ method: "GET", path: "/sse", headers: { "content-type": "TEXT/EVENT-STREAM" } }), "headers 兜底: 值大小写不敏感");
  assert.ok(!CM.isSkippable({ method: "POST", path: "/api/order", headers: { "Content-Type": "application/json" }, mime: "application/json" }), "业务条目 mime=json 不误杀");
  assert.ok(!CM.isSkippable({ method: "GET", path: "/sse2", headers: { "content-type": "application/json" }, mime: "application/json" }), "同路径 mime 非 SSE 不误杀");
  // 5d) JSONL 行保真字段完备(v1.0.57): 差异表(check_export_fields)声称 JSONL 消费
  // mime/ts/durationMs, 此前行里没有 —— AI 工具链/人工分析拿不到耗时与时间戳。补齐 +
  // 旧数据缺字段时默认值兜底(mime:""/ts:""/durationMs:0)不炸。
  const rowFull = CM.harvestToExportRows([{ id: "r1", method: "GET", url: "https://a.b.com/x", headers: {}, body: "", status: 200, response: "b", mime: "application/json", ts: "2026-09-17T08:00:00Z", durationMs: 123 }])[0];
  assert.ok(rowFull.mime === "application/json" && rowFull.ts === "2026-09-17T08:00:00Z" && rowFull.durationMs === 123, "JSONL 行含 mime/ts/durationMs 保真字段");
  assert.ok(!("id" in rowFull), "JSONL 行不导 id(行内不稳定标识)");
  const rowOld = CM.harvestToExportRows([{ method: "GET", url: "x" }])[0];
  assert.ok(rowOld.mime === "" && rowOld.ts === "" && rowOld.durationMs === 0, "旧数据缺字段默认值兜底不炸");
  // 5e) JSONL response 与 HAR 同口径不截断(v1.0.70): 同为"保真格式", 旧 slice(0,4000)
  // 让 200KB 大响应在 JSONL 只剩前 4000 字符 —— 与 HAR content.text 全量对不上,
  // AI 工具链分析大响应时后段静默丢失(入库已在引擎侧截 200KB, 这层截断是双重且分叉的)。
  const bigResp = "x".repeat(200000);
  const rowBig = CM.harvestToExportRows([{ id: "rb", method: "GET", url: "https://a.b.com/big", headers: {}, body: "", status: 200, response: bigResp, mime: "application/json", ts: "2026-09-17T09:00:00Z", durationMs: 5 }])[0];
  assert.ok(rowBig.response === bigResp, "JSONL 行 response 全量不截断(与 HAR content.text 同口径)");
  const harBig = CM.buildHar([{ id: "rb", method: "GET", url: "https://a.b.com/big", headers: {}, body: "", status: 200, response: bigResp, mime: "application/json", ts: "2026-09-17T09:00:00Z", durationMs: 5 }]);
  assert.ok(harBig.log.entries[0].response.content.text === bigResp, "HAR content.text 全量(对照组: 两侧同口径)");
}

// ---------- jmx ----------
const J = require("./jmx.js");
{
  const entries = [
    { method: "GET", url: "https://api1.test.com/web/list?page=1", path: "/web/list", query: "page=1", headers: { "x-a": "1" } },
    { method: "POST", url: "https://api2.test.com/web/create", path: "/web/create", query: "", headers: { "Content-Type": "application/json" }, body: '{"a":1}' },
    { method: "DELETE", url: "https://api1.test.com/web/del", path: "/web/del", query: "", headers: {}, body: '{"id":9}' },
  ];
  const jmx = J.buildJmx(entries);
  // XML 合法性
  const check = `python -c "import xml.dom.minidom,sys; xml.dom.minidom.parseString(open(sys.argv[1],encoding='utf-8').read())" "${path.join(WORK, "_tmp.jmx").replace(/\\/g, "/")}"`;
  fs.writeFileSync(path.join(WORK, "_tmp.jmx"), jmx, "utf-8");
  execSync(check, { shell: "bash" });
  // UDF 必须是 ${__P(name,default)} 才能被 -J 覆盖; threads 默认 1(巡检安全口径, v1.0.90)
  assert.ok(jmx.includes("${__P(threads,1)}"), "UDF threads 应为 __P 格式且默认 1(巡检安全)");
  assert.ok(jmx.includes("${__P(loops,1)}"), "UDF loops 应为 __P 格式");
  // 采样器域名变量化(v1.0.79): hostname 只出现在 UDF 值, 采样器 domain 一律引用 ${HOST_n}
  // —— JMeter 跨环境切域名的标准姿势(对齐手写 KTKI UAT.jmx 的 ${BASE_URL} 全变量化形态)。
  // 环境切换(UAT→PROD)只改 UDF 值, 不逐采样器手改; 通用化用自动编号 HOST_n 而非业务具名
  // (主机名从录制条目派生, 谁是 "BASE" 不可知)。
  assert.ok(jmx.includes(">HOST_1</stringProp><stringProp name=\"Argument.value\">${__P(HOST_1,api1.test.com)}<"), "UDF HOST_1 值=api1 域名(__P 可 -J 覆盖)");
  assert.ok(jmx.includes(">HOST_2</stringProp><stringProp name=\"Argument.value\">${__P(HOST_2,api2.test.com)}<"), "UDF HOST_2 值=api2 域名(跨域)");
  assert.ok(jmx.includes("<stringProp name=\"HTTPSampler.domain\">${HOST_1}</stringProp>"), "采样器 domain 引用 ${HOST_1}");
  assert.ok(jmx.includes("<stringProp name=\"HTTPSampler.domain\">${HOST_2}</stringProp>"), "跨域采样器 domain 引用 ${HOST_2}");
  assert.ok(!(jmx.match(/<stringProp name="HTTPSampler\.domain">[^<]*test\.com</g) || []).length, "采样器 domain 不再有 hostname 字面量(全变量化)");
  // 带 body 的 DELETE 也不丢 body(xmlEsc 后引号是 &quot;)
  assert.ok(jmx.includes("{&quot;id&quot;:9}"), "DELETE body 不应丢: " + jmx.slice(jmx.indexOf("postBodyRaw"), jmx.indexOf("postBodyRaw") + 300));
  assert.ok(jmx.split("postBodyRaw").length - 1 >= 2, "POST+DELETE 都应是 raw body");
  // think 思考时间: UDF + ConstantTimer 都要有(防无间隔压爆 UAT)
  assert.ok(jmx.includes("${__P(think,500)}"), "think UDF 应为 __P 格式");
  assert.ok(jmx.includes("ConstantTimer"), "应有 ConstantTimer");
  assert.ok(jmx.indexOf("ConstantTimer") > jmx.lastIndexOf("HTTPSamplerProxy"), "Timer 应在采样器之后(每轮末尾停顿)");
  fs.unlinkSync(path.join(WORK, "_tmp.jmx"));
}

// ---------- 5f) 完全相同请求去重 + CSV 数据驱动(v1.0.82) ----------
{
  const CM = require("./common.js");
  // 去重键: method+path+query+body 完全一致才算重复; 响应/耗时/headers 不同不拆。
  const dupes = [
    { id: "a", method: "POST", path: "/p", query: "", body: '{"x":1}', headers: {} },
    { id: "b", method: "POST", path: "/p", query: "", body: '{"x":1}', headers: { "x-h": "diff" } }, // headers 不同不算
    { id: "c", method: "POST", path: "/p", query: "", body: '{"x":1}', headers: {} },               // 重复
    { id: "d", method: "POST", path: "/p", query: "a=1", body: '{"x":1}', headers: {} },            // query 不同不算
    { id: "e", method: "GET", path: "/p", query: "", body: "", headers: {} },                       // method 不同不算
  ];
  assert.deepStrictEqual(CM.dedupeIdentical(dupes).map((e) => e.id), ["a", "d", "e"],
    "method+path+query+body 相同即重复(a→b→c 全去重, headers 不同不算不同; query/method 不同保留)");
  assert.strictEqual(CM.dedupeIdentical([]).length, 0, "空集");
  assert.strictEqual(CM.dedupeIdentical(null).length, 0, "null 容错");

  // collectCsvData: 从依赖链抽被 ${var} 引用的列及其录制值(applyAiChainToJmx 之前调)
  const entries = [
    { id: 1, method: "POST", url: "https://a.com/orders", path: "/orders", query: "", headers: {}, body: '{"orderNo":"65abc"}' },
    { id: 2, method: "POST", url: "https://a.com/orders/detail", path: "/orders/detail", query: "", headers: {}, body: '{"orderNo":"PLACEHOLDER"}' },
    { id: 3, method: "GET", url: "https://a.com/orders/detail?orderNo=zzz", path: "/orders/detail", query: "orderNo=zzz", headers: {}, body: "" },
  ];
  const chain = [
    { fromId: 1, toId: 2, toParam: "orderNo", var: "V_orderNo", fromJsonPath: "data.0.orderNo" },
    { fromId: 1, toId: 3, toParam: "url.orderNo", var: "V_q_orderNo", fromJsonPath: "data.0.orderNo" },
    { fromId: 1, toId: 2, toParam: "header.x-tok", var: "V_h_tok", fromJsonPath: "data.0.tok" }, // header 不进 CSV
  ];
  const csv = CM.collectCsvData(entries, chain);
  assert.ok(csv.some((c) => c.var === "V_orderNo" && c.default === "PLACEHOLDER"), "body 叶子取值=录制值: " + JSON.stringify(csv));
  assert.ok(csv.some((c) => c.var === "V_q_orderNo" && c.default === "zzz"), "query 取值: " + JSON.stringify(csv));
  assert.ok(!csv.some((c) => c.var === "V_h_tok"), "header. 形态不进 CSV(HeaderManager 单值语义)");
  // 占位符防御: 传 applyAiChainToJmx 之后的 entries(替换成 ${var})→ 列静默跳过
  const applied = CM.applyAiChainToJmx(entries.map((e) => ({ ...e })), chain);
  const csv2 = CM.collectCsvData(applied, chain);
  assert.ok(!csv2.some((c) => c.var === "V_orderNo"), "替换后取值是占位符 → 跳过该列(防御): " + JSON.stringify(csv2));
  // 无链 → 空
  assert.strictEqual(CM.collectCsvData(entries, []).length, 0, "无链空集");
  assert.strictEqual(CM.collectCsvData(entries, null).length, 0, "null 链容错");

  // buildJmx 挂 CSVDataSet + UDF 兜底 + 冲突列过滤
  const jmx = J.buildJmx(applied, { csvData: csv, csvFileName: "data_test.csv" });
  assert.ok(jmx.includes("<CSVDataSet"), "buildJmx 应生成 CSVDataSet");
  assert.ok(jmx.includes("variableNames\">V_orderNo,V_q_orderNo</stringProp>"), "CSV 列名=变量(header 列已过滤): " + (jmx.match(/variableNames">([^<]*)/) || [])[0]);
  assert.ok(jmx.includes("${csvPath}${csvFile}"), "CSVDataSet filename 引用 csvPath+csvFile");
  assert.ok(jmx.includes(">csvPath</stringProp><stringProp name=\"Argument.value\">${__P(csvPath,)}<"), "csvPath UDF 兜底");
  assert.ok(jmx.includes(">V_orderNo</stringProp><stringProp name=\"Argument.value\">${__P(V_orderNo,PLACEHOLDER)}<"), "列 UDF 兜底=录制值(无 CSV 也能跑)");
  // CSVDataSet 位置: ThreadGroup hashTree 内(采样器前), 非 TestPlan 层
  assert.ok(jmx.indexOf("<CSVDataSet") > jmx.indexOf("<ThreadGroup"), "CSVDataSet 在 ThreadGroup 内");
  assert.ok(jmx.indexOf("<CSVDataSet") < jmx.lastIndexOf("HTTPSamplerProxy"), "CSVDataSet 在采样器前");
  // CSV 模板: 表头 + 首行录制值
  const csvTxt = J.csvTemplateText(csv);
  assert.strictEqual(csvTxt, "V_orderNo,V_q_orderNo\nPLACEHOLDER,zzz\n", "CSV 模板表头+录制值首行: " + JSON.stringify(csvTxt));
  // CSV 值含逗号/引号/换行 → quotedData=true 双引号转义
  const csvEsc = J.csvTemplateText([{ var: "v", default: 'a,"b",c\nnewline' }]);
  assert.ok(csvEsc.includes('"a,""b"",c\nnewline"'), "CSV 特殊字符双引号转义: " + JSON.stringify(csvEsc));
}

// ---------- auth(登录前置识别) ----------
const AUTH = require("./auth.js");
{
  const entries = [
    { id: 1, method: "GET", url: "https://signin.test.com/login?service=https://app.test.com/", path: "/login", headers: {}, response: "<html>统一认证</html>" },
    { id: 2, method: "POST", url: "https://app.test.com/web/auth-server/user/getSetProfile", path: "/web/auth-server/user/getSetProfile", headers: {}, response: '{"data":{}}' },
    { id: 3, method: "POST", url: "https://app.test.com/web/auth-server/user/changePosition", path: "/web/auth-server/user/changePosition", headers: {}, response: '{"data":{}}' },
    { id: 4, method: "GET", url: "https://app.test.com/web/list?page=1", path: "/web/list", headers: {}, response: '{"items":[]}' },
  ];
  const { ids, reasons } = AUTH.autoDetectPrelude(entries);
  assert.ok(ids.has(1), "login 页应识别为前置");
  assert.ok(ids.has(2), "getSetProfile 应识别为前置");
  assert.ok(ids.has(3), "changePosition 应识别为前置");
  assert.ok(!ids.has(4), "业务 /web/list 不应自动标前置");
  const g = AUTH.groupPrelude(entries, [1, 2, 3]);
  assert.strictEqual(g.prelude.length, 3, "前置组 3 条");
  assert.strictEqual(g.business.length, 1, "业务组 1 条");
  // 登录页响应特征: URL 无特征但响应是登录页 → 也算(方案A自动识别)
  const loginPage = { id: 9, url: "https://app.test.com/", path: "/", headers: {}, response: "欢迎登录 请输入密码" };
  assert.ok(AUTH.isAuthLike(loginPage), "登录页响应特征应识别");

  // ---- AUTH_RULES 零覆盖面补测(v1.0.55, #148 方向③盘点产出) ----
  // 此前 test_regression 的 auth 节只覆盖 CAS/user context/登录页响应三类,
  // OAuth-token 与 login-body 两条规则的行为从未被断言钉住。
  // 1) refreshToken / serviceValidate / 裸 /token 结尾 —— 规则表路径正则的独立命中面
  assert.strictEqual(AUTH.isAuthLike({ url: "https://gw.test.com/oauth2/refreshToken", response: "" }), "OAuth/token", "refreshToken 路径应命中 OAuth 规则");
  assert.strictEqual(AUTH.isAuthLike({ url: "https://sso.test.com/cas/serviceValidate", response: "" }), "CAS/SSO", "serviceValidate 路径应命中 CAS 规则");
  assert.strictEqual(AUTH.isAuthLike({ url: "https://api.test.com/v1/auth/token", response: "" }), "OAuth/token", "/token 结尾路径应命中");
  // 2) hasLoginBodyPair: 表单 k=v 与 JSON "k":v 两种形态, 空格无关
  assert.ok(AUTH.hasLoginBodyPair({ body: "username=alice&password=s3cret" }), "表单体 username+password 双要素命中");
  assert.ok(AUTH.hasLoginBodyPair({ body: '{ "username" : "alice", "password" : "s3cret" }' }), "JSON 体 username+password 双要素命中(空格无关)");
  assert.ok(!AUTH.hasLoginBodyPair({ body: "username=alice" }), "单 username 不误报(改资料类接口)");
  assert.ok(!AUTH.hasLoginBodyPair({ body: "password=s3cret" }), "单 password 不误报");
  assert.ok(!AUTH.hasLoginBodyPair({}), "空 body 不炸不命中");
  // 3) login body 纯形态: URL 无任何登录特征(现代 SPA 形态), 凭 body 双要素命中
  const loginBody = { id: 11, method: "POST", url: "https://app.test.com/api/session", path: "/api/session", headers: {}, body: '{"username":"a","password":"b"}', response: '{"resultCode":"0"}' };
  assert.strictEqual(AUTH.isAuthLike(loginBody), "login body", "URL 无特征 + body 双要素 → login body 规则命中");
  // 4) autoDetectPrelude 前缀连续策略: body 命中若出现在链中段(前面已有业务请求), 不自动勾 ——
  //    误报面兜底语义(规则注释第 6 条声称的保障, 行为级钉死)
  const midLogin = [
    { id: 21, method: "GET", url: "https://app.test.com/list", headers: {}, response: '{"ok":1}' },
    loginBody,
  ];
  const midRes = AUTH.autoDetectPrelude(midLogin);
  assert.ok(!midRes.ids.has(21) && !midRes.ids.has(11), "链中段 body 命中不自动勾(前缀连续策略兜底误报)");
  // 5) 已知误报面钉底: 响应含 "password" 字段名(改密码类接口)会命中 login page resp 规则 ——
  //    单看 isAuthLike 是误报, 但 autoDetectPrelude 的前缀连续策略保证链中段不自动勾。
  //    断言钉住该兜底不回退: 误报面只允许存在于规则层, 不允许泄漏到自动勾选行为。
  const midPasswd = [
    { id: 31, method: "GET", url: "https://app.test.com/list", headers: {}, response: "{}" },
    { id: 32, method: "POST", url: "https://app.test.com/api/profile", headers: {}, body: "", response: '{"password":"hashed"}' },
  ];
  assert.strictEqual(AUTH.isAuthLike(midPasswd[1]), "login page resp", "误报面存在性: 响应含 password 字段名命中规则层(已知, 非缺陷)");
  const midPasswdRes = AUTH.autoDetectPrelude(midPasswd);
  assert.ok(!midPasswdRes.ids.has(32), "改密码接口在链中段不被自动勾(误报面被前缀策略兜住)");
  // 6) 重开窗口语义(v1.0.57): 冷启动先访问业务页再跳 SSO(302 跳转链)的登录链在中段 ——
  //    强特征规则(CAS/SSO、OAuth/token、user context, 严格路径正则)中断后重开识别窗口;
  //    弱特征(login page resp/login body/form login 宽正则)不重开 —— 误报面靠窗口关闭挡。
  const midSso = [
    { id: 41, method: "GET", url: "https://app.test.com/index", headers: {}, response: "{}" },
    { id: 42, method: "GET", url: "https://sso.test.com/login?service=x", headers: {}, response: "" },
    { id: 43, method: "POST", url: "https://sso.test.com/cas/serviceValidate", headers: {}, response: "" },
    { id: 44, method: "POST", url: "https://app.test.com/web/auth-server/user/getSetProfile", headers: {}, response: "{}" },
    { id: 45, method: "GET", url: "https://app.test.com/web/list", headers: {}, response: "{}" },
  ];
  const midSsoRes = AUTH.autoDetectPrelude(midSso);
  assert.ok(midSsoRes.ids.has(42) && midSsoRes.ids.has(43) && midSsoRes.ids.has(44), "中段 SSO 302 登录链被重开识别(CAS/SSO 强特征): " + [...midSsoRes.ids].join(","));
  assert.ok(!midSsoRes.ids.has(41) && !midSsoRes.ids.has(45), "重开只勾登录链, 链外业务不勾");
  // 6b) form login 的宽正则(/login/i)不在强特征集: /api/loginHistory 业务接口中段命中不重开
  const midHist = [
    { id: 51, method: "GET", url: "https://app.test.com/list", headers: {}, response: "{}" },
    { id: 52, method: "GET", url: "https://app.test.com/api/loginHistory", headers: {}, response: "{}" },
  ];
  assert.ok(!AUTH.autoDetectPrelude(midHist).ids.has(52), "form login 宽正则不重开(loginHistory 业务接口中段不误勾)");
  // 6c) 中段 OAuth 静默刷新链(refreshToken)同样重开
  const midOAuth = [
    { id: 61, method: "GET", url: "https://app.test.com/list", headers: {}, response: "{}" },
    { id: 62, method: "POST", url: "https://auth.test.com/oauth2/refreshToken", headers: {}, body: "", response: '{"access_token":"x"}' },
    { id: 63, method: "GET", url: "https://app.test.com/list2", headers: {}, response: "{}" },
  ];
  const midOAuthRes = AUTH.autoDetectPrelude(midOAuth);
  assert.ok(midOAuthRes.ids.has(62) && !midOAuthRes.ids.has(63), "中段 refreshToken 静默刷新链被重开识别");
}

// ---------- jmx: 前置包 OnceOnly + 会话失效自动重登 ----------
{
  const entries = [
    { id: 1, method: "GET", url: "https://signin.test.com/login", path: "/login", headers: {}, response: "<html>统一认证</html>" },
    { id: 2, method: "POST", url: "https://app.test.com/web/auth-server/user/getSetProfile", path: "/web/auth-server/user/getSetProfile", headers: { "Content-Type": "application/json" }, body: "{}" },
    { id: 3, method: "GET", url: "https://app.test.com/web/list", path: "/web/list", headers: {} },
  ];
  // 1) 默认(无 prelude): 不含 OnceOnly
  const plain = J.buildJmx(entries);
  assert.ok(!plain.includes("OnceOnlyController"), "无前置配置时不应包 OnceOnly");
  // 2) 前置 [1,2]: OnceOnly 包住前置, 业务在 OnceOnly 之外
  const once = J.buildJmx(entries, { prelude: [1, 2] });
  assert.ok(once.includes("OnceOnlyController"), "前置配置应生成 OnceOnly");
  assert.ok(once.includes("登录前置条件"), "应有聚合事务「登录前置条件」");
  const oncePreIdx = once.indexOf("OnceOnlyController");
  const preLoginIdx = once.indexOf("/login");
  const preProfileIdx = once.indexOf("getSetProfile");
  const bizIdx = once.indexOf("/web/list");
  assert.ok(preLoginIdx > oncePreIdx && preProfileIdx > oncePreIdx, "前置采样器应在 OnceOnly 内");
  assert.ok(bizIdx > once.indexOf("</hashTree>") && bizIdx > preProfileIdx, "业务应在 OnceOnly 之后");
  // XML 合法
  const f2 = path.join(WORK, "_tmp2.jmx");
  fs.writeFileSync(f2, once, "utf-8");
  execSync(`python -c "import xml.dom.minidom; xml.dom.minidom.parse(open(r'${f2}',encoding='utf-8'))"`, { shell: "bash" });
  fs.unlinkSync(f2);
  // 3) autoRelogin: IfController 两个 + BeanShell 置变量 + JSR223 失效检测
  const relogin = J.buildJmx(entries, { prelude: [1, 2], autoRelogin: true, sessionMarkers: ["统一认证"] });
  assert.ok(relogin.includes("IfController"), "autoRelogin 应生成 IfController");
  assert.ok((relogin.match(/IfController/g) || []).length >= 2, "登录/业务两个 IfController");
  assert.ok(relogin.includes("BeanShellSampler"), "应有置登录状态采样器");
  assert.ok(relogin.includes("JSR223PostProcessor"), "应有会话失效检测");
  assert.ok(relogin.includes("__logged_in"), "应使用 __logged_in 变量");
  const f3 = path.join(WORK, "_tmp3.jmx");
  fs.writeFileSync(f3, relogin, "utf-8");
  execSync(`python -c "import xml.dom.minidom; xml.dom.minidom.parse(open(r'${f3}',encoding='utf-8'))"`, { shell: "bash" });
  fs.unlinkSync(f3);
}

// ---------- pyscript ----------
const P = require("./pyscript.js");
{
  const entries = [
    { method: "POST", path: "/web/create", url: "http://127.0.0.1:1/web/create", headers: { "Content-Type": "application/json", "x-gr-orgcode": "O00001001" }, body: '{"a":1}' },
    { method: "POST", path: "/web/create", url: "http://127.0.0.1:1/web/create", headers: {}, body: '{"a":2}' },
  ];
  const script = P.buildPyScript(entries, "cookies.state.json");
  // 生成的脚本可编译(编译产物 __pycache__ 落在 WORK 临时目录, 不污染扩展根)
  const f = path.join(WORK, "_tmp.py");
  fs.writeFileSync(f, script, "utf-8");
  execSync(`python -m py_compile "${f.replace(/\\/g, "/")}"`, { shell: "bash" });
  // glob state: 生成的 find_state_file 必须能跑且能找到任意命名的 cookies*.state.json
  // (用只导出 build_session 逻辑的方式验证: import 脚本会真的发请求, 所以 sed 掉 main 调用)
  const stateDir = fs.mkdtempSync(path.join(WORK, "state_"));
  fs.writeFileSync(path.join(stateDir, "replay.py"),
    script.replace(`if __name__ == "__main__":\n    sys.exit(main())`, ""), "utf-8");
  // Cookie 桥导出的真实命名: cookies_<host>.state.json —— 不改名直接跑, 必须命中
  fs.writeFileSync(path.join(stateDir, "cookies_sub.example.com.state.json"),
    JSON.stringify({ cookies: [{ name: "SESSION", value: "abc", domain: ".example.com", path: "/" }] }), "utf-8");
  // exec() 里没有 __file__, 所以以 subprocess 方式跑一个只调 build_session 的驱动脚本
  fs.writeFileSync(path.join(stateDir, "drive.py"),
    `import os, sys\nsys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))\nimport replay\ns = replay.build_session()\nassert len(s.cookies) == 1, "cookie count"\n`, "utf-8");
  const runDrive = () => execSync(`python -X utf8 "${path.join(stateDir, "drive.py").replace(/\\/g, "/")}"`,
    { shell: "bash", encoding: "utf-8" });
  const out = runDrive();
  assert.ok(out.includes("已加载 1 个 Cookie"), "glob 应命中 cookies_*.state.json(不用改名): " + out);
  // 默认名也兼容(精确优先)
  fs.writeFileSync(path.join(stateDir, "cookies.state.json"),
    JSON.stringify({ cookies: [{ name: "X", value: "1", domain: ".t.com", path: "/" }] }), "utf-8");
  const out2 = runDrive();
  assert.ok(out2.includes("已加载 1 个 Cookie"), "精确名优先: " + out2);
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.unlinkSync(f);
  // def 与 main 调用一致(重名加后缀); v1.0.1 起带 ctx 参数池(AI 链共享);
  // v1.0.79 起 main 传 base_url 覆盖位(环境切换, None=各步默认 origin)
  const defs = [...script.matchAll(/def (step_\w+)\(/g)].map((m) => m[1]);
  const calls = [...script.matchAll(/^\s{4}(step_\w+)\(sess, ctx, base_url\)$/gm)].map((m) => m[1]);
  assert.deepStrictEqual(defs, calls, `def/call 应一致: ${defs} vs ${calls}`);
  assert.ok(script.includes("    base_url = None"), "main 应有 base_url 覆盖位(v1.0.79 环境切换)");
  // Cookie 值不泄漏进脚本(文档注释除外, 不应出现 Set-Cookie/secret 形态)
  assert.ok(!/cookie:\s*[A-Za-z0-9=_-]{10,}/i.test(script), "不应内联 Cookie 值");
  // 同名函数有 _2 后缀
  assert.ok(defs.some((d) => /_2$/.test(d)), "重名应有 _2 后缀: " + defs);
}

// ---------- 收尾: 扩展目录必须零 "_" 残留(Chrome 拒载下划线开头文件) ----------
fs.rmSync(WORK, { recursive: true, force: true });
for (const n of fs.readdirSync(__dirname)) {
  assert.ok(!/^_/.test(n), `扩展目录不应有下划线残留(Chrome 拒载): ${n}`);
}

// ---------- replay(链路重放/回归 diff) ----------
const RV = require("./replay.js");
{
  // normalizeForCompare: 毫秒时间戳与超长 token 归一, 业务值保留
  const tokR = "x".repeat(60), tokL = "y".repeat(60);
  const recorded = `{"ts":1789520000000,"name":"a","session":"${tokR}","price":12}`;
  const live     = `{"ts":1789520000500,"name":"a","session":"${tokL}","price":12}`;
  assert.strictEqual(RV.normalizeForCompare(recorded), RV.normalizeForCompare(live),
    "时间戳/长 token 应被归一, 业务值相同 → 归一后相等");
  const changed = '{"ts":1,"name":"b","price":99}';
  assert.notStrictEqual(RV.normalizeForCompare(recorded), RV.normalizeForCompare(changed),
    "业务值变化应保持差异");
  // verdict: 状态码一致 + 响应一致 → OK; 状态码变 → FAIL; 体差异 → DIFF; 0 → ERR
  const rec = { status: 200, response: '{"a":1}' };
  assert.strictEqual(RV.verdict(rec, { status: 200, ok: true, text: '{"a":1}' }).verdict, "OK");
  assert.strictEqual(RV.verdict(rec, { status: 500, ok: false, text: "err" }).verdict, "FAIL");
  assert.strictEqual(RV.verdict(rec, { status: 200, ok: true, text: '{"a":2}' }).verdict, "DIFF");
  assert.strictEqual(RV.verdict(rec, { status: 0, ok: false, text: "" }).verdict, "ERR");
  // AI 业务断言: 状态码 200 但响应含业务错误码 → 断言判 FAIL(不靠文本 diff)
  const asserts = [
    { type: "status", target: "200" },
    { type: "contains", target: '"resultCode":"0"' },
  ];
  assert.strictEqual(RV.verdict(rec, { status: 200, ok: true, text: '{"resultCode":"ISC-999"}' }, { asserts }).verdict, "FAIL");
  assert.strictEqual(RV.verdict(rec, { status: 200, ok: true, text: '{"resultCode":"0"}' }, { asserts }).verdict, "OK");
  // json_eq 断言: JSON 路径值精确匹配
  const je = [{ type: "json_eq", target: "data.rc", expect: "1" }];
  assert.strictEqual(RV.verdict(rec, { status: 200, ok: true, text: '{"data":{"rc":1}}' }, { asserts: je }).verdict, "OK");
  assert.strictEqual(RV.verdict(rec, { status: 200, ok: true, text: '{"data":{"rc":2}}' }, { asserts: je }).verdict, "FAIL");
}

// ---------- aireport ----------
const A = require("./aireport.js");
{
  const long = "A".repeat(60);
  const entries = [{
    method: "POST", url: "https://x.test.com/web/create?a=1",
    status: 200,
    headers: { Cookie: "SECRET", Authorization: "Bearer xyz", "x-gr-orgcode": "O1" },
    body: "token=" + long + "&ok=1",
    response: '{"data":{"session":"' + long + '"}}',
  }];
  const s = A.aiSanitizeEntry(entries[0]);
  const text = JSON.stringify(s);
  assert.ok(!text.includes("SECRET"), "Cookie 头永不外发");
  assert.ok(!text.includes("Bearer xyz"), "Authorization 头永不外发");
  assert.ok(!text.includes(long), "长 token 必须打码");
  assert.ok(text.includes("AAAAAAAA***MASKED***"), "打码保留前 8 位");
  // buildReportPrompt / buildDiagnosePrompt 可用且 prompt 内无泄漏
  const rp = JSON.stringify(A.buildReportPrompt(entries));
  assert.ok(!rp.includes("SECRET") && !rp.includes(long));
  // 耗时呈现(v1.0.58): 系统节要求 LLM 找"慢请求", 条目行必须带耗时数据 ——
  // aiSanitizeEntry 透传 durationMs, 有值时行内呈现 "· 耗时 Nms", 无值(旧数据/样本)不呈现不炸。
  const slowE = [{ method: "GET", url: "https://x.test.com/api/slow", status: 200, headers: {}, body: "", response: "", durationMs: 3200 }];
  const slowTxt = JSON.stringify(A.buildReportPrompt(slowE));
  assert.ok(slowTxt.includes("耗时 3200ms"), "报告 prompt 条目行应呈现耗时: " + slowTxt.slice(slowTxt.indexOf("[1]") - 20, slowTxt.indexOf("[1]") + 80));
  const noDurUser = A.buildReportPrompt([{ method: "GET", url: "https://x.test.com/api/x", status: 200, headers: {}, body: "", response: "" }]).find((m) => m.role === "user").content;
  assert.ok(!/耗时 \d+ms/.test(noDurUser), "无耗时条目行内不呈现耗时(旧数据兜底; 系统节的提示词不算)");
  assert.strictEqual(A.aiSanitizeEntry(slowE[0]).durationMs, 3200, "aiSanitizeEntry 透传 durationMs");
  // 诊断 prompt 耗时透传(v1.0.59): 失败请求"慢/超时"是常见根因 —— 时间线行带耗时,
  // LLM 才能判断"前面有个 8s 慢请求导致后面超时"类因果。主条目 + 上下文行都呈现。
  const slowCtx = { method: "POST", url: "https://x.test.com/api/upstream", status: 200, headers: {}, body: "", response: "", durationMs: 8000 };
  const dp2 = A.buildDiagnosePrompt(slowE[0], [slowCtx]);
  const dpTxt = JSON.stringify(dp2);
  assert.ok(dpTxt.includes("耗时 3200ms"), "诊断 prompt 主条目呈现耗时");
  assert.ok(dpTxt.includes("8000ms"), "诊断 prompt 时间线行呈现耗时(慢请求因果可判)");
  const dp = JSON.stringify(A.buildDiagnosePrompt(entries[0], [entries[0]]));
  assert.ok(!dp.includes("SECRET") && !dp.includes(long));
}

// ---------- 所见即所得: 过滤 + 截断语义(pure 函数级) ----------
{
  // buildReportPrompt 截断明示: 传 80 条, prompt 里必须明说"只取前 60"
  const many = Array.from({ length: 80 }, (_, i) => ({
    method: "GET", url: `https://x.test.com/api/${i}`, status: 200,
    headers: {}, body: "", response: "",
  }));
  const msgs = A.buildReportPrompt(many);
  const userContent = msgs.find((m) => m.role === "user").content;
  assert.ok(userContent.includes("只取前 60"), "超上限时 prompt 必须明示截断: " + userContent.slice(0, 120));
  assert.ok(!userContent.includes("/api/70"), "60 条之后不应出现");
  assert.ok(userContent.includes("/api/59"), "第 60 条应在");
}

// ---------- AI 参数依赖建链 + 接口文档 prompt ----------
{
  const chainSrc = [
    { method: "POST", url: "https://app.test.com/web/auth-server/login", path: "/web/auth-server/login", headers: {}, body: '{"user":"a"}', response: '{"data":{"token":"tk12345"}}', status: 200 },
    { method: "GET", url: "https://app.test.com/web/order/list?page=1", path: "/web/order/list", headers: { "X-Token": "tk12345" }, response: '{"data":{"list":[]}}', status: 200 },
  ];
  const cp = A.buildChainPrompt(chainSrc);
  const cpU = JSON.stringify(cp);
  assert.ok(cpU.includes("token"), "建链 prompt 应让 LLM 找 token 依赖");
  // extractChainJson: 容错代码块包裹
  const raw = A.extractChainJson('```json\n[{"from":0,"fromJsonPath":"data.token","to":1,"toParam":"header.X-Token","var":"token1","value":"tk12345"}]\n```');
  assert.ok(raw.length === 1 && raw[0].var === "token1", "应能解析 ```json 包裹的数组");
  // validateChain: 过滤非法项(自引用/缺字段/非数字), 且做 1-based→0-based 换算
  // (prompt 条目是 [1]..[n], AI 按它返回; 换算后应用层可直接当数组下标用)
  const good = A.validateChain([
    { from: 1, fromJsonPath: "data.token", to: 2, toParam: "header.X-Token", var: "token1", value: "x" },
    { from: 2, fromJsonPath: "x", to: 2, toParam: "y", var: "bad" },       // from===to → 丢弃
    { from: 1, to: 3, var: "nonum" },                                        // 缺 fromJsonPath, 但 var 有效 → 保留
    { from: "a", to: 2, var: "bad2" },                                        // from 非数字 → 丢弃
    { from: 0, to: 2, var: "bad3" },                                          // 0 非法(prompt 序号从 1 起) → 丢弃
    null,
  ]);
  assert.strictEqual(good.length, 2, "应保留 2 条合法链, 丢弃 4 条非法");
  assert.strictEqual(good[0].var, "token1");
  assert.strictEqual(good[0].from, 0, "1-based→0-based: from 1 应换算为下标 0");
  assert.strictEqual(good[0].to, 1, "1-based→0-based: to 2 应换算为下标 1");
  assert.strictEqual(good[1].to, 2, "from 1→to 3 换算为下标 2");
  // 接口文档 prompt
  const dp = A.buildDocPrompt(chainSrc);
  assert.ok(JSON.stringify(dp).includes("OpenAPI"), "文档 prompt 应要求 OpenAPI 风格");
}

// ---------- 内置 AI 技能(skill.js) + 新增 5 个 prompt builder ----------
{
  const S = require("./skill.js");
  const e1 = { method: "POST", url: "https://app.test.com/web/auth-server/login", path: "/web/auth-server/login", headers: { "X-Token": "tk" }, body: '{"user":"a","password":"pw123"}', response: '{"data":{"token":"tk12345"},"msg":"登录成功"}', status: 200 };
  const e2 = { method: "GET", url: "https://app.test.com/web/order/list?page=1", path: "/web/order/list", headers: {}, body: "", response: '{"data":{"list":[],"total":0},"ts":1789520000000}', status: 200 };

  // 1) skill 清单: 10 个, name/description 非空, buildPrompt 可调用, 与 aireport.js 导出函数对齐
  assert.strictEqual(S.BUILTIN_SKILLS.length, 10, `应内置 10 个 skill, 实际 ${S.BUILTIN_SKILLS.length}`);
  for (const sk of S.BUILTIN_SKILLS) {
    assert.ok(sk.name && typeof sk.name === "string", `skill.name 缺失: ${JSON.stringify(sk)}`);
    assert.ok(sk.description && typeof sk.description === "string", `skill.description 缺失: ${sk.name}`);
    assert.ok(typeof sk.buildPrompt === "function", `skill.buildPrompt 非函数: ${sk.name}`);
    assert.ok(["基础", "进阶"].includes(sk.category), `skill.category 非法: ${sk.name}`);
  }
  const names = new Set(S.BUILTIN_SKILLS.map((s) => s.name));
  assert.strictEqual(names.size, 10, "skill 名字不得重复");
  // getSkill 查找
  assert.strictEqual(S.getSkill("report").name, "report");
  assert.strictEqual(S.getSkill("nope"), null);

  // 2) 进阶 5 个 prompt builder: 返回 {role,content} 数组, system+user, 带数据卫生(不打 password/token 原文)
  const e1Long = { ...e1, body: '{"user":"a","token":"' + "A".repeat(60) + '"}' };
  const pf = A.buildPerfPrompt(e1Long, {
    concurrency: 5, total: 50, completed: 48, wallMs: 30000, rps: 1.6,
    success: 45, failed: 3, failRate: 6.25, p50: 120, p90: 400, p95: 800, p99: 1500, maxMs: 3200,
    errors: ["500", "500"],
  });
  assert.ok(pf.length === 2 && pf[0].role === "system" && pf[1].role === "user", "perf prompt 结构");
  const pfTxt = JSON.stringify(pf);
  assert.ok(pfTxt.includes("P99") && pfTxt.includes("吞吐"), "perf prompt 含分位数/吞吐");
  assert.ok(!pfTxt.includes("A".repeat(60)), "perf prompt 不应外发长 token 原文(脱敏后是 MASKED)");

  const dt = A.buildDiffTriagePrompt(e2, { ...e2, response: '{"data":{"list":[],"total":1},"ts":1789520005000}' });
  assert.ok(dt.length === 2 && dt[0].role === "system", "diffTriage prompt 结构");
  assert.ok(JSON.stringify(dt).includes("录制快照") && JSON.stringify(dt).includes("重放结果"), "diffTriage 应含两侧快照");

  const inv = A.buildInventoryPrompt([e1, e2]);
  assert.ok(inv.length === 2, "inventory prompt 结构");
  assert.ok(JSON.stringify(inv).includes("写/读"), "inventory 应要求写读标注");

  const sn = A.buildSensitiveScanPrompt([e1Long, e2]);
  assert.ok(sn.length === 2, "sensitive prompt 结构");
  assert.ok(JSON.stringify(sn).includes("身份证"), "sensitive 应识别身份证类型");
  assert.ok(JSON.stringify(sn).includes("处理建议"), "sensitive 应给处理动作指引(自查有出口)");
  assert.ok(!JSON.stringify(sn).includes("A".repeat(60)), "sensitive prompt 不应带长 token 原文(调用方已脱敏)");

  const sf = A.buildSessionFeaturePrompt([e1, e2], {
    hits: [{ method: "POST", path: "/web/auth-server/login", rule: "user context" }],
    misses: [e2],
  });
  assert.ok(sf.length === 2, "session prompt 结构");
  const sfTxt = JSON.stringify(sf);
  assert.ok(sfTxt.includes("会话失效") && sfTxt.includes("已识别为登录前置"), "session 应分析失效/登录特征");

  // 3) 每个内置 skill 的 buildPrompt 都能用默认参数调通(不炸)
  assert.ok(Array.isArray(S.getSkill("report").buildPrompt([e1, e2])), "report skill 可调");
  assert.ok(Array.isArray(S.getSkill("sensitive").buildPrompt([e1, e2])), "sensitive skill 可调");
  assert.ok(Array.isArray(S.getSkill("session").buildPrompt([e1, e2], { hits: [], misses: [e2] })), "session skill 可调");
  assert.ok(Array.isArray(S.getSkill("perf").buildPrompt(e1, { p50: 1, p90: 2 })), "perf skill 可调");
  assert.ok(Array.isArray(S.getSkill("diffTriage").buildPrompt(e2, e2)), "diffTriage skill 可调");
}

// ---------- 静态源码断言(deepseek-pp contract-smoke 模式, buildJmx 事故防回归) ----------
{
  // 1) sidepanel.html 的 script 加载顺序: 公共层在前, sidepanel.js 必须最后(它引用所有前置全局)
  const spHtml = fs.readFileSync(path.join(__dirname, "sidepanel/sidepanel.html"), "utf8");
  const order = [...spHtml.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
  assert.ok(order.length >= 8, `sidepanel 应有 8 个 script, 实际 ${order.length}: ${order}`);
  assert.strictEqual(order[order.length - 1], "sidepanel.js", "sidepanel.js 必须最后加载");
  assert.ok(order.indexOf("../common.js") < order.indexOf("../replay.js"), "common.js 在 replay.js 前");
  assert.ok(order.indexOf("../common.js") < order.indexOf("../jmx.js"), "common.js 在 jmx.js 前");

  // 2) 同页串联的顶层 const/let/function 撞名扫描 —— buildJmx is not defined 的根因防线:
  //    同页多个 <script> 共享全局作用域, 顶层 const 重声明在解析期抛 SyntaxError,
  //    整个后置文件静默不执行(函数全部 undefined)。
  const pages = [
    { name: "sidepanel", html: spHtml },
    { name: "popup", html: fs.readFileSync(path.join(__dirname, "popup/popup.html"), "utf8") },
    { name: "options", html: fs.readFileSync(path.join(__dirname, "options/options.html"), "utf8") },
  ];
  for (const p of pages) {
    const scripts = [...p.html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
    assert.ok(scripts.length > 0, `${p.name}.html 应至少加载一个 script`);
    const seen = { var: new Map(), let: new Map(), const: new Map(), function: new Map(), class: new Map() };
    for (const rel of scripts) {
      const file = path.join(__dirname, path.dirname(""), rel.startsWith("/") ? rel.slice(1) : path.join(p.name, rel));
      // sidepanel 的 ../common.js 指扩展根; 统一解析
      const abs = path.resolve(path.join(__dirname, p.name), rel);
      const src = fs.readFileSync(abs, "utf8");
      const base = path.basename(abs);
      // 顶层声明: 行首(无缩进)的 const/let(含 const a=1, b=2 多声明形态)。
      // 含 [({ 的行逗号语义不明(字面量内逗号), 只认首个声明名 —— 宁可漏报不误报。
      for (const line of src.split("\n")) {
        const dm = line.match(/^(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=/);
        if (!dm) continue;
        const kind = line.startsWith("const") ? "const" : "let";
        const names = [dm[1]];
        if (!/[[({]/.test(line)) {
          for (const n of line.matchAll(/,\s*([A-Za-z_$][\w$]*)\s*=/g)) names.push(n[1]);
        }
        for (const name of names) {
          if (seen[kind].has(name)) {
            assert.fail(`${p.name}: 顶层 ${kind} "${name}" 在 ${seen[kind].get(name)} 与 ${base} 重复声明 —— ` +
              `同页 script 共享全局作用域, 解析期 SyntaxError 会让 ${base} 整个不执行(buildJmx 事故同款)`);
          }
          seen[kind].set(name, base);
        }
      }
      for (const m of src.matchAll(/^function\s+([A-Za-z_$][\w$]*)/gm)) {
        const name = m[1];
        if (seen.function.has(name) && seen.function.get(name) !== base) {
          // function 跨文件重复: 后定义覆盖先定义, 不炸但易错 —— 也报
          assert.fail(`${p.name}: 顶层 function "${name}" 在 ${seen.function.get(name)} 与 ${base} 重复定义`);
        }
        seen.function.set(name, base);
      }
      for (const m of src.matchAll(/^class\s+([A-Za-z_$][\w$]*)/gm)) {
        const name = m[1];
        if (seen.class.has(name)) assert.fail(`${p.name}: 顶层 class "${name}" 重复`);
        seen.class.set(name, base);
      }
    }
  }

  // 3) 必需文件存在(打包缺文件的契约)
  for (const need of ["manifest.json", "background.js", "common.js", "auth.js", "correlate.js",
    "replay.js", "jmx.js", "pyscript.js", "aireport.js", "skill.js", "sidepanel/sidepanel.js",
    "sidepanel/sidepanel.html", "popup/popup.html", "popup/popup.js", "options/options.html",
    "options/options.js", "icons/icon128.png"]) {
    assert.ok(fs.existsSync(path.join(__dirname, need)), `必需文件缺失: ${need}`);
  }

  // 4) manifest 契约: sidepanel 打开方式 + 调试权限(buildJmx 事故后人工核对项固化)
  const mf = JSON.parse(fs.readFileSync(path.join(__dirname, "manifest.json"), "utf8"));
  assert.ok(mf.permissions.includes("debugger"), "录制引擎需要 debugger 权限");
  assert.ok(mf.permissions.includes("sidePanel"), "侧栏需要 sidePanel 权限");
  assert.ok(mf.permissions.includes("storage"), "需要 storage 权限");
  assert.strictEqual(mf.manifest_version, 3);
  assert.ok(!("devtools_page" in mf), "v0.3.1 已去 F12 化, 不应有 devtools_page");
}

console.log("ALL REGRESSION TESTS PASSED");
