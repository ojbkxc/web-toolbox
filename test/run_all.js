// test/run_all.js —— 一键全量回归入口(零依赖, node test/run_all.js 即可)。
// 覆盖: 仓库根回归(test_regression/mock_bg_test) + samples 样本库 + 本目录 20 个走查测试。
// 退出码: 全绿 0, 任一失败 1(逐文件列出失败项与尾部输出, 便于定位)。
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const suites = [
  { name: "test_regression", file: path.join(ROOT, "test_regression.js") },
  { name: "mock_bg_test", file: path.join(ROOT, "mock_bg_test.js") },
  { name: "samples", file: path.join(ROOT, "samples", "test_regression_samples.js") },
  ...fs.readdirSync(__dirname)
    .filter((f) => /^(check_|e2e_)/.test(f) && f.endsWith(".js"))
    .sort()
    .map((f) => ({ name: f.replace(/\.js$/, ""), file: path.join(__dirname, f) })),
  // 撞名扫描殿后: 它约束"新增 script 文件"这个动作本身, 挂尾不与功能测试抢序
  { name: "scan_conflicts", file: path.join(__dirname, "scan_conflicts.js") },
];

let failed = [];
for (const s of suites) {
  const t0 = Date.now();
  const r = spawnSync("node", [s.file], { cwd: ROOT, encoding: "utf8", timeout: 120000 });
  const ms = Date.now() - t0;
  if (r.status === 0) {
    console.log(`  PASS ${s.name} (${ms}ms)`);
  } else {
    failed.push(s.name);
    console.log(`  FAIL ${s.name} (exit ${r.status}, ${ms}ms)`);
    const tail = (r.stdout || "").split("\n").filter(Boolean).slice(-3);
    for (const l of tail) console.log("    | " + l);
    if (r.stderr) console.log("    ! " + r.stderr.split("\n")[0]);
  }
}

console.log(failed.length
  ? `\n=== 全量回归 FAIL: ${failed.length}/${suites.length} (${failed.join(", ")}) ===`
  : `\n=== 全量回归 PASS: ${suites.length}/${suites.length} ===`);
process.exit(failed.length ? 1 : 0);
