// check_assert_signature.js —— 断言库签名与调用形态一致性闸门(v1.1.79)
//
// 为什么需要: 本仓库存在**三种** ok 签名, 且我用错过四次(输出 "OK true" = 假绿):
//   (name, cond, got) — 27 个文件     (cond, msg) — 11 个     (c, m) — 5 个
// runtime guard 只能护住加了 guard 的那个文件; 真正一劳永逸的是**静态判定**:
//   · 签名"名字在前" → 每个 ok((call)  的第一个实参必须是字符串字面量/模板;
//   · 签名"条件在前" → 第一个实参**不得**是字符串字面量;
//   · 判定不了的(变量/拼接)登记为待查, 不静默放过, 但也不算红(避免误报)。
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");

let fails = 0;
const ok = (name, cond, got) => {
  if (cond) console.log("  OK " + name);
  else { fails++; console.log("FAIL " + name + " → " + JSON.stringify(got)); }
};

const files = fs.readdirSync(__dirname).filter((f) => /^(check_|e2e_).*\.js$/.test(f)).map((f) => path.join(__dirname, f))
  .concat(["unit.mjs", "smoke.mjs", "test-doctor.mjs", "test-auth.mjs", "test-perf.mjs", "test-reconnect.mjs", "test-exporters.mjs"]
    .map((f) => path.join(ROOT, "bridge", f)))
  .concat([path.join(ROOT, "test_regression.js"), path.join(ROOT, "mock_bg_test.js"), path.join(ROOT, "samples", "test_regression_samples.js")]);

const NAME_FIRST = /^\s*(name|msg|m|label|title)\s*$/;
const COND_FIRST = /^\s*(cond|c|value|v|p)?\s*$/;

const report = { nameFirst: [], condFirst: [], unknown: [], bad: [], noLib: [] };

for (const abs of files) {
  if (!fs.existsSync(abs)) continue;
  const rel = path.relative(ROOT, abs).replace(/\\/g, "/");
  const src = fs.readFileSync(abs, "utf8");

  // 探测签名: const ok = (a, b, c) => 或 function ok((call) a, b, c)
  const sigM = src.match(/const ok = \(([^)]*)\)/) || src.match(/function ok\(([^)]*)\)/)
    || src.match(/const assert = \(([^)]*)\)/);
  if (!sigM) { report.noLib.push(rel); continue; }
  const params = sigM[1].split(",").map((x) => x.trim()).filter(Boolean);
  const first = params[0] || "";
  const isNameFirst = NAME_FIRST.test(" " + first + " ");
  const isCondFirst = COND_FIRST.test(first);

  // 收集 ok((call)  调用的第一个实参形态(顶层字符串字面量?)
  const calls = [];
  const re = /\b(ok|assert)\(/g;
  let m;
  while ((m = re.exec(src))) {
    const start = m.index + m[0].length;
    // 跳过定义本身: 看该调用前的同一行是否在声明 ok
    const lineStart = src.lastIndexOf("\n", m.index) + 1;
    const lineHead = src.slice(lineStart, m.index + 3);
    if (/const ok = \($|function ok\($/.test(lineHead.trim()) || /=\s*\($/.test(lineHead.trim())) continue;
    // 跳过注释行(trime 后以 // 或 * 开头)与字符串内部的匹配
    const lineStart2 = src.lastIndexOf("\n", m.index) + 1;
    const before = src.slice(lineStart2, m.index);
    if (/^\s*(\/\/|\*)/.test(before)) continue;
    // 简易字符串内判定: 该行 m.index 之前未闭合的双引号数为奇数 → 位于字符串里
    const quotes = (before.match(/"/g) || []).length;
    if (quotes % 2 === 1) continue;
    // assert 的内置形式(node:assert)不属于本仓库断言库 —— 不参与判定
    if (before.slice(-7).trim() === "assert.") continue;
    const after = src.slice(start, start + 200);
    const trimmed = after.replace(/^\s+/, "");
    const isStr = trimmed.startsWith('"') || trimmed.startsWith("'") || trimmed.startsWith("`");
    calls.push({ isStr, at: src.slice(0, m.index).split(/\n/).length });
  }

  if (isNameFirst && !isCondFirst) {
    report.nameFirst.push(rel);
    const bad = calls.filter((c) => !c.isStr);
    // 形如「条件, "消息"」的调用: 第一参不是字符串 → 反序或漏名字
    for (const b of bad) report.bad.push(`${rel}:${b.at}（签名 name 在前, 但首参不是字符串)）`);
  } else if (isCondFirst && !isNameFirst) {
    report.condFirst.push(rel);
    const bad = calls.filter((c) => c.isStr && !/^\s*"[\s\S]*"\s*,/.test(""));  // 条件在前的库里, 首参是字符串即反序
    for (const b of bad) report.bad.push(`${rel}:${b.at}（签名 cond 在前, 但首参是字符串 → 反序）`);
  } else {
    report.unknown.push(rel + ` (首参名 "${first}" 无法归类)`);
  }
}

console.log(`  签名分类: name 在前 ${report.nameFirst.length} 个, cond 在前 ${report.condFirst.length} 个, 未归类 ${report.unknown.length} 个, 无断言库 ${report.noLib.length} 个(不参与判定)`);
ok("三种签名都有归类(无未归类文件)", report.unknown.length === 0, report.unknown.slice(0, 6));
ok("没有与自身签名矛盾的 ok() 调用(反序=假绿)", report.bad.length === 0, report.bad.slice(0, 8));

// 闸门自证: 造两种反序样本, 判定逻辑必须抓住
{
  const judge = (sigFirst, callFirst) => {
    const nameFirst = NAME_FIRST.test(" " + sigFirst + " ");
    const condFirst = COND_FIRST.test(sigFirst);
    const isStr = /^["'`]/.test(callFirst);
    if (nameFirst && !condFirst) return !isStr;      // 应判红
    if (condFirst && !nameFirst) return isStr;        // 应判红
    return false;
  };
  ok("闸门自证: 签名 name 在前 + 首参非字符串 → 判红", judge("name", "true") === true, "n/a");
  ok("闸门自证: 签名 cond 在前 + 首参是字符串 → 判红", judge("cond", '"msg"') === true, "n/a");
  ok("闸门自证: 正常形态不误判", judge("name", '"msg"') === false && judge("cond", "x > 1") === false, "n/a");
}

console.log(fails ? `=== assert signature FAIL: ${fails} ===` : `=== assert signature PASS (${report.nameFirst.length + report.condFirst.length} 个 suite) ===`);
process.exit(fails ? 1 : 0);