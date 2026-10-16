// skill.js —— 内置 AI 技能注册表(把"单次分析动作"固化成可复用模板)
//
// 借鉴 cc-haha/deepseek-pp 的 Skill 形态, 但砍掉"对话式 agent / 工具执行 / 市场导入":
// web-toolbox 的 AI 全部是【选定录制集 → 一个 prompt → 一份产出】的单次分析,
// 所以内置 skill = { name, description, category, buildPrompt }, 由侧栏选择器调用。
//
// 10 个内置 skill 分两类:
//   基础 5 个 —— 对应现有按钮(报告/诊断/建链/文档/断言), 是"现有动作的 Skill 化"入口
//   高阶 5 个 —— 补当前痛点(压测解读/契约破坏判定/接口清单/敏感扫描/会话特征回填)
// 与 aireport.js 的 prompt builder 一一对应, 本身不含 LLM 调用逻辑。
//
// 浏览器: aireport.js 先加载, buildReportPrompt 等是全局函数, 直接可引用。
// node 测试: require 本文件时把 aireport.js 的导出挂到 globalThis, 保证同样可解析。

if (typeof module !== "undefined" && module.exports) {
  Object.assign(globalThis, require("./aireport.js"));
}

// 每个 skill 的 buildPrompt 签名(由调用方决定参数):
//   report/chain/doc/inventory/sensitive   (entries, opts)
//   diagnose   (failed, context, opts)
//   assert     (entry, opts)
//   perf       (entry, stats, opts)
//   diffTriage (recorded, live, opts)
//   session    (entries, opts)   —— opts.hits / opts.misses 由 auth.js 识别结果填充

const BUILTIN_SKILLS = [
  // ── 基础: 现有动作的 Skill 化 ──
  {
    name: "report",
    category: "基础",
    description: "流量报告: 业务流程拆解+接口依赖+风险",
    buildPrompt: (entries, opts) => buildReportPrompt(entries, opts),
  },
  {
    name: "diagnose",
    category: "基础",
    // 注: 技能路径无"选中"上下文(选择器在导出页, 选中态在录制页), 取导出集第一条失败请求;
    // 要诊断特定条目请到录制页详情用「🩺 AI 诊断」按钮(它按 selectedId 定位)。
    description: "错误诊断: 自动分析第一条失败请求",
    buildPrompt: (failed, context, opts) => buildDiagnosePrompt(failed, context, opts),
  },
  {
    name: "chain",
    category: "基础",
    description: "参数建链: 跨接口参数传递自动关联",
    buildPrompt: (entries, opts) => buildChainPrompt(entries, opts),
  },
  {
    name: "doc",
    category: "基础",
    description: "接口文档: OpenAPI 风格, 贴 wiki",
    buildPrompt: (entries, opts) => buildDocPrompt(entries, opts),
  },
  {
    name: "assert",
    category: "基础",
    description: "断言生成: 接口成败判定规则",
    buildPrompt: (entry, opts) => buildAssertPrompt(entry, opts),
  },

  // ── 高阶: 补当前痛点 ──
  {
    name: "perf",
    category: "高阶",
    description: "冒烟解读: 判瓶颈, 给调优建议",
    buildPrompt: (entry, stats, opts) => buildPerfPrompt(entry, stats, opts),
  },
  {
    name: "diffTriage",
    category: "高阶",
    description: "契约判定: DIFF 是噪音还是真破坏",
    buildPrompt: (recorded, live, opts) => buildDiffTriagePrompt(recorded, live, opts),
  },
  {
    name: "inventory",
    category: "高阶",
    description: "接口清单: Markdown 表格",
    buildPrompt: (entries, opts) => buildInventoryPrompt(entries, opts),
  },
  {
    name: "sensitive",
    category: "高阶",
    description: "敏感扫描: 查 token/密码/隐私泄漏",
    buildPrompt: (entries, opts) => buildSensitiveScanPrompt(entries, opts),
  },
  {
    name: "session",
    category: "高阶",
    description: "会话回填: 找登录特征, 反哺识别规则",
    buildPrompt: (entries, opts) => buildSessionFeaturePrompt(entries, opts),
  },
];

// 按名字查 skill
function getSkill(name) {
  return BUILTIN_SKILLS.find((s) => s.name === name) || null;
}

// node 导出(供单测; 浏览器 script 标签加载时此分支不执行)
if (typeof module !== "undefined" && module.exports) {
  module.exports = { BUILTIN_SKILLS, getSkill };
}