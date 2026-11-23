// docs/skills.md —— AI 技能参考(从 skill.js 生成, 与 gen-tool-reference.cjs 同思路)。
// 十技能的"清单+说明+边界"此前散在 README 与 check_prompt_parity 注释里, 没有一份
// 给 AI 客户端使用者的直接参考。生成器保证与 skill.js 同步。
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");

const src = fs.readFileSync(path.join(ROOT, "skill.js"), "utf8");
const skills = [...src.matchAll(/name:\s*"([\w-]+)"[^}]*desc\w*:\s*"([^"]+)"/g)].map((m) => ({ name: m[1], desc: m[2] }));

const L = [];
L.push("# AI 技能参考(Skills)");
L.push("");
L.push("> 本文件由 `node bridge/gen-skills-doc.cjs > docs/skills.md` **生成**, 不要手改。");
L.push("> 源头是 `skill.js` 的技能表(name/desc), 漂移会在 `check_doc_counts` 闸门红。");
L.push("");
L.push("侧栏「AI 技能」选择器里的十项技能, 每项对应一种 \`build*Prompt\`(见 aireport.js, 全部");
L.push("自带数据卫生管线)。技能以 \`run_skill\` 触发, 与独立按钮 **prompt 零分叉**(\`check_prompt_parity\` 钉住)。");
L.push("");
L.push("| 技能 | 说明 |");
L.push("|---|---|");
for (const s of skills) {
  L.push("| `" + s.name + "` | " + s.desc + " |");
}
L.push("");
L.push("## 边界与卫生");
L.push("");
L.push("- 每个技能的 prompt 构造都经 \`aiSanitizeEntry\`(剔 Cookie/Authorization、长 token 打码、");
L.push("  body/响应截断)—— 由 \`test/check_ai_egress.js\` 钉住, 不存在旁路。");
L.push("- \`sensitive\` 是**只读扫描**(查泄漏), 不修改任何数据。");
L.push("- \`session\` 的识别规则会反哺 \`auth.js\` 的登录前置判定(\`manualPrelude\` 优先级高于自动)。");
L.push("");

fs.writeFileSync(path.join(ROOT, "docs", "skills.md"), L.join("\n") + "\n");
console.log("生成完成:", skills.length, "技能");