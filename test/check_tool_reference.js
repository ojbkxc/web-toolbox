// 闸门: docs/tool-reference.md 必须与生成器产物逐字节一致(手改=漂移)。
// 判定: 重新生成到临时文件, 与入库文件 buffer 对比; 不一致时红并打印 diff 摘要。
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const ROOT = path.resolve(__dirname, "..");

let fails = 0;
const ok = (name, cond, got) => {
  if (cond) console.log("  OK " + name);
  else { fails++; console.log("FAIL " + name + " → " + JSON.stringify(got)); }
};

const target = path.join(ROOT, "docs", "tool-reference.md");
const gen = path.join(ROOT, "bridge", "gen-tool-reference.cjs");
// 同主题的第二个生成器: docs/skills.md(skill.js 的技能表) —— 复用同一闸门。

ok("生成器存在", fs.existsSync(gen), gen);
ok("docs/tool-reference.md 存在", fs.existsSync(target), target);

if (fs.existsSync(gen) && fs.existsSync(target)) {
  const tmp = path.join(ROOT, "docs", ".tool-reference.generated.md");
  // 生成器直接写目标路径 —— 用 env 重定向? 不, 生成器写死 target。改为: 备份目标,
  // 跑生成器, 比较后恢复原文件; 一致则删备份, 不一致则保留生成版并红。
  const orig = fs.readFileSync(target);
  execSync(`node "${gen}"`, { cwd: ROOT, windowsHide: true });
  const now = fs.readFileSync(target);
  const same = Buffer.compare(orig, now) === 0;
  if (same) {
    ok("tool-reference.md 与 tools.js 同步(生成器产物逐字节一致)", true, "n/a");
  } else {
    // 保留生成版会覆盖用户手改 —— 恢复原文件, 红给 diff
    fs.writeFileSync(target, orig);
    const a = orig.toString("utf8").split("\n");
    const b = now.toString("utf8").split("\n");
    const diff = [];
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i] !== b[i]) diff.push(`L${i + 1}: ${JSON.stringify(a[i] && a[i].slice(0, 50))} → ${JSON.stringify(b[i] && b[i].slice(0, 50))}`);
      if (diff.length >= 3) break;
    }
    ok("tool-reference.md 与 tools.js 同步", false, { hint: "重跑 node bridge/gen-tool-reference.cjs", diff });
  }
}

// ---- skills.md 同步(skill.js → docs/skills.md, 同一生成式思路) ----
{
  const genS = path.join(ROOT, "bridge", "gen-skills-doc.cjs");
  const targetS = path.join(ROOT, "docs", "skills.md");
  ok("skills 生成器存在", fs.existsSync(genS), genS);
  if (fs.existsSync(genS) && fs.existsSync(targetS)) {
    const origS = fs.readFileSync(targetS);
    execSync(`node "${genS}"`, { cwd: ROOT, windowsHide: true });
    const nowS = fs.readFileSync(targetS);
    const sameS = Buffer.compare(origS, nowS) === 0;
    if (sameS) {
      ok("skills.md 与 skill.js 同步(生成器产物逐字节一致)", true, "n/a");
    } else {
      fs.writeFileSync(targetS, origS);
      ok("skills.md 与 skill.js 同步", false, { hint: "重跑 node bridge/gen-skills-doc.cjs" });
    }
  }
}

console.log(fails ? `=== tool ref FAIL: ${fails} ===` : "=== tool ref PASS ===");
process.exit(fails ? 1 : 0);