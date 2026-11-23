// check_ai_egress.js —— AI 外发路径的单一源闸门(v1.1.43)
//
// AGENTS.md 把"数据卫生管线不可绕过"列为硬规则, 但规则要能被执行才算规则。现状(实测):
//   · 10 个 build*Prompt 全都在 aireport.js 里, 且**每个内部都自带清洗**
//     (aiSanitizeEntry / scrubLong / scrubSensitiveKeys);
//   · sidepanel 的 6 个 AI 入口(aiDiagnose/aiReport/aiBuildChain/aiDoc/aiDebugFailures/aiBuildAsserts)
//     一律 build*Prompt → callLlm, 没有旁路拼 prompt。
// 这个"单源 + 全自带清洗"的性质此前**没有人钉** —— 新增一个忘记清洗的 build*Prompt, 或新增一个
// 直接拼 messages 调 callLlm 的入口, 现有测试(清洗规则 / try-catch 守卫)都不会红。
//
// 四条断言:
//   1. aireport.js 的每个 build*Prompt 体内必须出现清洗调用;
//   2. sidepanel/popup/skill 里每处 callLlm(...) 所在函数体必须出现 build*Prompt(不许旁路拼接);
//   3. 除 aireport.js 外, 不许有第二个文件定义 build*Prompt(单源);
//   4. skill.js 的技能必须委托 aireport 的 build*Prompt(与 check_prompt_parity 互补: 那条验等价, 这条验来源)。
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

let fails = 0;
const ok = (name, cond, got) => {
  if (cond) console.log("  OK " + name);
  else { fails++; console.log("FAIL " + name + " → " + JSON.stringify(got)); }
};

// 取"从某处起到下一个顶层 function 之前"的函数体(足够做包含关系判断)
function bodyOf(src, marker) {
  const i = src.indexOf(marker);
  if (i < 0) return "";
  const rest = src.slice(i + marker.length);
  const nextTop = rest.search(/\n(?:async\s+)?function\s|\nconst\s+\w+\s*=\s*(?:async\s*)?\(/);
  return nextTop > 0 ? rest.slice(0, nextTop) : rest;
}

const CLEAN_RE = /aiSanitizeEntry|scrubLong|scrubSensitiveKeys/;

// ---- 1. 每个 build*Prompt 自带清洗 ----
const aireport = read("aireport.js");
const builders = [...new Set([...aireport.matchAll(/\n\s*function\s+(build[A-Za-z]*Prompt)/g)].map((m) => m[1]))];
ok("aireport.js 里找到 build*Prompt(>=8 个)", builders.length >= 8, builders.length);
const noClean = builders.filter((n) => !CLEAN_RE.test(bodyOf(aireport, "function " + n)));
ok("每个 build*Prompt 内部都调用清洗", noClean.length === 0, noClean);

// ---- 2. 每处 callLlm 的宿主函数都经 build*Prompt ----
// 白名单: 只允许**不含任何录制数据**的调用点。目前唯一合法例外是选项页的「测试连接」
// (testLlm) —— 它发的是固定探测文本, 目的是验证地址/Key 可用, 不碰 harvest。
// 加白名单必须写理由: 一旦例外里开始夹带条目, 这条断言就名存实亡。
const EGRESS_ALLOW = new Map([
  ["options/options.js:testLlm", "只发固定探测文本, 不含任何录制数据"],
]);
const callers = ["sidepanel/sidepanel.js", "popup/popup.js", "options/options.js", "skill.js", "aireport.js"];
const bypass = [];
for (const rel of callers) {
  if (!fs.existsSync(path.join(ROOT, rel))) continue;
  const src = read(rel);
  // 定位每个 callLlm( 调用, 回溯到最近的函数定义
  for (const m of src.matchAll(/\bcallLlm\s*\(/g)) {
    const before = src.slice(0, m.index);
    const fnMatches = [...before.matchAll(/\n(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g)];
    const fnName = fnMatches.length ? fnMatches[fnMatches.length - 1][1] : "<顶层>";
    const body = fnMatches.length ? bodyOf(src, "function " + fnName + "(") : src;
    const key = `${rel}:${fnName}`;
    if (EGRESS_ALLOW.has(key)) continue;
    // callLlm 的同一函数体里必须出现 build*Prompt(或它引用的 prompt 变量来自 build*Prompt)
    if (!/build[A-Za-z]*Prompt/.test(body)) bypass.push(key);
  }
}
ok("所有 callLlm 调用点的宿主函数都经 build*Prompt(白名单外无旁路)", bypass.length === 0, [...new Set(bypass)]);

// 白名单自身也要能区分: 例外函数体内**不许**出现录制数据来源(entries/harvest)
const allowLeak = [];
for (const key of EGRESS_ALLOW.keys()) {
  const [rel, fn] = key.split(":");
  const src = read(rel);
  const body = bodyOf(src, "function " + fn + "(");
  if (/\bentries\b|harvest|exportRows|buildHar/.test(body)) allowLeak.push(key);
}
ok("白名单例外确实不接触录制数据", allowLeak.length === 0, allowLeak);

// ---- 3. build*Prompt 单源 ----
const NAMES = new Set(builders);
const dup = [];
for (const f of fs.readdirSync(ROOT).filter((n) => n.endsWith(".js") && n !== "aireport.js")) {
  const src = read(f);
  for (const n of NAMES) {
    if (new RegExp(`\\n\\s*function\\s+${n}\\s*\\(`).test(src)) dup.push(`${f}:${n}`);
  }
}
ok("build*Prompt 只在 aireport.js 定义(单源)", dup.length === 0, dup);

// ---- 4. skill.js 委托 aireport ----
const skill = read("skill.js");
const usesAireport = builders.filter((n) => new RegExp(`\\b${n}\\b`).test(skill));
ok("skill.js 委托 aireport 的 build*Prompt(>=6 个)", usesAireport.length >= 6, usesAireport);
ok("skill.js 不自己再洗一遍数据(避免双份规则漂移)", !CLEAN_RE.test(skill), "skill.js 出现了清洗调用");

console.log(fails ? `=== ai egress FAIL: ${fails} ===` : `=== ai egress PASS (${builders.length} 个 prompt 构造器) ===`);
process.exit(fails ? 1 : 0);
