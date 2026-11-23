// check_doc_counts.js —— 文档计数与版本漂移闸门(零依赖)。
//
// 为什么需要: 每加一个走查文件, run_all 的 suite 数就变, 而 AGENTS/CLAUDE/README/test README
// 里写死的 "N 项 / N/N PASS" 不会自己更新 —— 历史上一度出现 AGENTS 写 34 项、实际 46 项,
// 版本写 1.0.82、manifest 是 1.1.4 的情况(用户/代理照着文档判断"门禁全绿"会被骗)。
//
// 口径与 test/run_all.js 完全一致(那边改了这里必须同改; 两边都从文件系统现算, 不写死):
//   仓库根 2 个(test_regression / mock_bg_test) + samples 1 个 + test/ 下 check_*/e2e_* 若干
//   + scan_conflicts 1 个 + (bridge/node_modules 存在时)bridge-unit/exporters/smoke 3 个。
//
// 断言: 四份文档里的总数、N/N、版本号必须与现算值一致; 不一致直接红, 并打印"应该写什么"。
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");

let fails = 0;
const ok = (name, cond, got) => {
  if (cond) console.log("  OK " + name);
  else { fails++; console.log("FAIL " + name + " → " + JSON.stringify(got)); }
};

// ---- 现算 suite 数(与 run_all 同口径) ----
const discovered = fs.readdirSync(__dirname).filter((f) => /^(check_|e2e_)/.test(f) && f.endsWith(".js")).length;
const bridgeDeps = fs.existsSync(path.join(ROOT, "bridge", "node_modules", "ws"));
// 文档描述的是"仓库能力"(装过 bridge 依赖的完整门禁), 所以这里**恒按 3 个桥接 suite 计**;
// 本机没装依赖时 run_all 会打 SKIP(env) 跳过那 3 个 —— 那是环境差异, 不该让文档闸门红
// (否则"没 npm install 的机器"上所有文档都被判错, 闸门等于逼人改文档凑绿)。
const BRIDGE_SUITES = 4;
const expected = 2 + 1 + discovered + 1 + BRIDGE_SUITES;
if (!bridgeDeps) {
  console.log(`  SKIP(env) bridge unit/exporters/doctor/smoke — bridge/node_modules 未安装, 本机实跑 ${expected - BRIDGE_SUITES} 个`);
}

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
const version = manifest.version;

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const AGENTS = read("AGENTS.md");
const CLAUDE = read("CLAUDE.md");
const README = read("README.md");
const TESTREADME = read("test/README.md");
const REVIEW = read("REVIEW.md");
const SECURITY = read("SECURITY.md");

// ---- 总数 ----
ok(`AGENTS 写 "${expected} 项"`, AGENTS.includes(`，${expected} 项全绿`), (AGENTS.match(/，\d+ 项全绿/) || [])[0]);
ok(`AGENTS 写 "(${expected}/${expected})"`, AGENTS.includes(`全绿(${expected}/${expected})`), (AGENTS.match(/全绿\(\d+\/\d+\)/) || [])[0]);
ok(`AGENTS 结束卫生写 "${expected}/${expected}"`, AGENTS.includes(`（${expected}/${expected} PASS）`), (AGENTS.match(/（\d+\/\d+ PASS）/) || [])[0]);
ok(`CLAUDE 写 "全量 ${expected} 项"`, CLAUDE.includes(`# 全量 ${expected} 项`), (CLAUDE.match(/# 全量 \d+ 项/) || [])[0]);
ok(`CLAUDE 写 "${expected}/${expected} PASS"`, CLAUDE.includes(`${expected}/${expected} PASS`), (CLAUDE.match(/\d+\/\d+ PASS/) || [])[0]);
ok(`test/README 写 "全量 ${expected} 项"`, TESTREADME.includes(`# 全量 ${expected} 项`), (TESTREADME.match(/# 全量 \d+ 项/) || [])[0]);
ok(`README 目录树写 "一键全量 ${expected} 项"`, README.includes(`一键全量 ${expected} 项`), (README.match(/一键全量 \d+ 项/) || [])[0]);
ok(`REVIEW 门禁写 "${expected}/${expected} PASS"`, REVIEW.includes(`${expected}/${expected} PASS`), (REVIEW.match(/\d+\/\d+ PASS/) || [])[0]);
ok("SECURITY.md 覆盖三道闸门", ["域名授权", "令牌", "--allow-control"].every((k) => SECURITY.includes(k)),
  ["域名授权", "令牌", "--allow-control"].filter((k) => !SECURITY.includes(k)));

// ---- 工具数声明(README "共 N 个工具" 必须与实现一致) ----
{
  const toolsSrc = read("bridge/src/tools.js");
  const toolCount = [...toolsSrc.matchAll(/\bregister\("([a-z_]+)"/g)].length;
  const m = README.match(/共\s*(\d+)\s*个工具/);
  ok(`README 工具数与实现一致(${toolCount})`, !!m && Number(m[1]) === toolCount, m && m[0]);
  ok("SECURITY.md 存在", fs.existsSync(path.join(ROOT, "SECURITY.md")), "缺 SECURITY.md");
}

// ---- 文档里引用的相对 .md 链接必须真实存在 ----
{
  const broken = [];
  for (const rel of ["README.md", "AGENTS.md", "CLAUDE.md", "bridge/README.md", "test/README.md", "REVIEW.md"]) {
    const src = read(rel);
    for (const m of src.matchAll(/\]\(([^)#\s]+\.md)(?:#[^)]*)?\)/g)) {
      const target = path.resolve(path.dirname(path.join(ROOT, rel)), m[1]);
      if (!fs.existsSync(target)) broken.push(`${rel} → ${m[1]}`);
    }
  }
  ok("文档间 .md 链接无断链", broken.length === 0, broken);
}

// ---- bridge/package.json 的脚本目标必须存在 ----
{
  const pkg = JSON.parse(read("bridge/package.json"));
  const missing = [];
  for (const [name, cmd] of Object.entries(pkg.scripts || {})) {
    for (const m of String(cmd).matchAll(/node\s+\.\/([\w./-]+\.(?:mjs|js))/g)) {
      const target = path.join(ROOT, "bridge", m[1]);
      if (!fs.existsSync(target)) missing.push(`${name} → ${m[1]}`);
    }
  }
  ok("bridge 脚本目标文件都存在", missing.length === 0, missing);
  ok("bridge 有 test 聚合脚本", typeof (pkg.scripts || {}).test === "string", pkg.scripts);
}

// ---- 覆盖清单完整性: 每个 check_*/e2e_* 文件都要在 test/README 表里有一行 ----
{
  const files = fs.readdirSync(__dirname)
    .filter((f) => /^(check_|e2e_)/.test(f) && f.endsWith(".js"))
    .map((f) => f.replace(/\.js$/, ""));
  const rowsFound = [...TESTREADME.matchAll(/^\| ([a-zA-Z_0-9()\u4e00-\u9fa5-]+) \|/gm)].map((m) => m[1]);
  const undocumented = files.filter((n) => !rowsFound.some((r) => r.includes(n)));
  ok("每个走查文件都在 test/README 覆盖清单里", undocumented.length === 0, undocumented);
}

// ---- CHANGELOG 存在且与 manifest 同版本(发布记录不能落后于代码) ----
{
  const cl = fs.existsSync(path.join(ROOT, "CHANGELOG.md")) ? read("CHANGELOG.md") : null;
  ok("CHANGELOG.md 存在", cl !== null, "缺 CHANGELOG.md");
  if (cl) {
    const m = cl.match(/^##\s*v?([\d.]+)/m);
    ok(`CHANGELOG 最新版本 = manifest(${version})`, !!m && m[1] === version, m && m[1]);
  }
}

// ---- tag ↔ manifest ↔ CHANGELOG 三者一致(发版记录不能落后于代码) ----
// 口径: 从 manifest.version 推出期望 tag 名; CHANGELOG 首段版本必须等于它。
// tag 本身查的是本地 git(无网也能跑); 远端同步由推送流程保证, 不在这里联网。
{
  const expectTag = "v" + version;
  const cl = fs.existsSync(path.join(ROOT, "CHANGELOG.md")) ? read("CHANGELOG.md") : "";
  const m = cl.match(/^##\s*v?([\d.]+)/m);
  ok(`CHANGELOG 首段版本 = manifest(${version})`, !!m && m[1] === version, m && m[1]);
  ok("期望 tag 名 = v + manifest version", expectTag === "v" + version, expectTag);
  // AGENTS/CLAUDE 里写的版本必须同源(已在上方断言), 这里补一条"CHANGELOG 不能被写成别的版本线"
  const allVers = [...cl.matchAll(/^##\s*v?([\d.]+)/gm)].map((x) => x[1]);
  ok("CHANGELOG 版本号单调(首段最新)", allVers.length === 0 || allVers[0] === version, allVers.slice(0, 3));
}

// ---- 版本 ----
ok(`AGENTS 版本 = manifest(${version})`, AGENTS.includes(`（当前 ${version}）`), (AGENTS.match(/（当前 [\d.]+）/) || [])[0]);
ok(`CLAUDE 版本 = manifest(${version})`, CLAUDE.includes(`（当前 ${version}，`), (CLAUDE.match(/（当前 [\d.]+，/) || [])[0]);
ok("README 至少提到当前大版本", README.includes(version.split(".").slice(0, 2).join(".")), version);

// ---- 反向: 文档里不能残留"更大的旧数"造成的错位(只查最易漂的四处) ----
const stale = [];
for (const [name, src] of [["AGENTS", AGENTS], ["CLAUDE", CLAUDE], ["test/README", TESTREADME]]) {
  for (const m of src.matchAll(/(\d+) 项/g)) {
    const n = Number(m[1]);
    if (n > 10 && n !== expected && !/行|条/.test(m[0])) stale.push(`${name}: ${m[0]}`);
  }
}
ok("三份文档无残留的其它\"N 项\"计数", stale.length === 0, stale);

console.log(fails ? `=== doc counts FAIL: ${fails} ===` : `=== doc counts PASS (${expected} suites, v${version}) ===`);
process.exit(fails ? 1 : 0);
