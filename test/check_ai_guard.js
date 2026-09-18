// check_ai_guard.js — AI 入口异常保护契约(v1.0.24)
// 背景: 5 个 AI 按钮函数曾裸奔(buildXxxPrompt/callLlm 前后任何 throw 沿 async reject
// 无人接, disabled=false 永不执行 → 按钮永久锁死且零提示); runSelectedSkill 只有
// try/finally(解锁OK) 但无 catch(零提示)。pathLine 的 new URL throw(手改 storage
// 混入相对/空 url)是已知触发面之一。本测试钉死"6 入口 try/catch/finally 齐"契约。
const fs = require('fs'); const path = require('path');
const ROOT = require('path').resolve(__dirname, '..');
const sp = fs.readFileSync(path.join(ROOT, 'sidepanel/sidepanel.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  OK ' + msg); } else { fail++; console.log('  ✗ FAIL ' + msg); } };

// 括号平衡取函数体(粗切"下一个 async function"会被内部定义骗)。
// 已知边界: 计数器不跳过字符串/模板字面量 —— 模板里的 ${expr} 形态花括号天然配对
// (深度平衡不被挤歪, 8 函数实测 try/finally 全含), 但若有人在【文案里写裸花括号】
// (如 '配置 { 后续') 会奇偶失衡 → body 提前/延后闭合 → 断言假 FAIL。
// 遇到"改了文案断言就挂"时先查这条, 不要急着改断言本身。
function fnBody(src, name) {
  const i = src.indexOf('async function ' + name + '(');
  if (i < 0) return null;
  let depth = 0, start = -1;
  for (let p = i; p < src.length; p++) {
    if (src[p] === '{') { depth++; if (start < 0) start = p; }
    else if (src[p] === '}') { depth--; if (depth === 0 && start >= 0) return src.slice(i, p + 1); }
  }
  return null;
}

const FNS = ['aiDiagnose', 'aiReport', 'aiBuildChain', 'aiDebugFailures', 'aiBuildAsserts', 'aiDoc', 'runSelectedSkill', 'runChainReplay'];
for (const fn of FNS) {
  const body = fnBody(sp, fn);
  ok(body !== null, fn + ' 函数存在');
  if (!body) continue;
  ok(/try\s*\{/.test(body), fn + ' 有 try');
  ok(/catch\s*\(/.test(body), fn + ' 有 catch(可读错误)');
  ok(/finally\s*\{/.test(body), fn + ' 有 finally(按钮解锁)');
  ok(/disabled = false/.test(body), fn + ' 解锁语句在');
}

// ---------- aiDebugFailures 20 条上限契约(v1.0.31 固化) ----------
// 合并 blocks 的单次 prompt 无"截断明示"可言(截了就不是完整诊断), 全 ERR 大集
// (3000 条)会合成 15MB+ prompt 网关必拒 —— 与 aiBuildAsserts 的 30 接口拒绝同语义:
// 超限直接拒绝 + 指引缩小范围, 拒绝必须发生在 btn.disabled = true 之前(不锁按钮)。
{
  const body = fnBody(sp, 'aiDebugFailures');
  ok(body !== null, 'aiDebugFailures 函数存在(上限断言)');
  if (body) {
    ok(/bad\.length > 20/.test(body), 'aiDebugFailures 有 20 条上限判定');
    ok(/超出单次调试上限/.test(body), '拒绝文案明说上限与指引');
    const guardIdx = body.indexOf('bad.length > 20');
    const lockIdx = body.indexOf('btn.disabled = true');
    ok(guardIdx >= 0 && lockIdx > guardIdx, '拒绝在按钮锁定之前(超限不锁)');
  }
}

// ---------- chainLease 语义契约(v1.0.26 走查固化) ----------
// runChainReplay 的 catch/正常路径都必须带 identity 守卫(if (chainLease === lease))才清 null:
// 租约被顶(B 又开一轮)时旧 run 的 catch/完成路径绝不能误清 B 的新租约。
// 守卫缺失 → B 跑到一半 chainLease 被旧 run 置 null → B 的租约防多开语义失效。
// 断言窗口是"语句块级"而非行级: 从清 null 行往前扫到最近的块边界({ 或 }),
// 块内必须含 === lease 判定 —— 行级窗口(前 2 行)在守卫与清 null 之间插入注释/空行会假 FAIL;
// 块级窗口只对"同块内是否有判定"负责, 对排版不敏感。若有人重构成 helper 清理,
// 字面量消失 → FAIL = 强迫改者看见这条语义(位置契约的假 FAIL 是特性不是缺陷)。
{
  const body = fnBody(sp, 'runChainReplay');
  ok(body !== null, 'runChainReplay 函数存在(租约断言)');
  const lines = body.split('\n');
  let clearTotal = 0, guarded = 0;
  for (let i = 0; i < lines.length; i++) {
    if (/chainLease\s*=\s*null/.test(lines[i])) {
      clearTotal++;
      // 从当前行往前扫到最近的块边界, 收集块内文本(含同行前缀)
      let ctx = '';
      for (let k = i; k >= 0; k--) {
        ctx = lines[k] + '\n' + ctx;
        if (/[{}]/.test(lines[k].replace(/'.*'/g, ''))) break; // 块边界(字符串字面量里的括号不算)
      }
      if (/chainLease\s*===\s*lease/.test(ctx)) guarded++;
    }
  }
  ok(clearTotal >= 2 && clearTotal === guarded,
    `chainLease 清 null 全部带 identity 守卫(${guarded}/${clearTotal} 处, 被顶不误清新租约)`);
}

console.log(fail ? `\n=== AI 入口保护 FAIL: ${fail} ===` : `\n=== AI 入口保护 PASS (${pass}) ===`);
process.exit(fail ? 1 : 0);
