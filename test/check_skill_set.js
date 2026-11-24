// check_skill_set.js —— AI 技能集守恒闸门(v1.2.4)
//
// AGENTS §5 里"新增 AI 技能（涉及 prompt 设计与数据卫生边界）"是 ask-first 项。但**机器无法判定
// "有没有先问过"** —— 能做的只有: 让技能集变化**必须显式出现在 diff 里**。
//
// 实证缺口: 注入第 11 个结构完整的技能后, check_prompt_parity / check_ai_egress /
// check_single_source / check_ai_full **全绿**(它们只核对"已有技能的两条路径一致");
// 只有 check_tool_reference 因 skills.md 未同步而红 —— 而那只要重跑生成器就过。
// 也就是说: 加技能 = 加条目 + 重跑生成器 = 全绿, 没有任何地方要求"这是有意的".
//
// 本闸门: 技能清单(name 集合)必须与基线文件一致。变化 → 红, 必须在同一次改动里更新
// test/skill-set.json —— 那次更新就是"显式声明", 会出现在 review diff 里。
// 它不替代人审(§5 仍要求先问), 但把"悄悄加一个技能"从"无痕迹"变成"必须改基线文件"。
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const BASELINE = path.join(__dirname, "skill-set.json");

let fails = 0;
const ok = (name, cond, got) => {
  if (cond) console.log("  OK " + name);
  else { fails++; console.log("FAIL " + name + " → " + JSON.stringify(got)); }
};

// 从 skill.js 读技能 name(与 R79 的抽取口径一致: 接受驼峰/连字符)
const skillSrc = fs.readFileSync(path.join(ROOT, "skill.js"), "utf8");
const names = [...skillSrc.matchAll(/name:\s*"([\w-]+)"/g)].map((m) => m[1]);
const uniq = [...new Set(names)].sort();

ok("skill.js 里读到技能定义", uniq.length > 0, uniq.length);
ok("基线文件存在", fs.existsSync(BASELINE), BASELINE);

if (fs.existsSync(BASELINE)) {
  const base = JSON.parse(fs.readFileSync(BASELINE, "utf8"));
  const baseNames = [...base.skills].sort();

  const added = uniq.filter((n) => !baseNames.includes(n));
  const removed = baseNames.filter((n) => !uniq.includes(n));

  ok("没有新增技能(新增须先按 AGENTS §5 征得同意, 并更新 test/skill-set.json)",
    added.length === 0, added);
  ok("没有移除技能(移除同样是 ask-first, 且会让 docs/skills.md 与用户预期一起变)",
    removed.length === 0, removed);
  ok(`技能数与基线一致(${baseNames.length})`, uniq.length === baseNames.length, { now: uniq.length, base: baseNames.length });
}

// 每个技能必须有 buildPrompt(否则选到它就崩)—— 这是结构约束, 与基线无关
const missingBuilder = uniq.filter((n) => {
  const i = skillSrc.indexOf(`name: "${n}"`);
  if (i < 0) return false;
  const seg = skillSrc.slice(i, skillSrc.indexOf("},", i) + 2);
  return !/buildPrompt\s*:/.test(seg);
});
ok("每个技能都声明了 buildPrompt(选到不会崩)", missingBuilder.length === 0, missingBuilder);

// 闸门自证: 判定逻辑能区分
{
  const diff = (a, b) => a.filter((x) => !b.includes(x));
  ok("闸门自证: 多一个技能会被判新增", diff(["a", "b", "c"], ["a", "b"]).length === 1, "n/a");
  ok("闸门自证: 少一个技能会被判移除", diff(["a", "b"], ["a", "b", "c"]).length === 0, "n/a");
}

console.log(fails ? `\n=== skill set FAIL: ${fails} ===` : `\n=== skill set PASS (${uniq.length} 个技能) ===`);
process.exit(fails ? 1 : 0);