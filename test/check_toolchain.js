// check_toolchain.js —— test/lib/toolchain.js 自检:
//   1. checkXml 的接受面(真 JMX 产物 + 官方 jmx 样本)与拒绝面(未闭合/不配对/重复属性/
//      无引号属性/裸 &/多根/零根/裸 <) —— 它是"JMX 良构"这条断言的替身, 必须两侧都钉死,
//      否则校验器恒真 = 这条断言静默失效(比没测更糟)。
//   2. python 探测与 pyRun 的语义(有解释器真跑 6*7; 没有则显式 SKIP, 不算失败)。
//   3. waitHttp: 真服务返回 true, 关闭端口按 deadline 返回 false(不挂死)。
//   4. skip 记账: 打印 SKIP(env) 且计入 skipCount。
const path = require("path");
const fs = require("fs");
const http = require("http");
const assert = require("assert");
const ROOT = path.resolve(__dirname, "..");
const TC = require(path.join(__dirname, "lib", "toolchain.js"));
const J = require(path.join(ROOT, "jmx.js"));

let fails = 0;
const ok = (name, cond, got) => {
  if (!cond) { fails++; console.log("FAIL " + name + " → " + JSON.stringify(got)); }
  else console.log("  OK " + name);
};

(async () => {
  // ---------- 1. 接受面 ----------
  const jmx = J.buildJmx([
    { method: "GET", url: "https://a.test.com/x?p=1", path: "/x", query: "p=1", headers: { "x-a": "1" } },
    { method: "POST", url: "https://b.test.com/y", path: "/y", query: "", headers: { Cookie: "k=v&w=1" }, body: '{"q":"a&b<c>"}' },
  ]);
  const real = TC.checkXml(jmx);
  ok("真 buildJmx 产物良构", real.ok, real.error);
  ok("接受 XML 声明+注释+CDATA", TC.checkXml('<?xml version="1.0"?><!-- c --><r><![CDATA[ a<b&c ]]></r>').ok,
    TC.checkXml('<?xml version="1.0"?><!-- c --><r><![CDATA[ a<b&c ]]></r>').error);
  ok("接受合法实体引用", TC.checkXml('<r a="1 &amp; 2">&#65;&#x41;&lt;</r>').ok, TC.checkXml('<r a="1 &amp; 2">&#65;&#x41;&lt;</r>').error);
  ok("接受自闭合与单引号属性", TC.checkXml("<r><a b='1'/><c/></r>").ok, TC.checkXml("<r><a b='1'/><c/></r>").error);
  // 官方开源样本的 jmx 也要能过(不是只认自家产物): Apache JMeter 官方仓库导出的测试计划
  const sampleJmx = path.join(ROOT, "samples", "opensource", "apache-jmeter", "AuthManagerTestPlan.jmx");
  const r2 = TC.checkXml(fs.readFileSync(sampleJmx, "utf-8"));
  ok("官方 JMeter 测试计划良构(通用性)", r2.ok, r2.error);

  // ---------- 2. 拒绝面(每条都必须被抓到, 否则校验器形同虚设) ----------
  const bads = [
    ["未闭合标签", "<r><a></r>"],
    ["标签不配对", "<r><a></b></r>"],
    ["属性重复", '<r a="1" a="2"/>'],
    ["属性值无引号", "<r a=1/>"],
    ["裸 & 实体", "<r>a & b</r>"],
    ["多根元素", "<a/><b/>"],
    ["零根元素", "   "],
    ["文本裸 <", "<r>a < b</r>"],
    ["闭合标签多余", "<r></r></r>"],
    ["属性值裸 <", '<r a="x<y"/>'],
  ];
  for (const [name, src] of bads) {
    const r = TC.checkXml(src);
    ok("拒绝: " + name, r.ok === false && typeof r.error === "string", r);
  }

  // ---------- 3. python 探测 / pyRun ----------
  const py = TC.pythonBin();
  if (py) {
    ok("pythonBin 形态合法", typeof py.bin === "string" && Array.isArray(py.prefix), py);
    let out = "";
    try { out = TC.pyRun(["-c", "import sys; sys.stdout.write(str(6*7))"]); } catch (e) { out = "ERR " + e.message; }
    ok("pyRun 真跑(6*7=42)", String(out).trim() === "42", out);
    let threw = false;
    try { TC.pyRun(["-c", "raise SystemExit(3)"]); } catch { threw = true; }
    ok("pyRun 非零退出即抛错(不静默)", threw, threw);
  } else {
    TC.skip("python probe/pyRun", "未找到 python 3 解释器");
    ok("pythonBin 缺失时返回 null", py === null, py);
    let threw = false;
    try { TC.pyRun(["-c", "print(1)"]); } catch { threw = true; }
    ok("python 缺失时 pyRun 抛错(显式失败而非假装成功)", threw, threw);
  }

  // ---------- 4. waitHttp ----------
  const srv = http.createServer((req, res) => { res.writeHead(200); res.end("ok"); });
  const port = await new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));
  const up = await TC.waitHttp(`http://127.0.0.1:${port}/ping`, 4000);
  ok("waitHttp 真监听端口 → true", up === true, up);
  await new Promise((r) => srv.close(r));
  const t0 = Date.now();
  const down = await TC.waitHttp(`http://127.0.0.1:${port}/ping`, 700);
  ok("waitHttp 无监听 → false 且不超时太多", down === false && Date.now() - t0 < 4000, { down, ms: Date.now() - t0 });

  // ---------- 5. skip 记账 ----------
  const before = TC.skipCount();
  TC.skip("自检占位项", "本行由 check_toolchain 触发, 仅为验证记账");
  ok("skip 计数 +1", TC.skipCount() === before + 1, TC.skipCount());
  ok("skipSummary 带项名", TC.skipSummary().includes("自检占位项"), TC.skipSummary());

  console.log(fails ? `=== toolchain FAIL: ${fails} ===` : `=== toolchain PASS${TC.skipSummary()} ===`);
  process.exit(fails ? 1 : 0);
})();
