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
    // 与 skills 同一条铁律(R79 实证): 逐字节一致只防手改, 防不了**抽取器漏项**。
    // 独立数 tools.js 的 register 名与文档 "### `name`" 数。
    const toolsSrc = fs.readFileSync(path.join(ROOT, "bridge", "src", "tools.js"), "utf8");
    const regCount = [...toolsSrc.matchAll(/\bregister\("([^"]+)"/g)].length;
    const docTools = (fs.readFileSync(target, "utf8").match(/^### `[^`]+`/gm) || []).length;
    ok("tool-reference.md 工具数 = tools.js register 数(防抽取被正则漏掉)", regCount === docTools, { regCount, docTools });
    // 共享参数形状(filterShape)必须**展开成真实字段**: 文档此前只留一行占位,
    // 5 个工具的过滤参数无处可查(R81)。这里守恒校验: 每个用 ...filterShape 的工具,
    // 其参数表都必须出现全部共享字段名。
    const shapeBody = (toolsSrc.match(/const filterShape = \{([\s\S]*?)\n\};/) || [])[1] || "";
    const shapeFields = shapeBody.split(/\r?\n/)
      .map((l) => l.replace(/\r/g, ""))
      .filter((l) => /^\s{2}[A-Za-z_]\w*:/.test(l))
      .map((l) => l.trim().split(":")[0]);
    const docText = fs.readFileSync(target, "utf8");
    const missing = shapeFields.filter((k) => !docText.includes("`" + k + "`") && !docText.includes("`" + k + "?`"));
    ok(
      "共享过滤参数已展开为真实字段(不缺 " + shapeFields.length + " 字段中的任何一个)",
      shapeFields.length > 0 && missing.length === 0,
      { fields: shapeFields, missing },
    );
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
      // 逐字节一致只证明"两边同源", 证明不了"抽取完整" —— R79 实证: 生成器用 [a-z_]+ 漏掉
      // 驼峰名 diffTriage, 产物 9 行却与入库文件一致(双侧同漏 = 闸门盲区)。这里独立数源侧
      // 条目数, 与产物表行数比对。
      const skillSrc = fs.readFileSync(path.join(ROOT, "skill.js"), "utf8");
      const srcCount = [...skillSrc.matchAll(/name:\s*"[\w-]+"/g)].length;
      const docCount = (fs.readFileSync(targetS, "utf8").match(/^\| `[\w-]+` \|/gm) || []).length;
      ok("skills.md 行数 = skill.js 条目数(防抽取被正则漏掉)", srcCount === docCount, { srcCount, docCount });
    } else {
      fs.writeFileSync(targetS, origS);
      ok("skills.md 与 skill.js 同步", false, { hint: "重跑 node bridge/gen-skills-doc.cjs" });
    }
  }
}

console.log(fails ? `=== tool ref FAIL: ${fails} ===` : "=== tool ref PASS ===");
process.exit(fails ? 1 : 0);