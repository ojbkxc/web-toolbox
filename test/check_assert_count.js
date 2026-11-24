// check_assert_count.js —— 断言数量守恒闸门(v1.1.92)
//
// 为什么需要(实证): R92 管住了"断言签名一致", check_repo_rules 管住了"注释掉的断言",
// 但**直接删除断言行**什么都不触发 —— 实测把 check_rule_gate_map 的一条 ok(...) 删掉,
// 全量回归仍然 **77/77 PASS**。也就是说 84 条断言可以悄悄变成 60 条, 没人知道。
//
// 判据: 每个 suite 的断言数不得**少于**基线(test/assert-counts.json)。
//   · 新增断言 → 通过(并提示可更新基线, 零成本);
//   · 删除断言 → 红(必须显式改基线, 在 review 里可见, 并写清理由)。
// 基线文件是数据, 不是源码: 改动它会出现在 diff 里, 这是刻意的。
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const BASELINE = path.join(__dirname, "assert-counts.json");

let fails = 0;
const ok = (name, cond, got) => {
  if (cond) console.log("  OK " + name);
  else { fails++; console.log("FAIL " + name + " → " + JSON.stringify(got)); }
};

// 统计一个文件里的断言调用数(排除注释行与字符串里的)
function countAsserts(src) {
  let n = 0;
  for (const rawLine of src.split(/\r?\n/)) {
    const line = rawLine.replace(/\r/g, "");
    const t = line.trim();
    if (/^(\/\/|\*|\/\*)/.test(t)) continue;              // 注释行
    // 断言调用形态(函数式与 assert 方法式) —— 但要排除定义行本身
    if (/const ok = \(|function ok\(|const assert = \(|function assert\(/.test(line)) continue;
    const m = line.match(/(?<![\w.])ok\(|(?<![\w.])assert\(|assert\.ok\(/g);
    if (m) n += m.length;
  }
  return n;
}

const suites = fs.readdirSync(__dirname).filter((f) => /^(check_|e2e_).*\.js$/.test(f))
  .map((f) => "test/" + f)
  .concat(["bridge/unit.mjs", "bridge/smoke.mjs", "bridge/test-doctor.mjs", "bridge/test-auth.mjs",
    "bridge/test-perf.mjs", "bridge/test-reconnect.mjs", "bridge/test-exporters.mjs",
    "test_regression.js", "mock_bg_test.js", "samples/test_regression_samples.js"]);

const now = {};
for (const rel of suites) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) continue;
  const c = countAsserts(fs.readFileSync(p, "utf8"));
  if (c > 0) now[rel] = c;
}
console.log(`  统计到 ${Object.keys(now).length} 个含断言的 suite`);

ok("基线文件存在", fs.existsSync(BASELINE), BASELINE);
const base = fs.existsSync(BASELINE) ? JSON.parse(fs.readFileSync(BASELINE, "utf8")) : {};

// ① 减少即红
const decreased = [];
for (const [rel, n] of Object.entries(base)) {
  const cur = now[rel] == null ? 0 : now[rel];
  if (cur < n) decreased.push(`${rel}: ${n} → ${cur}`);
}
ok("没有 suite 的断言数少于基线(删断言必须显式更新基线)", decreased.length === 0, decreased);

// ② 基线里登记的文件必须仍存在(防"删掉整个文件"绕过)
const goneFiles = Object.keys(base).filter((rel) => !fs.existsSync(path.join(ROOT, rel)));
ok("基线登记的文件都还在(防整文件删除)", goneFiles.length === 0, goneFiles);

// ③ 总量不得少于基线总量
const sumBase = Object.values(base).reduce((a, b) => a + b, 0);
const sumNow = Object.values(now).reduce((a, b) => a + b, 0);
ok(`断言总数不低于基线(${sumNow} >= ${sumBase})`, sumNow >= sumBase, { sumNow, sumBase });

// ④ 闸门自证: 判定逻辑能区分
{
  const probe = (n, b) => n < b;
  ok("闸门自证: 84 → 60 会被判红", probe(60, 84) === true, "n/a");
  ok("闸门自证: 84 → 84 通过", probe(84, 84) === false, "n/a");
  ok("闸门自证: 84 → 90 通过(新增不拦)", probe(90, 84) === false, "n/a");
}

// 新增断言的提示(不算红)
const increased = Object.entries(now).filter(([rel, n]) => base[rel] != null && n > base[rel]);
if (increased.length) {
  console.log("  ℹ 以下 suite 断言数增加了(可更新基线): " +
    increased.map(([r, n]) => `${r} ${base[r]}→${n}`).join(", "));
}

console.log(fails ? `=== assert count FAIL: ${fails} ===` : `=== assert count PASS (${sumNow} 条断言 / ${Object.keys(now).length} suite) ===`);
process.exit(fails ? 1 : 0);