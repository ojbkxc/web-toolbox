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


// ---- 生成器必须覆盖多行拼接的 description(v1.2.5) ----
// 实证: tab_list 的描述是 `"a" + "b" + "c"` 多行拼接, 而生成器只取第一个字面量 →
// 文档里只剩第一段。**逐字节一致闸门发现不了**: 生成物与入库文件都由同一份错抽取产生。
// 与 R79(生成器正则漏驼峰)同族: 同源生成只能防手改, 防不了抽取器自身的漏。
{
  const toolsSrc = fs.readFileSync(path.join(ROOT, 'bridge', 'src', 'tools.js'), 'utf8');
  // 找一个 description 跨多行拼接的工具, 断言其**最后一段**出现在文档里
  const multi = [];
  for (const m of toolsSrc.matchAll(/register\("([^"]+)",[\s\S]{0,400}?description:\s*\n\s*"([^"]+)"([\s\S]{0,400}?)inputSchema:/g)) {
    const tailLiterals = [...m[3].matchAll(/\+\s*"([^"]{10,})"/g)].map((x) => x[1]);
    if (tailLiterals.length) multi.push({ name: m[1], tail: tailLiterals[tailLiterals.length - 1] });
  }
  ok('存在多行拼接 description 的工具(否则本条断言无意义)', multi.length > 0, multi.length);
  const doc = fs.readFileSync(target, 'utf8');
  // 每段尾部字面量(去掉引号与空白)都应能在文档里找到
  const missing = multi.filter((x) => {
    const probe = x.tail.replace(/["“”]/g, '').slice(0, 12);
    return probe.length >= 6 && !doc.includes(probe);
  });
  ok('多行拼接 description 的**每一段**都进了文档(不只剩第一段)', missing.length === 0,
    missing.map((x) => x.name + ': ' + x.tail.slice(0, 20)));
}

console.log(fails ? `=== tool ref FAIL: ${fails} ===` : "=== tool ref PASS ===");
process.exit(fails ? 1 : 0);