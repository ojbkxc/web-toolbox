// check_aic3.js —— AI 关联接口(上下游参数链)新场景回归:
//   1. 表单体 k=v&k=v 注入(内网老系统大量 form-encoded POST)
//   2. fromJsonPath 数字下标(data.list.0.id)
//   3. 值提取失败(响应结构变) → 不注入 + missing 回执
//   4. 源在目标之后(倒序链) → 不注入 + missing 回执
//   5. 多级链 A→B→C: A 的值跨 B 仍存活
//   6. 注入回执 report(): applied/missing 内容
//   7. applyAiChainToJmx: from 挂 JSONPath 提取器 + to 替换 ${var}(query/body/header/路径段)
//   8. applyAiChainToJmx: 源不在集/倒序 → 跳过不改写
//   8b. 倒序链 JMX/PY 定位语义同拍(两导出器同规则跳过, 防跨工具链行为分叉)
const fs = require("fs");
const ROOT = require('path').resolve(__dirname, '..');
const vm = require("vm");
const path = require("path");
const P = require(ROOT + "/pyscript.js");

// applyAiChain 单源化(v1.0.89): 真身在根目录 aic.js(sidepanel.html <script> 同页加载),
// 不再用 $TEMP 手工镜像 —— 镜像无生成方, 漂移即测旧实现(原场景 10 的痛点, 单源后根除)。
const aicSrc = fs.readFileSync(ROOT + "/aic.js", "utf8");
const ctx = { console };
vm.createContext(ctx);
vm.runInContext(aicSrc, ctx);
vm.runInContext(`this.applyAiChain = applyAiChain;`, ctx);
if (typeof ctx.applyAiChain !== "function") { console.error("aic.js 加载失败"); process.exit(2); }

// common.js 的 applyAiChainToJmx(浏览器全局函数, 直接 new Script 加载进 realm)
const commonSrc = fs.readFileSync(ROOT + "/common.js", "utf8");
vm.runInContext(commonSrc, ctx);
if (typeof ctx.applyAiChainToJmx !== "function") { console.error("applyAiChainToJmx 未定义"); process.exit(2); }
// 场景 13 需要真实两级管线: applyCorr 依赖 correlate.js 的 applyDynamics(页面里同页
// 全局, vm 里也要先加载 correlate.js —— 否则 ReferenceError)
vm.runInContext(fs.readFileSync(ROOT + "/correlate.js", "utf8").split("if (typeof module")[0], ctx);
if (typeof ctx.applyCorr !== "function") { console.error("applyCorr 未定义(场景 13 前置)"); process.exit(2); }

let fails = 0;
const ok = (name, cond, got) => {
  if (!cond) { fails++; console.log("FAIL " + name + " → 实际: " + JSON.stringify(got)); }
  else console.log("  OK " + name);
};

// ---- 1. 表单体注入 ----
{
  const entries = [
    { id: "f0", url: "https://a/api/query", method: "POST", body: "{}", headers: {} },
    { id: "f1", url: "https://a/api/save", method: "POST", body: "orderId=OLD&remark=hi", headers: {} },
  ];
  const chain = [{ from: 0, fromId: "f0", fromJsonPath: "data.orderId", to: 1, toId: "f1", toParam: "orderId", var: "ord1" }];
  const rt = ctx.applyAiChain(entries, chain);
  rt.note(0, entries[0], JSON.stringify({ data: { orderId: "NO123" } }));
  const e = rt.inject(entries[1], chain);
  ok("表单体 orderId 注入", e.body === "orderId=NO123&remark=hi", e.body);
  const rep = rt.report();
  ok("回执 applied 含 ord1", rep.applied.length === 1 && rep.applied[0].includes("ord1"), rep.applied);
  ok("回执 missing 为空", rep.missing.length === 0, rep.missing);
}

// ---- 2. 数字下标提取 ----
{
  const entries = [
    { id: "g0", url: "https://a/api/list", method: "POST", body: "{}", headers: {} },
    { id: "g1", url: "https://a/api/save", method: "POST", body: '{"itemId":"OLD"}', headers: {} },
  ];
  const chain = [{ from: 0, fromId: "g0", fromJsonPath: "data.list.0.itemId", to: 1, toId: "g1", toParam: "itemId", var: "it1" }];
  const rt = ctx.applyAiChain(entries, chain);
  rt.note(0, entries[0], JSON.stringify({ data: { list: [{ itemId: "IDX9" }, { itemId: "XX" }] } }));
  const e = rt.inject(entries[1], chain);
  ok("data.list.0.itemId → 注入 IDX9(不是 XX)", e.body.includes('"itemId": "IDX9"'), e.body);
}

// ---- 3. 提取失败(路径不存在) → 不注入 + missing ----
{
  const entries = [
    { id: "h0", url: "https://a/api/query", method: "POST", body: "{}", headers: {} },
    { id: "h1", url: "https://a/api/save", method: "POST", body: '{"orderId":"OLD"}', headers: {} },
  ];
  const chain = [{ from: 0, fromId: "h0", fromJsonPath: "data.orderId", to: 1, toId: "h1", toParam: "orderId", var: "o1" }];
  const rt = ctx.applyAiChain(entries, chain);
  rt.note(0, entries[0], JSON.stringify({ data: { other: 1 } })); // 结构变, orderId 没了
  const e = rt.inject(entries[1], chain);
  ok("提取失败 body 保留原值", e.body === '{"orderId":"OLD"}', e.body);
  const rep = rt.report();
  ok("missing 报『没取到值』", rep.missing.length === 1 && rep.missing[0].includes("没取到值"), rep.missing);
}

// ---- 4. 倒序链(源在目标后) → 不注入 + missing ----
{
  const entries = [
    { id: "i1", url: "https://a/api/save", method: "POST", body: '{"orderId":"OLD"}', headers: {} },
    { id: "i0", url: "https://a/api/query", method: "POST", body: "{}", headers: {} },
  ];
  const chain = [{ from: 1, fromId: "i0", fromJsonPath: "data.orderId", to: 0, toId: "i1", toParam: "orderId", var: "o2" }];
  const rt = ctx.applyAiChain(entries, chain);
  rt.note(1, entries[1], JSON.stringify({ data: { orderId: "NEW" } }));
  const e = rt.inject(entries[0], chain);
  ok("倒序链不注入", e.body === '{"orderId":"OLD"}', e.body);
  ok("missing 报『源在目标之后』", rt.report().missing[0].includes("之后"), rt.report().missing);
}

// ---- 5. 多级链 A→B→C ----
{
  const entries = [
    { id: "j0", url: "https://a/login", method: "POST", body: "{}", headers: {} },
    { id: "j1", url: "https://a/query", method: "POST", body: '{"userId":"OLD"}', headers: {} },
    { id: "j2", url: "https://a/detail", method: "GET", query: "userId=OLD&x=1", url: "https://a/detail?userId=OLD&x=1", headers: {} },
  ];
  const chain = [
    { from: 0, fromId: "j0", fromJsonPath: "data.userId", to: 1, toId: "j1", toParam: "userId", var: "u1" },
    { from: 0, fromId: "j0", fromJsonPath: "data.userId", to: 2, toId: "j2", toParam: "url.userId", var: "u1" },
  ];
  const rt = ctx.applyAiChain(entries, chain);
  rt.note(0, entries[0], JSON.stringify({ data: { userId: "U77" } }));
  // 中间跑完 B(它也是 to, 不影响 A 的值存活)
  rt.note(1, entries[1], JSON.stringify({ ok: 1 }));
  const eB = rt.inject(entries[1], chain);
  const eC = rt.inject(entries[2], chain);
  ok("B 注入 U77", eB.body.includes('"userId": "U77"'), eB.body);
  ok("C 跨一条仍注入 U77(多级链)", eC.query === "userId=U77&x=1", eC.query);
}

// ---- 6. toParam 找不到参数名 → missing 上报 ----
{
  const entries = [
    { id: "k0", url: "https://a/api/query", method: "POST", body: "{}", headers: {} },
    { id: "k1", url: "https://a/api/save", method: "POST", body: '{"otherField":"x"}', headers: {} },
  ];
  const chain = [{ from: 0, fromId: "k0", fromJsonPath: "data.orderId", to: 1, toId: "k1", toParam: "orderId", var: "o3" }];
  const rt = ctx.applyAiChain(entries, chain);
  rt.note(0, entries[0], JSON.stringify({ data: { orderId: "N1" } }));
  const e = rt.inject(entries[1], chain);
  ok("参数名不在 body → body 原样", e.body === '{"otherField":"x"}', e.body);
  ok("missing 报『找不到该参数』", rt.report().missing[0].includes("找不到该参数"), rt.report().missing);
}

// ---- 7. applyAiChainToJmx: 提取器 + ${var} 替换 ----
{
  const entries = [
    { id: "m0", url: "https://a/api/query", method: "POST", body: "{}", headers: {} },
    { id: "m1", url: "https://a/api/save?ts=1", method: "POST", query: "ts=1", body: '{"orderNo":"OLD","x":2}', headers: {} },
    { id: "m2", url: "https://a/api/list2", method: "GET", query: "orderNo=OLD", headers: {} },
    { id: "m3", url: "https://a/detail/orderNo/OLD", method: "GET", query: "", headers: {} },
    { id: "m4", url: "https://a/api/h", method: "GET", query: "", headers: { "X-Token": "OLD" } },
  ];
  const chain = [
    { from: 0, fromId: "m0", fromJsonPath: "data.orderNo", to: 1, toId: "m1", toParam: "orderNo", var: "v1" },
    { from: 0, fromId: "m0", fromJsonPath: "data.orderNo", to: 2, toId: "m2", toParam: "url.orderNo", var: "v1" },
    { from: 0, fromId: "m0", fromJsonPath: "data.list.0.id", to: 3, toId: "m3", toParam: "url.orderNo", var: "v2" },
    { from: 0, fromId: "m0", fromJsonPath: "data.token", to: 4, toId: "m4", toParam: "header.X-Token", var: "v3" },
  ];
  const out = ctx.applyAiChainToJmx(entries, chain);
  const exs = out[0]._extractors || [];
  ok("m0 挂提取器 v1($.data.orderNo)", exs.some((x) => x.var === "v1" && x.expr === "$.data.orderNo"), exs);
  ok("m0 挂提取器 v2(数字下标转 [0])", exs.some((x) => x.var === "v2" && x.expr === "$.data.list[0].id"), exs);
  ok("m0 挂提取器 v3", exs.some((x) => x.var === "v3" && x.expr === "$.data.token"), exs);
  // 注: 当前实现 from 只挂一个提取器(同 from 多链时后者覆盖) —— 需要验证
  ok("m1 body orderNo → ${v1}", out[1].body.includes('"orderNo": "${v1}"'), out[1].body);
  ok("m2 query orderNo → ${v1}", out[2].query === "orderNo=${v1}", out[2].query);
  ok("m3 路径段 → ${v2}", out[3].url === "https://a/detail/orderNo/${v2}", out[3].url);
  ok("m4 header X-Token → ${v3}", out[4].headers["X-Token"] === "${v3}", out[4].headers);
}

// ---- 8. applyAiChainToJmx: 源不在集/倒序 → 跳过 ----
{
  const entries = [
    { id: "n1", url: "https://a/api/save", method: "POST", body: '{"orderNo":"OLD"}', headers: {} },
  ];
  const chain = [
    { from: 0, fromId: "nX", fromJsonPath: "data.orderNo", to: 0, toId: "n1", toParam: "orderNo", var: "z1" }, // 源不在集
    { from: 5, fromJsonPath: "data.orderNo", to: 0, toParam: "orderNo", var: "z2" }, // 下标越界(旧数据兜底也不在)
  ];
  const out = ctx.applyAiChainToJmx(entries, chain);
  ok("源不在集 → body 原样", out[0].body === '{"orderNo":"OLD"}', out[0].body);
  ok("无提取器挂上", out[0]._extractor === undefined, out[0]._extractor);
}

// ---- 8b. 倒序链(fi >= ti)跳过 + JMX/PY 定位语义同拍(v1.0.71, #165 方向①):
//    两导出器的链定位规则必须同语义(id 优先/下标兜底/不在集 -1/倒序跳过) ——
//    分叉 = 同一链在 JMX 里静默跳过、PY 里却生成注入, 用户跨工具链对照时
//    行为对不上。倒序形态两文件头注释都宣称"跳过"但此前零行为级断言。
{
  const revEntries = [
    { id: "r1", path: "/api/save", url: "https://a/api/save", method: "POST", body: '{"orderNo":"OLD"}', headers: {}, response: "{}", ts: "" },
    { id: "r0", path: "/api/login", url: "https://a/api/login", method: "POST", body: "{}", headers: {}, response: '{"data":{"orderNo":"L1"}}', ts: "" },
  ];
  const revChain = [{ from: 1, fromId: "r0", fromJsonPath: "data.orderNo", to: 0, toId: "r1", toParam: "orderNo", var: "rv" }];
  const jmxOut = ctx.applyAiChainToJmx(revEntries.map((e) => ({ ...e })), revChain);
  ok("JMX 倒序链 → to body 原样", jmxOut[0].body === '{"orderNo":"OLD"}', jmxOut[0].body);
  ok("JMX 倒序链 → from 无提取器", (jmxOut[1]._extractors || []).length === 0, jmxOut[1]._extractors);
  const pyOut = P.buildPyScript(revEntries.map((e) => ({ ...e })), "cookies.state.json", { aiChain: revChain });
  ok("PY 倒序链 → 无注入行", !/ctx\.get\("rv"\)/.test(pyOut), pyOut.match(/ctx\.get[^)]*\)/)?.[0]);
  ok("PY 倒序链 → 无提取行", !/ctx\["rv"\] = _val/.test(pyOut), pyOut.match(/ctx\["rv"\][^\n]*/)?.[0]);
}

// ---- 9. 回执串是 AI 产出 → sidepanel 拼进 innerHTML 前必须过 escHtml(源码契约, 防裸拼回归) ----
//    var/toParam/fromJsonPath 来自 LLM(可被录制内容 prompt 注入诱导), receiptNote 是
//    chainOut.innerHTML 的注入点之一 —— v1.0.16 修复的防回归断言。
{
  const spSrc = fs.readFileSync(ROOT + "/sidepanel/sidepanel.js", "utf8");
  // receiptNote 多行拼接块: 从赋值起点截到 missing.map 行尾(静态源码契约, 防裸拼回归)
  const at = spSrc.indexOf('receiptNote = "\\n== AI 参数链');
  ok("receiptNote 拼接块存在", at >= 0, "receiptNote 赋值起点");
  const block = at >= 0 ? spSrc.slice(at, spSrc.indexOf(";", spSrc.indexOf("rep.missing.map", at)) + 1) : "";
  ok("applied 串过 escHtml", block.includes("rep.applied.map((s) => `  ✅ ${escHtml(s)}`)"), block.slice(0, 120));
  ok("missing 串过 escHtml", block.includes("rep.missing.map((s) => `  ⚠ ${escHtml(s)}`)"), block.slice(0, 200));
}

// ---- 10. applyAiChain 单源防回潮(v1.0.89, 原镜像对拍演进): 函数真身已抽至根目录
//    aic.js(sidepanel.html <script> 同页加载, 本文件与 check_seq_link require 同一文件)。
//    历史: 原先是 $TEMP/aic.js 手工镜像对拍 —— 镜像无生成方, 丢失/漂移即测旧实现,
//    2026-10-16 TEMP 副本丢失致测试连红, 单源化根除。断言: ① sidepanel 不再内联定义
//    (防双源回潮) ② html 引用 aic.js ③ aic.js 可 require(真源可消费)。
{
  const spSrc = fs.readFileSync(ROOT + "/sidepanel/sidepanel.js", "utf8");
  ok("sidepanel 不再内联 applyAiChain 定义(单源, 防双源回潮)", !/function applyAiChain/.test(spSrc), spSrc.match(/function applyAiChain/)?.[0]);
  const html = fs.readFileSync(ROOT + "/sidepanel/sidepanel.html", "utf8");
  ok("sidepanel.html 引用 aic.js", /<script src="\.\.\/aic\.js">/.test(html), html.match(/aic\.js/)?.[0]);
  const aicReal = require(ROOT + "/aic.js");
  ok("aic.js 真 require 可用(测试/页面同一文件)", typeof aicReal.applyAiChain === "function", typeof aicReal.applyAiChain);
}

// ---- 11. JSON body 注入的反斜杠转义(v1.0.64, #157 方向①真 bug 修复): safeVal 只转义
//    引号时, 值里的字面 \(Windows 路径/正则串)产出非法转义 —— 重放端 JSON.parse 炸
//    (C:\U Bad escaped character)或语义被毁(\b 变退格符)。表单体分支无此面
//    (encodeURIComponent 兜住)。三分支(字符串值/裸值/含引号)round-trip 验证。
{
  const BS = String.fromCharCode(92);
  const run = (val, toParam, entryBody) => {
    const entries = [
      { id: "y0", url: "https://a/q", method: "POST", body: "{}", headers: {} },
      { id: "y1", url: "https://a/save", method: "POST", body: entryBody, headers: {} },
    ];
    const chain = [{ from: 0, fromId: "y0", fromJsonPath: "d.v", to: 1, toId: "y1", toParam, var: "v" }];
    const rt = ctx.applyAiChain(entries, chain);
    rt.note(0, entries[0], JSON.stringify({ d: { v: val } }));
    return rt.inject(entries[1], chain);
  };
  // 反斜杠值: 修复前 {"path": "C:\Users\x"} JSON.parse 炸
  const v1 = "C:" + BS + "Users" + BS + "x";
  const e1 = run(v1, "path", '{"path":"OLD"}');
  let p1 = null; try { p1 = JSON.parse(e1.body).path; } catch { /* 修复前走这 */ }
  ok("反斜杠值 round-trip(转义序: 先 \\ 后 \")", p1 === v1, e1.body);
  // 反斜杠+引号混合
  const v2 = "a" + BS + 'b"c';
  const e2 = run(v2, "path", '{"path":"OLD"}');
  let p2 = null; try { p2 = JSON.parse(e2.body).path; } catch { /* */ }
  ok("混合 \\ + \" round-trip", p2 === v2, e2.body);
  // 裸值分支同规则
  const e3 = run(v1, "n", '{"n":123}');
  let p3 = null; try { p3 = JSON.parse(e3.body).n; } catch { /* */ }
  ok("裸值分支 round-trip", p3 === v1, e3.body);
  // 表单体分支不受影响(编码兜底)
  const e4 = run(v1, "path", "path=OLD&z=1");
  ok("表单体分支 URL 编码兜底", e4.body === "path=C%3A%5CUsers%5Cx&z=1", e4.body);
}

// ---- 12. query/url 注入的保留字符编码(v1.0.64, #157 方向①): 注入值含 & = ? + / 时,
//    encodeURIComponent 必须把它们编码掉 —— 不编码会把 query 串撕裂成多个假参数
//    (userId=A&B=C 解析出 userId=A + 假键 B + 空值 C)或路径段逃逸。三个注入面:
//    条目 query 字段 / URL query / 路径段 /{k}/{v}。
{
  const run = (val, toParam, entry) => {
    const entries = [
      { id: "w0", url: "https://a/q", method: "POST", body: "{}", headers: {} },
      Object.assign({ id: "w1", method: "GET", headers: {} }, entry),
    ];
    const chain = [{ from: 0, fromId: "w0", fromJsonPath: "d.v", to: 1, toId: "w1", toParam, var: "v" }];
    const rt = ctx.applyAiChain(entries, chain);
    rt.note(0, entries[0], JSON.stringify({ d: { v: val } }));
    return rt.inject(entries[1], chain);
  };
  const val = "A&B=C";
  // 条目 query 字段面: 解析后必须还是单键
  const e1 = run(val, "userId", { query: "userId=OLD&x=1" });
  const ps = new URLSearchParams(e1.query);
  ok("query 字段注入: & = 编码掉, 不撕裂", ps.get("userId") === val && [...ps.keys()].length === 2 && ps.get("x") === "1", e1.query);
  // URL query 面
  const e2 = run(val, "url.userId", { url: "https://a/list?userId=OLD&x=1" });
  ok("URL query 注入: & = 编码掉", e2.url.endsWith("userId=A%26B%3DC&x=1"), e2.url);
  // 路径段面: / 编码掉, 不逃逸出段
  const e3 = run("x/y?z", "url.userId", { url: "https:/" + "/a/detail/userId/OLD" });
  ok("路径段注入: / ? 编码掉, 不逃逸", e3.url === "https:/" + "/a/detail/userId/x%2Fy%3Fz", e3.url);
}

// ---- 13. corr 时间戳参数化 + aiChain 占位符同 body 共存(v1.0.64, #158 方向①): JMX 导出
//    管线是 applyAiChainToJmx(applyCorr(cleanSet)) 两级 —— corr 先把时间戳换 \${__time()},
//    aiChain 后把业务参数换 \${var}, 同一 body 两个占位符互不干扰(各自只动匹配键)。
//    此前场景 7 只测 aiChain 单独应用, 两级串联的共存产物零断言 —— 管线顺序调整或
//    任一方的替换正则放宽(如 [^&]* 吃掉 })都会在这条链上炸。
{
  const entries = [
    { id: "z0", url: "https://x/q", path: "/q", method: "POST", body: "{}", headers: {} },
    { id: "z1", url: "https://x/save", path: "/save", method: "POST", body: '{"startTime":"1690000000000","orderId":"OLD"}', headers: {} },
  ];
  const corrResult = { groups: [{ method: "POST", path: "/save",
    dynamics: [{ path: "x.startTime", values: ["1690000000000"], replace: "${__time()}" }] }] };
  const chain = [{ from: 0, fromId: "z0", fromJsonPath: "d.v", to: 1, toId: "z1", toParam: "orderId", var: "ord" }];
  const out = ctx.applyAiChainToJmx(ctx.applyCorr(entries, corrResult), chain);
  ok("corr 时间戳 → ${__time()} 照常落位", out[1].body.includes('"startTime": "${__time()}"'), out[1].body);
  ok("aiChain 业务参数 → ${ord} 同 body 共存", out[1].body.includes('"orderId": "${ord}"'), out[1].body);
  ok("JSON 结构未被占位符破坏(键数不变)", Object.keys(JSON.parse(out[1].body.replace(/\$\{[^}]*\}/g, "0"))).length === 2, out[1].body);
}

// ---- 14. var 怪名的威胁模型记录(v1.0.64, #158 方向①评估关闭项): validateChain 只过滤
//    非字符串/空串, 不约束字符集 —— LLM 产出含空格/引号的 var 时, body 占位符 \${v 1"x}
//    在 JMeter 运行期函数解析失败。**非静默错**: JMeter 控制台直接报错, 用户可自定位;
//    而重放侧 applyAiChain.inject 无此面(var 只是 Map 键)。这里钉住"两消费面行为差异"
//    防未来误把 JMX 侧当静默错加过滤(过滤反而吞掉 JMeter 报错可见性)。
{
  const entries = [
    { id: "w0", url: "https://x/q", path: "/q", method: "POST", body: "{}", headers: {} },
    { id: "w1", url: "https://x/save", path: "/save", method: "POST", body: '{"orderId":"OLD"}', headers: {} },
  ];
  const chain = [{ from: 0, fromId: "w0", fromJsonPath: "d.v", to: 1, toId: "w1", toParam: "orderId", var: 'v 1"x' }];
  const out = ctx.applyAiChainToJmx(entries, chain);
  ok("怪名 var 原样落占位符(不过滤, JMeter 报错可见)", out[1].body === '{"orderId": "${v 1"x}"}', out[1].body);
  // 同一 chain 重放侧: var 是 Map 键, 怪名不炸
  const rt = ctx.applyAiChain(entries, chain);
  rt.note(0, entries[0], JSON.stringify({ d: { v: "NEW" } }));
  const e = rt.inject(entries[1], chain);
  ok("重放侧怪名 var 正常注入(两消费面行为差异)", JSON.parse(e.body).orderId === "NEW", e.body);
}

console.log(fails ? `=== FAIL ${fails} ===` : "=== aic 场景补全 PASS ===");
process.exit(fails ? 1 : 0);
