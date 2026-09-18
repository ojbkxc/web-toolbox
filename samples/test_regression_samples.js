// samples/test_regression_samples.js — 样本库回归骨架。
// 用 samples/ 全部样本(known/ + opensource/) 对现有引擎(correlate/jmx)
// 跑回归, 验证"通用性" — 规则对开源/多样样本有效, 不只对自造 KTKI/ICS 样本。
// 用法: node samples/test_regression_samples.js
// 说明: 本测试只断言引擎能正确消化各形态样本, 不依赖真实网络请求。
const assert = require("assert");
const path = require("path");
const { loadAllSamples, splitUrl } = require("./loader.js");

const C = require(path.join(__dirname, "..", "correlate.js"));
const J = require(path.join(__dirname, "..", "jmx.js"));
const SAMPLES = path.join(__dirname);

// 汇总统计
let nSamples = 0, nEntries = 0, failures = [];

const samples = loadAllSamples(SAMPLES);

// ---------- 1. 每个样本都能被 analyzeCorrelation 消化(不炸) ----------
for (const s of samples) {
  nSamples++;
  nEntries += s.entries.length;
  try {
    const r = C.analyzeCorrelation(s.entries.map((e) => ({
      method: e.method, path: e.path, body: e.body,
    })));
    // 样本里有 >=2 条同接口时应该能 diff; 单条的不炸就行
    assert.ok(typeof r.summary === "number", "summary 应为数字");
  } catch (e) {
    failures.push(`${s.dir}: analyzeCorrelation 炸了: ${e.message}`);
  }
}

// ---------- 1b. meta.entries 与 loader 实际条目数对齐(v1.0.22 走查) ----------
// 元数据漂移会让清单表/INDEX 的计数失真 —— 曾经 apache-jmeter 声明 4 实载 3(写的是"文件数"),
// jmx-structure 声明 4 实载 23(loader 只读首个 jmx, 声明的是"结构特征数")。
// 对齐口径: entries = loader 加载出来的采样器/请求条数(0 也合法, 如 headless-recorder 空样本)。
for (const s of samples) {
  if (s.meta.entries !== s.entries.length) {
    failures.push(`${s.dir}: meta.entries=${s.meta.entries} != 实际加载 ${s.entries.length}`);
  }
}

// ---------- 2. 每个样本都能被 buildJmx 消化(不炸 + XML 合法) ----------
const fs = require("fs");
const os = require("os");
const { execSync } = require("child_process");
const WORK = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "webtoolbox_smpl_"));
for (const s of samples) {
  if (!s.entries.length) continue;
  // 结构样本(纯 jmx 结构, path 为相对/无 domain)不代表真实请求, 跳过导出校验
  if (!s.entries.every((e) => /^https?:/i.test(e.url))) {
    console.log(`  (skip buildJmx: ${s.dir} — 非绝对 URL)`);
    continue;
  }
  try {
    const jmx = J.buildJmx(s.entries.map((e) => ({
      method: e.method, url: e.url, path: e.path, query: e.query,
      headers: e.headers, body: e.body,
    })));
    const f = path.join(WORK, "x.jmx");
    fs.writeFileSync(f, jmx, "utf-8");
    const check = `python -c "import xml.dom.minidom,sys; xml.dom.minidom.parseString(open(sys.argv[1],encoding='utf-8').read())" "${f.replace(/\\/g, "/")}"`;
    execSync(check, { shell: "bash" });
  } catch (e) {
    failures.push(`${s.dir}: buildJmx 炸了: ${e.message}`);
  }
}
fs.rmSync(WORK, { recursive: true, force: true });

// ---------- 3. 认证形态识别断言(用样本的 meta.auth_form 校准规则) ----------
// 规则: 从 entries(url/body/headers/response) 判断认证形态 —— 这个断言直接喂给 P1 auth.js 的识别表。
// 这里先用"特征词在样本中能否命中"验证样本质量, 具体识别引擎在 P1 实现。
const AUTH_HINTS = {
  "cookie": ["cookie", "session", "jsessionid", "set-cookie"],
  "basic": ["authorization", "basic ", "user:passwd", "@httpbin"],
  "digest": ["authorization", "digest ", "digest-auth"],
  "token": ["authorization", "bearer", "token", "isc-token"],
  "jwt": ["bearer", "jwt"],
  "cas": ["ticket", "cas", "sso", "login/option"],
  "form": ["username", "password", "login", "x-www-form-urlencoded"],
};
function inferAuth(entries) {
  const hay = entries.map((e) => (e.url + " " + e.body + " " + JSON.stringify(e.headers) + " " + (e.response || "")).toLowerCase());
  const text = hay.join(" ");
  const hits = [];
  for (const [k, words] of Object.entries(AUTH_HINTS)) {
    if (words.some((w) => text.includes(w))) hits.push(k);
  }
  return hits;
}

// known 样本的预期形态(本地录制的已知值, 校验元数据与实际一致)
const knownExpect = {
  "known/ics_harvest": ["cookie", "token"],
  "known/ktki_detail": ["cookie", "cas"],
};
for (const s of samples) {
  if (!s.entries.length) continue;
  const rel = path.relative(SAMPLES, s.dir).replace(/\\/g, "/");
  if (knownExpect[rel]) {
    const hits = inferAuth(s.entries);
    for (const want of knownExpect[rel]) {
      if (!hits.includes(want)) {
        failures.push(`${rel}: 认证形态特征 "${want}" 在样本中缺失 (infer=${hits})`);
      }
    }
  }
}

// ---------- 4. 无认证样本不得误报登录 ----------
// blazedemo(公开下单流) 不应命中 cookie/token/auth 特征
const publicSamples = samples.filter((s) => /blazedemo/.test(s.dir));
for (const s of publicSamples) {
  const hits = inferAuth(s.entries);
  const falsePos = hits.filter((h) => ["cookie", "token", "basic", "digest", "cas"].includes(h));
  // blazedemo 可能命中 form(purchase.php 表单), 但绝不能命中 cookie/token
  assert.ok(falsePos.length === 0, `${s.dir}: 公开站误报认证形态: ${hits}`);
}

// ---------- 5. 动态值形态在样本中的可发现性(喂给 P2 溯源引擎) ----------
const DYNAMIC_RE = {
  "pickingId/orderNo": /\b(?:picking|order|orderNo|pickingId|objectId|warehouseId)\b/,
  "timestamp": /\b\d{13}\b/,
  "org上下文": /\b(?:divisionCode|orgCodes|orgCode|userId|userName|warehouseId)\b/,
};
for (const s of samples) {
  if (!s.entries.length) continue;
  const text = s.entries.map((e) => e.body + " " + (e.response || "")).join(" ");
  for (const [label, re] of Object.entries(DYNAMIC_RE)) {
    if (re.test(text)) {
      // 有动态值形态 -> 样本的 meta.dynamic_values 应该标注对应类别
      // 每个类别对应一组代表词; 只要 meta 里出现任意一个代表词即算覆盖
      const WORDS = {
        "pickingId/orderNo": ["pickingid", "orderno", "objectid", "warehouseid", "pickingorderno"],
        "timestamp": ["starttime", "timestamp", "ts"],
        "org上下文": ["orgcode", "orgcodes", "divisioncode", "userid", "username", "warehouseid"],
      };
      const metaVals = (s.meta.dynamic_values || []).join(",").toLowerCase();
      const covered = WORDS[label].some((w) => metaVals.includes(w));
      if (!covered) {
        failures.push(`${s.dir}: 检测到 ${label} 但 meta.dynamic_values 未标注对应词 (meta=${s.meta.dynamic_values})`);
      }
    }
  }
}

// ---------- 4c. auth.js autoDetectPrelude 的真实样本形态锚(v1.0.58) ----------
// v1.0.57 的重开窗口语义(中段登录链)只用过手造样本验证 —— 手造形态与引擎真实产出
// 漂移是本项目已实锤过的坑(SSE 死分支)。samples 库扫描: 3 个样本天然带中段登录链:
//   known/ics_harvest   条目5(getUserRole)在业务条目2-4之后 —— 真实 ICS UAT 录制序列
//   opensource/form-flow  条目3(/login 重登)在业务条目1-2之后
//   opensource/oauth2-authcode  条目4(/oauth/token 刷新)在业务条目2-3之后
// 锚住: 中段强特征条被重开识别 + 链外业务条不勾 + 公开站零误报。
{
  const AUTH2 = require(path.join(__dirname, "..", "auth.js"));
  const byDir2 = (re) => samples.filter((s) => re.test(s.dir));
  const idsOf = (s) => [...AUTH2.autoDetectPrelude(s.entries.map((e, i) => ({ ...e, id: i }))).ids];

  // ics_harvest: 真实 ICS UAT 登录链 —— 前缀 0,1 + 中段 5(getUserRole)被重开
  const icsIds = idsOf(byDir2(/ics_harvest/)[0]);
  assert.ok(icsIds.includes(0) && icsIds.includes(1), "ics_harvest: 前缀登录链识别(0,1)");
  assert.ok(icsIds.includes(5), "ics_harvest: 中段 getUserRole 被重开识别(v1.0.57 真实样本形态锚)");
  assert.ok(!icsIds.includes(2) && !icsIds.includes(3) && !icsIds.includes(4), "ics_harvest: 业务条(2,3,4)不被误勾");

  // form-flow: 表单重登(条目3 /login)在业务(1,2)后 —— form login 不在强特征集,
  // 但它前面的重开窗口由谁触发? 实测: /login 命中 form login(宽正则)本应不重开……
  // 该样本 /login 同时命中 CAS/SSO 的 /login\b 正则(强特征) —— 双规则命中, 强特征赢, 重开成立。
  const ffIds = idsOf(byDir2(/form-flow/)[0]);
  assert.ok(ffIds.includes(0) && ffIds.includes(3), "form-flow: 首次登录 + 中段重登(强特征 CAS/SSO 命中)被识别");
  assert.ok(!ffIds.includes(1) && !ffIds.includes(2), "form-flow: 业务条(1,2)不勾");

  // oauth2: 中段 /oauth/token 刷新(条目4)被重开; code 是业务参数不是登录
  const oaIds = idsOf(byDir2(/oauth2-authcode/)[0]);
  assert.ok(oaIds.includes(0) && oaIds.includes(1), "oauth2: 前缀 authorize+token 链识别");
  assert.ok(oaIds.includes(4), "oauth2: 中段 token 刷新被重开识别(OAuth/token 强特征)");
  assert.ok(!oaIds.includes(2) && !oaIds.includes(3) && !oaIds.includes(5), "oauth2: 业务条(2,3,5)不勾");

  // blazedemo: 公开站零登录链 —— 误报防线(手造样本 6b 的真实样本对照)
  const bdIds = idsOf(byDir2(/blazedemo/)[0]);
  assert.ok(bdIds.length === 0, "blazedemo: 公开站零前置识别(不误报)");
}

// ---------- 4b. 三个形态样本的引擎识别断言(UUID/签名/OAuth2, v1.0.18) ----------
// 样本只"不炸"是弱断言 —— 每个样本要在引擎上有确定产出(dyn 分类/溯源链), 否则退化成摆设。
{
  const byDir = (re) => samples.filter((s) => re.test(s.dir));
  const corrOf = (s) => C.analyzeCorrelation(s.entries.map((e) => ({ method: e.method, path: e.path, body: e.body, response: e.response })));
  const linkOf = (s) => C.linkSeqDynamics(s.entries, corrOf(s), []);

  // UUID: petId 归 seq(UUID 正则), 且溯源挂上(petId 值在更早 create 响应里)
  const [uuidS] = byDir(/git-apikey/);
  const uuidDyn = corrOf(uuidS).groups.flatMap((g) => g.dynamics).filter((d) => d.path === "petId");
  assert.ok(uuidDyn.length === 1 && uuidDyn[0].classify.kind === "seq", "git-apikey: petId 应归 seq(UUID 正则)");
  assert.ok(/UUID/.test(uuidDyn[0].classify.note || ""), "git-apikey: petId 分类 note 应标注 UUID");
  assert.ok(linkOf(uuidS).some((l) => l.fromJsonPath === "id" && l.toParam === "petId"),
    "git-apikey: petId 应溯源到 create 响应的 id");

  // 签名: sign 命中命名启发式 seq; timestamp 类不溯源; orderNo 溯源成立
  const [signS] = byDir(/httpbin-signed/);
  const signDyn = corrOf(signS).groups.flatMap((g) => g.dynamics);
  assert.ok(signDyn.some((d) => /sign/i.test(d.path) && d.classify.kind === "seq"), "httpbin-signed: sign 命名启发式应命中 seq");
  const signLinks = linkOf(signS);
  assert.ok(signLinks.some((l) => l.toParam === "orderNo" && l.fromJsonPath === "data.orderNo"),
    "httpbin-signed: orderNo 应溯源到 create 响应");
  assert.ok(!signLinks.some((l) => /sign/i.test(l.toParam) || /nonce/i.test(l.toParam)),
    "httpbin-signed: sign/nonce 不得误挂链(上游响应无同值叶, 落空即保守)");

  // OAuth2: access_token 命中 token 命名启发式 seq 且溯源到 /oauth/token 响应; code 落 fixed 不误报
  const [oaS] = byDir(/oauth2-authcode/);
  const oaDyn = corrOf(oaS).groups.flatMap((g) => g.dynamics);
  assert.ok(oaDyn.some((d) => d.path === "access_token" && d.classify.kind === "seq"), "oauth2: access_token 命名启发式应命中 seq");
  assert.ok(oaDyn.some((d) => d.path === "code" && d.classify.kind === "fixed"), "oauth2: code 无归(单次有效)应落 fixed 不误报");
  assert.ok(linkOf(oaS).some((l) => l.fromJsonPath === "access_token" && l.toParam === "access_token"),
    "oauth2: access_token 应溯源到 token 响应");

  // 表单体(v1.0.18 缺口收口): order/create 表单组 diff 出 sessionid(seq) 且溯源挂上 login 响应;
  // login 组 body 全静态 → 无动态(不误报); applyDynamics 表单 k=v 替换 + jsonPathGet 表单取值闭环
  const [ffS] = byDir(/form-flow/);
  const ffDyn = corrOf(ffS).groups.flatMap((g) => g.dynamics);
  assert.ok(ffDyn.some((d) => d.path === "sessionid" && d.classify.kind === "seq"), "form-flow: 表单 sessionid 应 diff 出并归 seq");
  assert.ok(ffDyn.every((d) => d.path !== "username" && d.path !== "password" && d.path !== "product" && d.path !== "quantity"),
    "form-flow: 表单静态字段不得误报动态");
  assert.ok(!corrOf(ffS).groups.some((g) => g.path === "/login" && g.dynamics.length), "form-flow: login 组 body 全静态应零动态");
  const ffLinks = linkOf(ffS);
  assert.ok(ffLinks.some((l) => l.fromJsonPath === "data.sessionid" && l.toParam === "sessionid"),
    "form-flow: 表单 sessionid 应溯源到 login 响应");
  const ffApplied = C.applyDynamics(ffS.entries[4].body, ffDyn.filter((d) => d.path === "sessionid"));
  assert.ok(ffApplied.includes("SESS-D4E5F6"), "form-flow: applyDynamics 表单体应保原值(无 replace 时)");
  const tsDyn = [{ path: "sessionid", values: ["SESS-A1B2C3", "SESS-D4E5F6"], replace: "${SESS}" }];
  assert.ok(C.applyDynamics("sessionid=SESS-D4E5F6&product=book", tsDyn).includes("sessionid=${SESS}"),
    "form-flow: applyDynamics 表单 k=v 应替换成 ${var}");
}

// ---------- 4e. SSE 净化判定的真实样本锚(v1.0.65, #158 方向②) ----------
// v1.0.56 修过 SSE 死分支(旧行只查 headers, 引擎产出的真实条目信号在响应 mime), 但此后
// samples 维度零回归 —— loader 连 mime 字段都不读, 样本即使标注也进不了断言。补 mime 透传 +
// SSE 真实端点样本(oreilly-eventsource, mime 主信号)后, 锚住三断言:
//   SSE 条(mime=text/event-stream, 请求头仅 Accept 无 Content-Type)被剔除;
//   API JSON 业务条(mime=application/json)同批不误杀;
//   全样本扫描: 除该样本外任何条目不因 mime/headers 误命中 SSE 分支(存量样本零污染)。
{
  const CM2 = require(path.join(__dirname, "..", "common.js"));
  const [sseS] = samples.filter((s) => /eventsource/.test(s.dir));
  assert.ok(sseS && sseS.entries.length === 3, "oreilly-eventsource: 样本 3 条加载齐");
  const sseHit = sseS.entries.filter((e) => CM2.isSkippable(e));
  assert.ok(sseHit.length === 1 && sseHit[0].path === "/api/sse/stream",
    "eventsource: 仅 SSE 条被 isSkippable 命中(mime 主信号, 请求头表无响应 Content-Type): "
    + JSON.stringify(sseHit.map((e) => e.path)));
  const { entries: keptS, dropped } = CM2.filterSkippable(sseS.entries);
  assert.ok(dropped === 1 && keptS.length === 2, `eventsource: filterSkippable 剔 1 留 2(实得 dropped=${dropped} kept=${keptS.length})`);
  assert.ok(keptS.every((e) => e.mime === "application/json" && !CM2.isSkippable(e)),
    "eventsource: API JSON 业务条同批不误杀");
  // 存量样本零污染: 其他样本任何条目不命中 SSE 分支(命中即说明 isSkippable 的 SSE 判定扩张了)
  for (const s of samples) {
    if (/eventsource/.test(s.dir)) continue;
    for (const e of s.entries) {
      const sseLike = Object.entries(e.headers || {}).some(([k, v]) =>
        k.toLowerCase() === "content-type" && String(v).toLowerCase().includes("text/event-stream"))
        || String(e.mime || "").toLowerCase().includes("text/event-stream");
      assert.ok(!sseLike, `${s.dir}: 存量条目不得命中 SSE 判定(${e.path})`);
    }
  }
}

// ---------- 4f. loader readJmx 反转义 roundtrip(v1.0.70, #163 方向②) ----------
// readJmx 的 path/domain 提取此前不做 XML 反转义 —— 自家 buildJmx 的 path 经 xmlEsc
// (多参数 query 的 & 变 &amp;), 回读时 query 被污染成 'page=2&amp;size=10'。
// roundtrip 锚: 生成面 buildJmx → 读取面 readJmx, path/query/body 三要素回读一致。
{
  const mkE = (id, method, url, extra) => Object.assign({ id, method, url, path: new URL(url).pathname, query: "", headers: {}, body: "", status: 200, response: "", mime: "application/json", ts: "2026-09-17T00:00:00Z" }, extra);
  const es = [
    mkE(1, "GET", "https://app.test.com/order/list?page=2&size=10", { query: "page=2&size=10" }),
    mkE(2, "POST", "https://h.com/a", { body: '{"k":"v&<w>"}' }),
  ];
  const WORK2 = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "webtoolbox_rt_")); // 节 2 的 WORK 已 rmSync
  try {
    const f = path.join(WORK2, "roundtrip.jmx");
    fs.writeFileSync(f, J.buildJmx(es, {}));
    const back = JSON.parse(JSON.stringify(require("./loader.js").readJmx(f)));
    assert.ok(back.length === 2, `roundtrip: 回读 2 条(实得 ${back.length})`);
    assert.ok(back[0].path === "/order/list" && back[0].query === "page=2&size=10",
      `roundtrip: path/query 反转义回读一致(实得 ${back[0].path} ? ${back[0].query})`);
    assert.ok(back[1].body === '{"k":"v&<w>"}', `roundtrip: body XML 实体反转义一致(实得 ${back[1].body})`);
    // 4f2) 变量化 domain 回读分支(v1.0.79): buildJmx 的采样器 domain 已是 ${HOST_n},
    //      readJmx 若走 new URL 解析, node 会把 '${HOST_1}/order' 当 hostname 拆出
    //      (实测), path/query 全污染。断言: 变量分支下 path/query 用采样器自己的值。
    assert.ok(back[0].url === "https://${HOST_1}/order/list?page=2&size=10",
      `roundtrip: 变量化 domain 保留变量串原样(实得 ${back[0].url})`);
    assert.ok(back[0].path === "/order/list" && back[0].query === "page=2&size=10",
      `roundtrip: 变量化分支 path/query 不被 URL 伪解析污染(实得 ${back[0].path} ? ${back[0].query})`);
    // 4f3) 变量分支怪形态边界(v1.0.79): 生态里 domain 还有部分引用(api.${ENV}.com)、
    //      __P 函数、空变量形态 —— 部分引用不触发变量分支走 splitUrl(实测 node URL
    //      恰好不炸但 hostname 被拆错), 路径语义兜底不破坏: path/query 依然取采样器原值。
    {
      const mkCase = (domain) => `<?xml version="1.0"?><jmeterTestPlan><hashTree><HTTPSamplerProxy testname="t"><elementProp name="HTTPsampler.Arguments"/><stringProp name="HTTPSampler.domain">${domain}</stringProp><stringProp name="HTTPSampler.protocol">https</stringProp><stringProp name="HTTPSampler.path">/a?x=1&amp;y=2</stringProp><stringProp name="HTTPSampler.method">GET</stringProp></HTTPSamplerProxy><hashTree/></hashTree></jmeterTestPlan>`;
      const f2 = path.join(WORK2, "var_case.jmx");
      fs.writeFileSync(f2, mkCase("api.${ENV}.com"), "utf-8");
      const bPartial = require("./loader.js").readJmx(f2);
      assert.ok(bPartial[0].path === "/a" && bPartial[0].query === "x=1&y=2",
        `roundtrip: 部分引用 domain 的 path/query 兜底正确(实得 ${bPartial[0].path} ? ${bPartial[0].query})`);
      fs.writeFileSync(f2, mkCase("${__P(host,localhost)}"), "utf-8");
      const bP = require("./loader.js").readJmx(f2);
      assert.ok(bP[0].path === "/a" && bP[0].query === "x=1&y=2",
        `roundtrip: __P 函数 domain 走变量分支(path/query 原样, 实得 ${bP[0].path} ? ${bP[0].query})`);
      fs.unlinkSync(f2);
    }
  } finally {
    fs.rmSync(WORK2, { recursive: true, force: true });
  }
}

// ---------- 输出 ----------
console.log(`样本库回归: ${nSamples} 个样本 / ${nEntries} 条请求`);
if (failures.length) {
  console.log(`失败 ${failures.length} 项:`);
  for (const f of failures) console.log("  ✗ " + f);
  process.exit(1);
}
console.log("ALL SAMPLE REGRESSION TESTS PASSED");