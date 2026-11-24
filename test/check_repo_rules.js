// check_repo_rules.js —— AGENTS.md 硬规则的机器执行(v1.1.46)
//
// AGENTS 的 7 条 Never 里, 1/4/5/6/7 到 R56 各有闸门; 剩下两条一直是"纪律":
//   2. 禁止在测试里放行未过的断言(.skip / 注释掉断言 / 放宽阈值让 CI 变绿);
//   3. 禁止 `git add -A` / `git add .`。
// 纪律靠人记就会破 —— 本轮把它们变成断言, 并补一条零依赖的正向检查。
//
// 判定口径(易错点都写在注释里):
//   · "环境跳过" 合法: TC.skip(...) 会打 SKIP(env) 并计入摘要, 属 AGENTS "环境限制用 skip
//     标注, 不伪装通过"; 要抓的是**框架级** .skip(/.todo(/xit(/xdescribe( —— 那才是静默放行。
//   · process.exit(0) 只判"真代码行": 行首注释、以及写在字符串/正则里的自描述不算。
//   · 零依赖只扫**扩展运行时代码**(根 js + 三页面), 不含 test/(测试当然能用 node 内置);
//     node: 前缀与内置模块名不是 npm 包。
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");

let fails = 0;
const ok = (name, cond, got) => {
  if (cond) console.log("  OK " + name);
  else { fails++; console.log("FAIL " + name + " → " + JSON.stringify(got)); }
};

// ---------- 待扫的测试文件(与 run_all 同口径) ----------
const testFiles = [];
for (const f of fs.readdirSync(__dirname)) {
  if (/^(check_|e2e_)/.test(f) && f.endsWith(".js")) testFiles.push(path.join(__dirname, f));
}
testFiles.push(path.join(ROOT, "test_regression.js"));
if (fs.existsSync(path.join(ROOT, "mock_bg_test.js"))) testFiles.push(path.join(ROOT, "mock_bg_test.js"));
testFiles.push(path.join(ROOT, "samples", "test_regression_samples.js"));

// ---------- A/B/C ----------
const commented = [];
const skipped = [];
const earlyExit = [];
for (const abs of testFiles) {
  const rel = path.relative(ROOT, abs).replace(/\\/g, "/");
  const lines = fs.readFileSync(abs, "utf8").split(/\r?\n/);
  lines.forEach((line, i) => {
    const t = line.trim();
    // A: 被注释掉的断言调用
    if (/^\/{1,2}\s*(ok|assert)(?:\s*\(|\.\w+\s*\()/.test(t)) commented.push(`${rel}:${i + 1}`);
    // B: 框架级跳过(排除 TC.skip 的环境跳过); 注释行豁免 —— 注释里写规则名不算放行
    const isCommentB = /^\s*(\/\/|\*|\/\*)/.test(line);
    const envSkip = /\bTC\.skip\s*\(/.test(line);
    if (!isCommentB && !envSkip && (/\.(skip|todo)\s*\(/.test(line) || /^\s*x(it|describe)\s*\(/.test(line))) {
      skipped.push(`${rel}:${i + 1}`);
    }
    // C: 提前 process.exit(0) —— 只看真代码行
    const isComment = /^\s*(\/\/|\*|\/\*)/.test(line);
    const beforeExit = line.split("process.exit(0)")[0];
    const looksLiteral = /["'`\/]/.test(beforeExit);
    if (!isComment && !looksLiteral && /process\.exit\(0\)/.test(line) && i < lines.length - 12) {
      earlyExit.push(`${rel}:${i + 1}`);
    }
  });
}
ok(`没有注释掉的断言调用(${testFiles.length} 个测试文件已扫)`, commented.length === 0, commented);
ok("没有框架级跳过(.skip/.todo/xit/xdescribe)", skipped.length === 0, skipped);
ok("process.exit(0) 只在文件末尾", earlyExit.length === 0, earlyExit);

// ---------- C2: 就绪判定不得依赖 WS 协议层 ----------
// 实证两次(R92 doctor / R95 test-auth): 用完整 WS 握手判"daemon 就绪", 在本文件专测
// "令牌错/协议错"的场景下必然误判, 且并发时握手慢会超时 → 假红。就绪 = 端口在监听。
{
  const bad = [];
  for (const rel of ["bridge/test-doctor.mjs", "bridge/test-auth.mjs", "bridge/smoke.mjs"]) {
    const p = path.join(ROOT, rel);
    if (!fs.existsSync(p)) continue;
    const src = fs.readFileSync(p, "utf8");
    // 只看 waitDaemonUp 自己的函数体(到下一个 function/async function 为止) ——
    // 用"文件里有没有 net.connect"判会放过于事无补: 改回握手时 TCP 代码仍可能在别处。
    const at = src.indexOf("async function waitDaemonUp");
    const rest = src.slice(at + 30);
    const nextFn = rest.search(/\n(async )?function /);
    const body = nextFn > 0 ? rest.slice(0, nextFn) : rest.slice(0, 1200);
    const usesWsHandshake = /await connect\(/.test(body);
    if (usesWsHandshake) bad.push(rel + "(waitDaemonUp 里用 WS 握手判就绪)");
  }
  ok("就绪判定走 TCP 端口探测(不依赖 WS 握手)", bad.length === 0, bad);
}

// ---------- C3: 测试端口必须探测空闲, 且收尾等端口释放 ----------
// 实证(R96): test-auth 用 "9700+随机" 起 daemon —— 与 34 个僵尸 daemon 占的 9411-9798 撞段,
// 5 次全量跑里 2 次假红。测试自己起的服务必须: ①先探空闲端口; ②结束时等端口真关。
{
  const bad = [];
  for (const rel of ["bridge/test-auth.mjs", "bridge/test-doctor.mjs", "bridge/test-reconnect.mjs", "bridge/test-perf.mjs", "bridge/smoke.mjs"]) {
    const p = path.join(ROOT, rel);
    if (!fs.existsSync(p)) continue;
    const src = fs.readFileSync(p, "utf8");
    const spawns = /spawn\(process\.execPath/.test(src) || /new Hub\(/.test(src);
    if (!spawns) continue;
    const probesFree = /createServer\(|listen\(0,|findFreePort/.test(src);
    if (!probesFree) bad.push(rel + "(不探测空闲端口)");
  }
  ok("起测试服务的套件都探测空闲端口", bad.length === 0, bad);
}

// ---------- C4: 全量入口的失败诊断必须直接给出失败行 ----------
// 实证(R97): 原来只打输出末 3 行, 而断言失败行常在中间 —— 为看"哪条红"要多跑好几次全量。
{
  const ra = fs.readFileSync(path.join(ROOT, "test", "run_all.js"), "utf8");
  ok("run_all 失败时优先打印 FAIL/✗ 行(不只是末 3 行)",
    /badLines\s*=\s*lines\.filter/.test(ra) && /FAIL\|✗/.test(ra), "仍是末 3 行模式");
}

// ---------- C5: 环境跳过(SKIP)必须明说原因, 且不伪装通过 ----------
// AGENTS §2: "环境限制用 skip 标注, 不伪装通过" —— 此前零机检。判据两条:
//   ①每个真实 SKIP 打印点(非注释)附近必须有 console.log/warn 输出(否则就是静默跳过);
//   ②含 SKIP 的套件必须有统一退出 `process.exit(fail ? 1 : 0)` 或 `exit(0)`(跳过不能变红也不能假绿)。
// 注意: 注释里的 SKIP(如"没装依赖时 run_all 会打 SKIP(env)")不算打印点 —— 第一版判据把
// 注释当代码, 误报了 4 个文件。
{
  const skipBad = [];
  const skipFiles = [];
  (function walkSkip(d) {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      if (["node_modules", ".git", "samples", "icons", "lib"].includes(ent.name)) continue;   // lib 提供 skip 函数, 不是套件
      const p2 = path.join(d, ent.name);
      if (ent.isDirectory()) { walkSkip(p2); continue; }
      if (!/\.(js|mjs)$/.test(ent.name)) continue;
      const src2 = fs.readFileSync(p2, "utf8");
      if (!/SKIP\(env\)/.test(src2)) continue;
      const rel2 = path.relative(ROOT, p2).replace(/\\/g, "/");
      const l2 = src2.split(/\r?\n/);
      let realPoints = 0;
      for (let i = 0; i < l2.length; i++) {
        const t2 = l2[i].trim();
        if (/^(\/\/|\*)/.test(t2)) continue;          // 注释里的 SKIP 不算
        if (!/SKIP\(env\)/.test(l2[i])) continue;
        realPoints++;
        // console.log 可能跨行(模板字符串), 看前后 2 行
        const win = l2.slice(Math.max(0, i - 2), Math.min(l2.length, i + 3)).join(" ");
        if (!/console\.(log|warn)|process\.stdout\.write/.test(win)) {
          skipBad.push(`${rel2}:${i + 1} 静默跳过(无输出)`);
        }
      }
      if (realPoints > 0) {
        skipFiles.push(rel2);
        // 判据收紧(v1.2.8): 必须**条件式退出** `exit(cond ? X : Y)`。
        // 为什么收紧掉裸 exit(0): 恒 0 会让该文件里所有断言失败都伪装通过 —— 正是
        // AGENTS 禁止的"不伪装通过"。第一版把 exit(0) 也算合法, 负向验证时裸 exit(0) 被判绿。
        const exitOk = /process\.exit\([^)]*\?[^)]*:[^)]*\)/.test(src2);
        if (!exitOk) skipBad.push(`${rel2} 含 SKIP 但没有统一退出(跳过会假红或假绿)`);
      }
    }
  })(ROOT);
  ok(`含 SKIP 的套件都明说原因且不伪装通过(${skipFiles.length} 个文件)`, skipBad.length === 0, skipBad.slice(0, 4));
  ok("确实存在 SKIP 机制(否则本条断言无意义)", skipFiles.length >= 3, skipFiles.length);
}

// ---------- D:// ---------- D:// ---------- D:// ---------- D: git add -A ----------
const docs = [];
(function walk(d) {
  for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
    if (["node_modules", ".git"].includes(ent.name)) continue;
    const p = path.join(d, ent.name);
    if (ent.isDirectory()) walk(p);
    else if (/\.(md|js|mjs|json)$/.test(ent.name)) docs.push(p);
  }
})(ROOT);
const addAll = [];
for (const abs of docs) {
  const rel = path.relative(ROOT, abs).replace(/\\/g, "/");
  fs.readFileSync(abs, "utf8").split(/\r?\n/).forEach((line, i) => {
    // 注释行豁免: 只豁免真正的注释语法。**不能豁免 Markdown 列表项("- ")**
    // —— 那会把"用 git add -A"这种真实用法当成注释放过(v1.1.70 实证: 四种形态全漏)。
    // 纯注释行里写"禁止 git add -A"由下面的语义豁免(禁止/不许/Never)兜住。
    if (/^\s*(\/\/|\*|\/\*|#|>)/.test(line)) return;
    // 匹配: 前面是任意非标识符字符(行首/引号/等号/括号/Markdown 列表符皆可)。
    // 禁用形态: --all / -A / -a / -u / "."
    if (/(?<![\w-])git\s+add\s+(?:--all|-A|-a|-u|\.)(?![\w-])/.test(line) && !/禁止|不许|Never|never|do not/i.test(line)) {
      addAll.push(`${rel}:${i + 1}`);
    }
  });
}
ok("脚本/文档里没有「全量/单点 add」的用法", addAll.length === 0, addAll);

// ---------- E: 零依赖 ----------
ok("仓库根没有 package.json(扩展源码即产物)", !fs.existsSync(path.join(ROOT, "package.json")), "存在 package.json");
const mf = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
ok("manifest 没有打包钩子(build 字段)", !("build" in mf), Object.keys(mf));

const NODE_BUILTINS = new Set(["fs", "path", "os", "vm", "http", "https", "crypto", "url",
  "child_process", "events", "stream", "util", "assert", "net", "zlib", "buffer", "timers"]);
const BARE_IMPORT = /(?:import\s+[^;'"]*from\s+['"]([^./][^'"]*)['"]|require\(\s*['"]([^./][^'"]*)['"]\s*\))/g;

const extFiles = [];
(function walk2(d) {
  for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
    if (["node_modules", ".git", "samples", "bridge", "icons", "scratch", "test"].includes(ent.name)) continue;
    const p = path.join(d, ent.name);
    if (ent.isDirectory()) walk2(p);
    else if (/\.(js|mjs)$/.test(ent.name)) extFiles.push(p);
  }
})(ROOT);

const npmImports = [];
for (const abs of extFiles) {
  const rel = path.relative(ROOT, abs).replace(/\\/g, "/");
  const src = fs.readFileSync(abs, "utf8");
  for (const m of src.matchAll(BARE_IMPORT)) {
    const spec = m[1] || m[2];
    if (!spec) continue;
    if (/^node:/.test(spec) || NODE_BUILTINS.has(spec)) continue;
    npmImports.push(`${rel} → ${spec}`);
  }
}
ok(`扩展运行时代码不引第三方 npm 包(${extFiles.length} 个文件已扫)`, npmImports.length === 0, npmImports);

// ---------- 闸门自证: 判定规则必须真的能分辨新旧形态 ----------
// 只看"0 命中"不可靠 —— 正则写坏时同样是 0 命中(这条教训来自 R55 域名闸门)。
{
  // 探针用拼接构造: 若把被禁形态按字面量写进本文件, 闸门会抓到自己(必须能区分"描述规则"与"使用形态")。
  const DOT = ".";
  const probeLines = [
    "  ok(true, \"x\");",
    "  // ok(true, \"注释掉的断言\");",
    "  it" + DOT + "skip(\"case\", () => {});",
    "  TC" + DOT + "skip(\"py_compile\", \"未找到 python 3 解释器\");",
    "  console" + DOT + "log(\"process" + DOT + "exit(0) 只允许在末尾\");",
    "  process" + DOT + "exit(0);",
    ["git", "add", "-A"].join(" "),
    ["git", "add", "."].join(" "),
    "// 禁止 git add -A",
  ];
  const isComment = (l) => /^\s*(\/\/|\*|\/\*|#|>|-)/.test(l);
  const caught = {
    commentedAssert: 0, frameworkSkip: 0, envSkipKept: 0, earlyExit: 0, addAll: 0, addAllDocKept: 0,
  };
  probeLines.forEach((line, i) => {
    if (/^\/{1,2}\s*(ok|assert)\s*\(/.test(line.trim())) caught.commentedAssert++;
    const envSkip = /\bTC\.skip\s*\(/.test(line);
    if (!isComment(line) && !envSkip && (/\.(skip|todo)\s*\(/.test(line) || /^\s*x(it|describe)\s*\(/.test(line))) caught.frameworkSkip++;
    if (envSkip) caught.envSkipKept++;
    const beforeExit = line.split("process.exit(0)")[0];
    if (!isComment(line) && !/["'`\/]/.test(beforeExit) && /process\.exit\(0\)/.test(line) && i < probeLines.length - 1) caught.earlyExit++;
    if (!isComment(line) && /(^|\s)git\s+add\s+(-A|-a|\.)(\s|$|`)/.test(line) && !/禁止|不许/i.test(line)) caught.addAll++;
    if (isComment(line) && /git\s+add\s+-A/.test(line)) caught.addAllDocKept++;
  });
  ok("闸门自证: 注释掉的断言会被抓", caught.commentedAssert === 1, caught);
  ok("闸门自证: 框架级跳过会被抓", caught.frameworkSkip === 1, caught);
  ok("闸门自证: TC.skip 环境跳过不被误判", caught.envSkipKept === 1, caught);
  ok("闸门自证: 提前 process.exit(0) 会被抓, 字符串里的不算", caught.earlyExit === 1, caught);
  ok("闸门自证: 全量 add 会被抓, 文档里描述禁令的不算", caught.addAll === 2 && caught.addAllDocKept === 1, caught);
}

console.log(fails ? `=== repo rules FAIL: ${fails} ===` : "=== repo rules PASS ===");
process.exit(fails ? 1 : 0);