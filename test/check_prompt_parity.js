// check_prompt_parity.js —— skill.js 十技能 vs aireport.js 独立按钮 prompt 分叉核对:
//   同一数据两条入口(按钮先截断再传 vs skill 直接传全量靠 prompt 内部截断)必须语义等价 ——
//   分叉会让 LLM 对同一流量给矛盾结论, 用户"按钮说 A 技能说 B"无从归因。
// v1.0.17 核对结论固化:
//   9 技能(除 report)两路径产出逐字节一致;
//   report 超 60 条: 条目体一致, 仅 user 头部计数文案不同(60 条 vs 80 条+截断声明) ——
//   两种截断明示方式都满足 README "截断须明示" 承诺, 非语义分叉。
const ROOT = require('path').resolve(__dirname, '..');
const path = require('path');
const fs = require('fs');
const A = require(ROOT + '/aireport.js');
const S = require(ROOT + '/skill.js');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  OK ' + m); } else { fail++; console.log('  ✗ FAIL ' + m); } };

const mk = (i, path) => ({
  id: 'e' + i, method: 'POST', url: 'https://h.com' + path, path,
  headers: { 'X-A': 'v' }, body: '{"k":"v"}', status: 200,
  response: '{"ok":1}', ts: '2026-09-18T10:00:00Z', durationMs: 12,
});
const entries = [mk(0, '/login'), mk(1, '/api/a'), mk(2, '/api/b')];
const eq = (name, a, b) => ok(JSON.stringify(a) === JSON.stringify(b), name);

// ---- 1. 60 条内: 全部两路径零分叉 ----
eq('report(按钮=skill)', A.buildReportPrompt(entries), S.getSkill('report').buildPrompt(entries));
eq('chain', A.buildChainPrompt(entries), S.getSkill('chain').buildPrompt(entries));
eq('doc', A.buildDocPrompt(entries), S.getSkill('doc').buildPrompt(entries));
eq('inventory', A.buildInventoryPrompt(entries), S.getSkill('inventory').buildPrompt(entries));
eq('sensitive', A.buildSensitiveScanPrompt(entries), S.getSkill('sensitive').buildPrompt(entries));
eq('diagnose', A.buildDiagnosePrompt(entries[1], [entries[0]]), S.getSkill('diagnose').buildPrompt(entries[1], [entries[0]]));
eq('assert', A.buildAssertPrompt(entries[1]), S.getSkill('assert').buildPrompt(entries[1]));
const stats = { concurrency: 1, total: 2, completed: 2, wallMs: 100, rps: 20, success: 2, failed: 0, failRate: 0, p50: 1, p90: 1, p95: 1, p99: 1, maxMs: 2, errors: [] };
eq('perf', A.buildPerfPrompt(entries[1], stats), S.getSkill('perf').buildPrompt(entries[1], stats));
eq('diffTriage', A.buildDiffTriagePrompt(entries[1], entries[2]), S.getSkill('diffTriage').buildPrompt(entries[1], entries[2]));
eq('session', A.buildSessionFeaturePrompt(entries, { hits: [], misses: [] }), S.getSkill('session').buildPrompt(entries, { hits: [], misses: [] }));

// ---- 2. report 超 60 条: 语义等价(条目体一致 + 两边都明示截断) ----
const many = Array.from({ length: 80 }, (_, i) => mk(i, '/p' + i));
const btnUser = A.buildReportPrompt(many.slice(0, 60))[1].content; // 独立按钮路径: 先 slice 再传
const skillUser = A.buildReportPrompt(many)[1].content;            // skill 路径: 全量传, prompt 内 slice
const bodyBtn = btnUser.slice(btnUser.indexOf('### [1]'));
const bodySkill = skillUser.slice(skillUser.indexOf('### [1]'));
ok(bodyBtn === bodySkill, 'report 80 条: 两路径条目体逐字节一致(LLM 看到的集相同)');
ok(skillUser.includes('只取前 60 条'), 'skill 路径 user 消息明示截断(80→60)');
ok(btnUser.startsWith('以下是 60 条'), '按钮路径计数即实际发送数(60)');

// ---- 3. 独立按钮三件套超上限状态栏明示(v1.0.31): doc/chain 修静默 slice, 与 aiReport 同语义 ----
// aiReport 是明示标杆; aiDoc/aiBuildChain 修复后开始态必须带"(共 N 条, 超上限截断)"。
const spSrc = fs.readFileSync(path.join(ROOT, 'sidepanel/sidepanel.js'), 'utf8');
const fnBody = (src, name) => { // 括号平衡取函数体(check_ai_guard 同款)
  const i = src.indexOf('async function ' + name + '(');
  if (i < 0) return null;
  let depth = 0, start = -1;
  for (let p = i; p < src.length; p++) {
    if (src[p] === '{') { depth++; if (start < 0) start = p; }
    else if (src[p] === '}') { depth--; if (depth === 0 && start >= 0) return src.slice(i, p + 1); }
  }
  return null;
};
for (const fn of ['aiReport', 'aiDoc', 'aiBuildChain']) {
  const body = fnBody(spSrc, fn);
  ok(body !== null, fn + ' 函数存在(明示断言)');
  if (!body) continue;
  ok(/超上限截断/.test(body), fn + ' 开始态带"超上限截断"文案');
  ok(/truncated \? src\.slice/.test(body), fn + ' 截断走 truncated 变量(非静默 slice)');
}

// ---- 4. skill mdName 契约(v1.0.69, #162 方向③): 下载命名静态锚 ----
// renderSkillResult(title, content, mdName) 的下载按钮用 `${mdName}_${stamp()}.md`
// 命名; mdName 在 runSelectedSkill 的 switch 各 case 赋值。契约要素:
//   a) 11 个 mdName 值互不撞(下载物按技能可区分);
//   b) 每个值在源码恰一次赋值(重复赋值=改了名忘删旧名);
//   c) 消费点带 .md 后缀与 || "skill" 兜底(缺 mdName 的调用不产无名文件)。
// assert/diagnose 两 case 的 mdName 是死赋值(单独处理分支 return 前赋值,
// 永不达 renderSkillResult)——保留是分支对称性资产(新增 case 忘赋值时形态
// 一眼可见), 不清。
{
  const mds = ['perf_analysis', 'diff_triage', 'sensitive_scan', 'api_inventory',
    'session_features', 'ai_report', 'ai_chain', 'api_doc', 'ai_assert', 'ai_diagnose', 'ai_analysis'];
  for (const m of mds) {
    const n = (spSrc.match(new RegExp('mdName = "' + m + '"', 'g')) || []).length;
    ok(n === 1, `mdName "${m}" 恰一次赋值(实得 ${n})`);
  }
  ok(spSrc.includes('`${mdName || "skill"}_${stamp()}.md`'), '下载命名带 || "skill" 兜底 + .md 后缀');
}

console.log(fail ? `\n=== prompt 分叉 FAIL: ${fail} ===` : `\n=== prompt 分叉 PASS ===`);
process.exit(fail ? 1 : 0);
