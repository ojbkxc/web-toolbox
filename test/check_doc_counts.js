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
const BRIDGE_SUITES = 9;
const expected = 2 + 1 + discovered + 1 + BRIDGE_SUITES;
if (!bridgeDeps) {
  console.log(`  SKIP(env) bridge unit/exporters/doctor/reconnect/auth/perf/smoke — bridge/node_modules 未安装, 本机实跑 ${expected - BRIDGE_SUITES} 个`);
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

// ---- docs/ 目录(对外文档入口): 存在性 + 关键内容抽查 ----
// README 引用了 docs/, 文档里的数字承诺(doctor 18 项等)与实现同步 —— 漂数字=骗读者。
{
  const mcpDoc = path.join(ROOT, "docs", "mcp-clients.md");
  const tsDoc = path.join(ROOT, "docs", "troubleshooting.md");
  ok("docs/mcp-clients.md 存在且 README 有链接", fs.existsSync(mcpDoc) && README.includes("docs/mcp-clients.md"), "缺文件或链接");
  ok("docs/troubleshooting.md 存在且 README 有链接", fs.existsSync(tsDoc) && README.includes("docs/troubleshooting.md"), "缺文件或链接");
  if (fs.existsSync(tsDoc)) {
    const t = fs.readFileSync(tsDoc, "utf8");
    ok("troubleshooting 写的 doctor 项数带「有 daemon 时」前提",
      /有 daemon 时 18 项/.test(t), "缺「有 daemon 时 18 项」");
  }
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

// ---- bridge 文档里的"项数"声明(v1.1.93) ----
// 实证漂移: bridge/README 写 smoke 58 项(实际 74)、test-doctor 21 项(实际 24)、unit 71 项
// (实际 84); docs/mcp-clients 也写着 74/21; docs/troubleshooting 写"扩展回归 67 项"(实际 78)。
// 这些数字没人管(本闸门此前只覆盖 AGENTS/README/test README), 每次加断言就漂一点。
// 处置: **bridge 套件的项数一律不写**(写"项数见运行输出"); 只有 doctor 自检的 18 项保留,
// 因为它有 daemon 时稳定且是用户可感知的"排查面大小", 但必须带"有 daemon 时"前提。
{
  const bridgeDocs = ["bridge/README.md", "docs/mcp-clients.md", "docs/troubleshooting.md"];
  const bad = [];
  for (const rel of bridgeDocs) {
    const p = path.join(ROOT, rel);
    if (!fs.existsSync(p)) continue;
    fs.readFileSync(p, "utf8").split(/\r?\n/).forEach((line, i) => {
      // 允许: 含"有 daemon 时 18 项"这条带前提的 doctor 描述
      if (/有 daemon 时 18 项/.test(line)) return;
      if (/\d+\s*项/.test(line)) bad.push(`${rel}:${i + 1}`);
    });
  }
  ok("bridge 文档不写会被漂移的套件项数(仅保留带前提的 doctor 18 项)", bad.length === 0, bad);
  // doctor 的 18 项必须真的有 18 个检查(静态 check( 调用数, 防"文档写 18 代码只剩 12")
  const doctorSrc = fs.readFileSync(path.join(ROOT, "bridge", "src", "doctor.js"), "utf8");
  const calls = (doctorSrc.match(/(?<![\w.])check\(/g) || []).length;
  const defs = (doctorSrc.match(/function check\(|const check = \(/g) || []).length;
  ok(`doctor 实际检查数 >= 18(静态 ${calls - defs} 处 check 调用)`, calls - defs >= 18, calls - defs);
}

// ---- 4b 发布协议的 tag 面(v1.1.94) ----
// AGENTS §4b 写着"校验: check_doc_counts 断言 manifest ↔ CHANGELOG 同版本; tag 名 = v+version"
// —— 但本文件此前**完全没有 tag 校验**(实测: tag 停在 v1.1.47, manifest 已到 1.1.93, 全绿)。
// 处置: 不要求每次 bump 都打 tag(开发态逐次递增是正常的, 发版才打 tag), 只钉三条硬约束:
//   ①tag 名必须是 vX.Y.Z 形态; ②最新 tag **不得高于** manifest 版本(高于=发了个不存在于代码的版本);
//   ③tag 集合里不得出现重复的版本号。
{
  const { execSync } = require("child_process");
  let tags = [];
  try { tags = execSync("git tag --list", { cwd: ROOT, encoding: "utf8", timeout: 8000 })
    .split(/\r?\n/).map((x) => x.trim()).filter(Boolean); } catch { tags = []; }
  const parse = (t) => t.replace(/^v/, "").split(".").map(Number);
  const cmp = (a, b) => { const pa = parse(a), pb = parse(b); for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0); return 0; };

  if (tags.length) {
    const badName = tags.filter((t) => !/^v\d+\.\d+\.\d+$/.test(t));
    ok("tag 名形态统一为 vX.Y.Z", badName.length === 0, badName);

    const sorted = [...tags].sort(cmp);
    const latest = sorted[sorted.length - 1];
    const vNow = "v" + version;
    ok(`最新 tag 不高于 manifest(${latest} <= ${vNow})`, cmp(latest, vNow) <= 0, { latest, manifest: vNow });

    const seen = new Map();
    const dup = [];
    for (const t of tags) { const k = parse(t).join("."); if (seen.has(k)) dup.push(k); seen.set(k, true); }
    ok("tag 集合没有重复版本号", dup.length === 0, dup);

    if (latest !== vNow) {
      console.log(`  ℹ 开发态: manifest v${version} 领先最新 tag ${latest}(发版时才打 tag, 属正常)`);
    }
  } else {
    console.log("  ℹ 无 tag(未发过版, 跳过 tag 校验)");
  }
}
// ---- REVIEW 结构健康(v1.2.6) ----
// 实测损坏(v1.2.5 之后发现, 由 R66 的归档压缩脚本引入): 「### 下一轮候选」整段被揉进
// `- R11` 索引行的**行尾**, 读起来像乱码; 而它是跨轮交接面(记录哪些决策在等用户批准)。
// 同一次事故里我还把 REVIEW 打碎过一次(把字符串 spread 成单个字符), 所以连同"打碎特征"一起钉。
{
  const review = read("REVIEW.md");
  const rl = review.split(/\r?\n/);

  // ① 打碎特征: 连续 >=5 行都是单字符
  let run = 0, maxRun = 0;
  for (const line of rl) { if (line.length === 1) { run++; if (run > maxRun) maxRun = run; } else run = 0; }
  ok(`REVIEW 没有被打碎(最长连续单字符行 ${maxRun} < 5)`, maxRun < 5, maxRun);

  // ② 标题不得挂在 `- R` 索引行尾(R66 压缩的形态特征)
  const glued = rl.filter((l) => /^- R\d+/.test(l) && l.includes("### "));
  ok("REVIEW 的 `- R` 索引行尾没有粘着标题", glued.length === 0, glued.slice(0, 2));

  // ③ 跨轮交接面必须存在
  ok("REVIEW 有「下一轮候选」小节", rl.some((l) => l === "## 下一轮候选"), "缺该小节");

  // ④ 索引行的要点不得截断在 markdown 中间(R66 压缩的第二类损坏: 要点停在 `**` / `|` / `;` /
  //    悬空编号处, 读起来像残句)。判据: 要点里不许有未配对的 `**`, 且结尾不得是分隔符。
  const idxRe = /^- R(?:[1-9]|1[0-9]|20) · .+? — (.+)$/;
  const badPoint = [];
  for (const line of rl) {
    const m2 = line.match(idxRe);
    if (!m2) continue;
    const p = m2[1].trim();
    const starCount = (p.match(/\*\*/g) || []).length;
    if (starCount % 2 !== 0) { badPoint.push(["未配对 **", line.slice(0, 60)]); continue; }
    if (/[|;]\s*$/.test(p) || /\s-\s*$/.test(p) || /\d+\.\s*$/.test(p)) {
      badPoint.push(["结尾悬空分隔符", line.slice(0, 60)]);
    }
  }
  ok("REVIEW 索引要点没有截断在 markdown 中间", badPoint.length === 0, badPoint.slice(0, 4));
}

console.log(fails ? `=== doc counts FAIL: ${fails} ===` : `=== doc counts PASS (${expected} suites, v${version}) ===`);
process.exit(fails ? 1 : 0);
