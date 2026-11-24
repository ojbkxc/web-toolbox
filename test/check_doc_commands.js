// 把"文档里 node <file> 命令的目标必须存在"钉成闸门。
// 注意排除"占位符示例"(node test/check_xxx.js 这类 xxx 形态) —— 那是有意的模板。
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");

let fails = 0;
const ok = (name, cond, got) => {
  if (cond) console.log("  OK " + name);
  else { fails++; console.log("FAIL " + name + " → " + JSON.stringify(got)); }
};

// 扫描面: 面向读者的文档(教人**执行**命令的地方)。
// **CHANGELOG 排除**: 它记录历史, 会引用"曾经写错的命令名"(如生成器改名前的 .js)——
// 那是叙述而不是可执行指令, 当成死链会误报(本闸门首跑就抓到了自己 CHANGELOG 里的两句)。
const DOCS = ["README.md", "AGENTS.md", "SECURITY.md", "test/README.md", "bridge/README.md",
  "docs/mcp-clients.md", "docs/troubleshooting.md", "docs/tool-reference.md", "docs/skills.md",
  "samples/INDEX.md", "samples/README.md"];

// 占位符特征: 含 xxx / XXXX / <...> / APP / TARGET
const isPlaceholder = (t) => /xxx|XXXX|<[^>]+>|\bAPP\b|\bTARGET\b|\bPATH\b/i.test(t);

const dead = [];
let checked = 0;
const seen = new Set();
for (const rel of DOCS) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) continue;
  const lines = fs.readFileSync(p, "utf8").split(/\r?\n/);
  lines.forEach((l, i) => {
    for (const m of l.matchAll(/\bnode\s+([A-Za-z0-9_./\\-]+\.(?:js|mjs|cjs))/g)) {
      const target = m[1].replace(/\\/g, "/");
      if (isPlaceholder(target)) continue;
      const key = target;
      if (seen.has(key)) continue;
      seen.add(key);
      checked++;
      const exists = [path.join(ROOT, target), path.join(path.dirname(p), target), path.join(ROOT, "bridge", target)]
        .some((c) => fs.existsSync(c));
      if (!exists) dead.push(`${rel}:${i + 1} → node ${target}`);
    }
  });
}

ok(`文档里引用的 node 命令目标都真实存在(${checked} 条命令)`, dead.length === 0, dead.slice(0, 5));
ok("确实扫到了若干命令(否则本条断言无意义)", checked >= 10, checked);

// 闸门自证: 判定逻辑能区分
{
  const probe = (t) => !isPlaceholder(t) && !fs.existsSync(path.join(ROOT, t));
  ok("闸门自证: 不存在的真实命令会被抓", probe("bridge/no_such_gen.cjs") === true, "n/a");
  ok("闸门自证: 占位符示例不误判", isPlaceholder("test/check_xxx.js") === true, "n/a");
}

console.log(fails ? `\n=== doc commands FAIL: ${fails} ===` : `\n=== doc commands PASS (${checked} 条) ===`);
process.exit(fails ? 1 : 0);