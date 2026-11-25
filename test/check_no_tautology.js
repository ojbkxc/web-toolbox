// check_no_tautology.js —— 断言恒真兜底闸门(v1.3.3)
//
// 为什么需要(实证): v1.3.3 全仓扫 `test/` 发现两处断言挂着恒真兜底 ——
//   test/check_doc_counts.js:137  `(...|| true)` 包着 troubleshooting doctor 项数检查
//   test/check_replay_smoke.js:30 `(... === false || true)` 包着超时文案检查
// 两条都用 node -e 直接求值验证过: **传入不匹配的输入仍返回 true**, 即断言永不失败。
// 根因不是笔误而是放水: 断言条件写错了(把超时文案里的 `0s` 当成不该出现的串),
// 于是加 `|| true` 压绿, 而不是修断言 —— 这正是 AGENTS §1.2 明令禁止的形态。
//
// 判据: 断言调用(ok/assert/assert.ok)的实参里不许出现恒真兜底
//   `|| true` / `|| 1` / `|| !!1` / `|| Boolean(1)`
// 这类兜底让断言失去判定力, 而 check_assert_count 只数条数、check_assert_signature 只看签名,
// 都拦不住"条数没少但内容已被架空"。
//
// 自证: 两条(能识别违规形态 / 正常断言不误报), 防止闸门自身退化成摆设。
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");

let fails = 0;
const ok = (name, cond, got) => {
  if (cond) console.log("  OK " + name);
  else { fails++; console.log("FAIL " + name + " → " + JSON.stringify(got)); }
};

// 恒真兜底形态 —— 用拼接构造, 避免本文件自身的字符串命中(它是扫描器, 不是被测代码)。
// 注意: 管道符必须转义成 `\|` —— 直接用 `||` 在正则里是「空分支」, 会匹配一切(实测踩过)。
const BAR = "\\|" + "\\|";
const TAUT = [
  new RegExp(BAR + "\\s*true\\b", "g"),
  new RegExp(BAR + "\\s*1\\s*(?=[,)])", "g"),
  new RegExp(BAR + "\\s*!!\\s*1\\b", "g"),
  new RegExp(BAR + "\\s*Boolean\\s*\\(\\s*1\\s*\\)", "g"),
];
// 断言调用头(与 check_assert_count 同口径: 函数式 ok/assert 与 assert.ok)
const ASSERT_HEAD = /(?<![\w.])ok\(|(?<![\w.])assert\(|assert\.ok\(/;

// 扫描面: 全部测试代码(test/ 下的 js + 仓库根两个回归 + samples + bridge 的 mjs)
const files = [];
for (const dir of ["test", "bridge", "samples"]) {
  const p = path.join(ROOT, dir);
  if (!fs.existsSync(p)) continue;
  for (const f of fs.readdirSync(p)) {
    if (/\.(js|mjs|cjs)$/.test(f)) files.push(path.join(p, f));
  }
}
for (const f of ["test_regression.js", "mock_bg_test.js"]) {
  const p = path.join(ROOT, f);
  if (fs.existsSync(p)) files.push(p);
}

const hits = [];
for (const p of files) {
  // 跳过本文件(扫描器里有形态字面量, 会被自己命中)
  if (path.basename(p) === "check_no_tautology.js") continue;
  const lines = fs.readFileSync(p, "utf8").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue; // 注释行
    let taut = false;
    for (const re of TAUT) { re.lastIndex = 0; if (re.test(line)) { taut = true; break; } }
    if (!taut) continue;
    // 判断是否落在断言调用里: 同行有断言头, 或往回 4 行内(中间不跨语句结束符)
    let inAssert = ASSERT_HEAD.test(line);
    if (!inAssert) {
      for (let k = i - 1; k >= Math.max(0, i - 4); k--) {
        if (/;\s*$/.test(lines[k])) break;
        if (ASSERT_HEAD.test(lines[k])) { inAssert = true; break; }
      }
    }
    if (inAssert) {
      hits.push(path.relative(ROOT, p).replace(/\\/g, "/") + ":" + (i + 1) + "  " + line.trim().slice(0, 110));
    }
  }
}

ok(`断言里没有恒真兜底(扫了 ${files.length} 个文件)`, hits.length === 0, hits.slice(0, 6));

// 自证 1: 违规形态必须能识别
{
  let detected = false;
  const probe = "ok(a === 1 " + "|" + "| true, \"m\")";
  for (const re of TAUT) { re.lastIndex = 0; if (re.test(probe)) { detected = true; break; } }
  ok("闸门自证: 能识别断言里的恒真兜底", detected);
}
// 自证 2: 正常断言不许误报
{
  let detected = false;
  for (const re of TAUT) { re.lastIndex = 0; if (re.test("ok(a === 1 && b !== 2, \"m\")")) { detected = true; break; } }
  ok("闸门自证: 正常断言不误报", detected === false);
}

console.log(fails ? `=== no tautology FAIL: ${fails} ===` : "=== no tautology PASS ===");
process.exit(fails ? 1 : 0);
