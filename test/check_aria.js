// check_aria.js —— aria 可达性静态契约(v1.0.42-48 累积的 aria 面防回归)。
// 2026-09-17 从 check_trim_sync.js 场景 3 拆出: trim_sync 回归 trim 行为职责,
// aria 契约断言(3a-3y → 本文件 a-系)独立成文件——拆走不改语义, 只改组织。
// 纯静态源码扫描(正则 includes), 比 vm 级便宜一个数量级且防回归效力相同:
// renderList/renderDetail/HTML 结构改动会静默砸掉读屏可达性, 静态断言钉住它们。
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..');

const assert = (cond, msg) => { if (!cond) { console.log('FAIL: ' + msg); process.exit(1); } console.log('  OK ' + msg); };

const src = fs.readFileSync(ROOT + '/sidepanel/sidepanel.js', 'utf8');
const html = fs.readFileSync(ROOT + '/sidepanel/sidepanel.html', 'utf8');
const optSrc = fs.readFileSync(ROOT + '/options/options.js', 'utf8');
const optHtml = fs.readFileSync(ROOT + '/options/options.html', 'utf8');
const popHtml = fs.readFileSync(ROOT + '/popup/popup.html', 'utf8');

// --- 列表条目(v1.0.42) ---
assert(src.includes('div.setAttribute("role", "button")') && src.includes('div.setAttribute("tabindex", "0")') && src.includes('div.setAttribute("aria-label"'), 'a1. 列表条目 role/tabindex/aria-label 三件套在');
assert(/div\.onkeydown = \(ev\) => \{ if \(ev\.key === "Enter" \|\| ev\.key === " "\)/.test(src), 'a2. 条目 Enter/Space 键盘选择在');
assert(src.includes('进导出集`)') && src.includes('标为登录前置`)'), 'a3. checkbox 两模式 aria-label 在');

// --- 详情页六按钮(v1.0.42; 匹配粒度 v1.0.46 收紧为按钮级) ---
// 按钮级精确匹配(同 button 标签内须含 aria-label): 全文件级 includes 会
// "按钮删 aria 但别处有"假绿。
for (const btn of ['replay', 'loadtest', 'aiDiag', 'curl', 'delOne', 'setTrim']) {
  const m = src.match(new RegExp(`<button[^>]*id="${btn}"[^>]*>`));
  assert(m !== null && m[0].includes('aria-label='), `a4-${btn}. 详情按钮 ${btn} 标签内含 aria-label(按钮级匹配)`);
}
assert(src.includes('id="dHeaders" aria-label') && src.includes('id="dBody" aria-label'), 'a5. dHeaders/dBody textarea aria-label 在');
assert(src.includes('不可撤销">🗑 删除'), 'a6. 删除按钮"不可撤销"警示在双通道');

// --- kv 块 aria-labelledby(v1.0.46) ---
for (const kv of ['kv-url', 'kv-dur', 'kv-dyn', 'kv-diag', 'kv-resp']) {
  assert(new RegExp(`<h4 id="${kv}">`).test(src), `a7-${kv}. kv 块 h4 id 在`);
  assert(new RegExp(`aria-labelledby="${kv}"`).test(src), `a8-${kv}. kv 块 pre/labelledby 关联在`);
}
// 响应 h4 纯"响应"文案 + status/mime 移 data-status(v1.0.47: h4 是 labelledby 播报源,
// 括号数字/mime 串是视觉紧凑信息, 读屏听"响应"即焦点落位)
assert(src.includes('<h4 id="kv-resp">响应</h4>'), 'a9. 响应 h4 纯文案(杂音移出播报源)');
assert(src.includes('id="dResp" aria-labelledby="kv-resp" data-status='), 'a10. dResp status/mime 走 data-status');
assert(src.includes('aria-label="${isTrimActive ? "这条已是导出起点'), 'a11. setTrim 三态 aria-label 在');

// --- 冒烟面板(v1.0.46-47) ---
assert(src.includes('id="ltConc"') && /ltConc"[^>]*aria-label/.test(src), 'a12. ltConc aria-label 在');
assert(src.includes('id="ltTotal"') && /ltTotal"[^>]*aria-label/.test(src), 'a13. ltTotal aria-label 在');
assert(/id="ltRun" aria-label="开始冒烟压测/.test(src), 'a14. ltRun aria-label 在(含"真实发请求"警示语义)');
assert(src.includes('id="ltOut"') && src.includes('role="status" aria-live="polite">待运行…'), 'a15. ltOut role=status polite 在(两次更新无轰炸)');
assert(src.includes('role="group" aria-labelledby="kv-ltp"'), 'a16. 冒烟参数块 group 关联在');

// --- 状态栏 aria-live(v1.0.44, 三页面) ---
assert(html.includes('id="chainMsg" role="status" aria-live="polite"'), 'a17. chainMsg aria-live 在');
assert(html.includes('id="expMsg" role="status" aria-live="polite"'), 'a18. expMsg aria-live 在');
assert(html.includes('id="ckMsg" role="status" aria-live="polite"'), 'a19. ckMsg aria-live 在');
assert(optHtml.includes('id="llmMsg" role="status" aria-live="polite"'), 'a20. llmMsg aria-live 在');
assert(popHtml.includes('id="expCount" style="text-align:center" role="status" aria-live="polite"'), 'a21. popup expCount aria-live 在');
// chainOut 不挂 aria-live 的设计取舍(v1.0.47): 逐条 appendChild 挂 live=30 条 30 次播报轰炸
// —— 负面断言: 刻意设计不锚定会被后人当遗漏"顺手补齐"。
assert(!html.includes('id="chainOut" role="status"') && !/id="chainOut"[^>]*aria-live/.test(html), 'a22. chainOut 不挂 aria-live(逐条追加轰炸防护)');

// --- Cookie 表格 th+scope(v1.0.45) ---
assert(src.includes('<th scope="col" style="text-align:left">名称</th>'), 'a23. Cookie 表 th+scope 列头在');

// --- options 域名行按钮 aria-label(v1.0.45, 含域名上下文) ---
assert(optSrc.includes('aria-label="编辑域名'), 'a24. options 编辑按钮 aria-label 在');
assert(optSrc.includes('aria-label="删除域名'), 'a25. options 删除按钮 aria-label(含"撤销授权"语义)在');

// --- Tab 结构(v1.0.48) ---
// role=tablist/tab/tabpanel + aria-selected: tab 切换原来只有 class active,
// 读屏用户听不到"当前在哪个页"——选中态语义由 aria-selected 承载非 CSS 类。
// 匹配粒度: 标签级正则(html.match)按"标签内同时含两个属性"断言, 不锚定属性顺序
// (顺序变化是排版级调整, 属性成对存在才是契约——v1.0.49 自审收紧假 FAIL 面)。
assert(html.includes('class="tabs" role="tablist"'), 'a26. tabs 容器 role=tablist 在');
assert((html.match(/<button[^>]*role="tab"[^>]*aria-selected/g) || []).length === 3, 'a27. 三个 tab 按钮含 role=tab+aria-selected(标签级, 序无关)');
assert((html.match(/<div[^>]*id="pg\w+"[^>]*role="tabpanel"/g) || []).length === 3, 'a28. 三个 page 容器 role=tabpanel 在');
assert(/<button[^>]*aria-selected="true"[^>]*data-tab="rec"/.test(html), 'a29. 默认 tab(录制页) aria-selected=true 在');
assert(src.includes('x.setAttribute("aria-selected", "false")') && src.includes('t.setAttribute("aria-selected", "true")'), 'a30. tab 切换 JS 同步 aria-selected 在');

// --- skillSel 下拉框(v1.0.48) ---
// optgroup label 分组 + option 文案自描述("name — description"), label 是纯文字相邻
// —— select 原生控件读屏可达, optgroup/option 文案即播报内容, 无需额外 aria。
assert(src.includes('const g = document.createElement("optgroup")') && src.includes('g.label = cat'), 'a31. skillSel optgroup 分组在');
assert(src.includes('o.textContent = `${s.name} — ${s.description}`'), 'a32. skillSel option 自描述文案在');

// --- 错误槽 role=alert(v1.0.48) ---
// replayErr/ltErr 是错误呈现位(区别于 replayMsg/ltOut 的状态位): 错误发生时读屏用户
// 要被打断提示——alert 语义(即时插播)比 status(排队等朗读完)合适; 状态/进度位维持 polite。
assert(src.includes('id="replayErr" role="alert"'), 'a33. replayErr 错误槽 role=alert 在');
assert(src.includes('id="ltErr" role="alert"'), 'a34. ltErr 错误槽 role=alert 在');

// --- tab 箭头键盘契约 + aria-controls(v1.0.49) ---
// WAI-ARIA tabs pattern: 左右箭头/Home/End 在 tab 间移动并激活(自动激活模式);
// 只有 onclick 时读屏用户的箭头导航无响应是 pattern 违约。
assert(/t\.onkeydown[\s\S]{0,200}ArrowRight/.test(src) && src.includes('ev.key === "ArrowLeft"'), 'a35. tab 箭头键导航契约在');
assert(src.includes('ev.key === "Home"') && src.includes('ev.key === "End"'), 'a36. tab Home/End 跳首尾在');
assert(/tabs\[j\]\.focus\(\)/.test(src) && /activate\(tabs\[j\]\)/.test(src), 'a37. 箭头移动后 focus+activate 在');
// aria-controls 单向关联(tab→面板): tabpanel 命名走静态 aria-label(v1.0.48 权衡——tab 文案
// 含计数徽章, labelledby 会把数字读进页面名), controls 告诉读屏"这个 tab 管哪个面板"。
assert(/<button[^>]*aria-controls="pgRec"[^>]*data-tab="rec"/.test(html)
  && /<button[^>]*aria-controls="pgExp"[^>]*data-tab="exp"/.test(html)
  && /<button[^>]*aria-controls="pgCk"[^>]*data-tab="ck"/.test(html), 'a38. 三 tab aria-controls 单向关联在');
// expOut(v1.0.49): role=region 让读屏可按区域跳转定位"导出/AI 结果预览"; 不挂 aria-live——
// 内容是 AI 报告全文(可达数 KB), 挂 live 整篇播报轰炸; 完成信号归 expMsg(已挂 polite)。
assert(html.includes('id="expOut" role="region" aria-label="导出/AI 结果预览"'), 'a39. expOut role=region+label 在');
assert(!/id="expOut"[^>]*aria-live/.test(html), 'a40. expOut 不挂 aria-live(全文轰炸防护, 同 chainOut 取舍)');
// skillSel 宽度(v1.0.50): min-width:0 允许 flex:1 收缩(最长 option 78 字符, 无收缩会撑破侧栏)
assert(/id="skillSel"[^>]*min-width:0/.test(html), 'a48. skillSel min-width:0 可收缩在');
// q 过滤框 aria-label(v1.0.51): placeholder-only 是 v1.0.44 已知类型, Cookie 页 search 补过
// 时 q 漏了——读屏对 placeholder 支持不一致且输入后消失, 输入框语义要 aria-label 兜底。
// 行级匹配: placeholder 值里的 ">=400" 含 '>' 会让标签级 [^>]* 截断(id 与 aria-label
// 分居 '>' 两侧)——按行取 id="q" 所在行再行内查, 不受属性值内 '>' 干扰。
assert(html.split('\n').some((l) => l.includes('id="q"') && l.includes('aria-label="过滤录制列表')), 'a49. q 过滤框 aria-label 在(v1.0.44 类型补漏, 行级匹配)');
// detailAnn 选中播报(v1.0.51): 键盘 Enter 选中后焦点在列表条目上, 详情区更新无播报——
// sr-only polite 区播报"已选中 X 状态 N", 不抢焦点(Tab 序不散)。
assert(html.includes('id="detailAnn" role="status" aria-live="polite"'), 'a50. detailAnn sr-only 播报区在');
assert(src.includes('ann.textContent = `已选中 ${sel.method}'), 'a51. select() 写播报文案在');

// --- 行为级: tab 键盘导航端到端(v1.0.49) ---
// 静态断言只证"代码在", vm 行为级证"按了真的切"——箭头/Home/End/循环/非方向键不拦截。
{
  const vm = require('vm');
  const elements = new Map();
  const mkEl = (id) => { if (elements.has(id)) return elements.get(id);
    const el = { id, style: {}, dataset: {}, value: '', textContent: '', innerHTML: '', className: '', checked: true, disabled: false, focused: false,
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      addEventListener() {}, dispatchEvent() {},
      setAttribute(k, v) { this[k] = v; },
      focus() { this.focused = true; },
      appendChild() {}, insertBefore() {}, querySelector() { return mkEl(id + '_q'); }, querySelectorAll() { return []; }, scrollIntoView() {}, onclick: null, onkeydown: null };
    elements.set(id, el); return el; };
  const tabs = ['rec', 'exp', 'ck'].map((t) => { const el = mkEl('tab_' + t); el.dataset.tab = t; el['aria-selected'] = t === 'rec' ? 'true' : 'false'; return el; });
  const pages = ['pgRec', 'pgExp', 'pgCk'].map((p) => mkEl(p));
  const documentObj = { getElementById: (id) => mkEl(id), createElement: () => mkEl('a' + Math.random()),
    querySelectorAll: (sel) => sel === '.tab' ? tabs : sel === '.page' ? pages : [] };
  const sb = { console, setTimeout, URL, URLSearchParams,
    chrome: { storage: { local: { get: async () => ({}), set: () => {}, remove: () => {} }, onChanged: { addListener() {} } },
      runtime: { sendMessage: async () => ({}) , openOptionsPage() {} }, tabs: { query: async () => [{ id: 1, url: 'https://x.com/' }] },
      permissions: { contains: async () => false } },
    document: documentObj, navigator: {}, performance: { now: () => Date.now() } };
  sb.window = sb; sb.globalThis = sb;
  vm.createContext(sb);
  const htmlSrc = fs.readFileSync(ROOT + '/sidepanel/sidepanel.html', 'utf8');
  for (const m of htmlSrc.matchAll(/<script src="([^"]+)"><\/script>/g)) {
    try { new vm.Script(fs.readFileSync(path.resolve(ROOT + '/sidepanel', m[1]), 'utf8'), { filename: m[1] }).runInContext(sb); }
    catch (e) { /* 部分脚本依赖链 stub 不全, tab 逻辑在 sidepanel.js 且其顶层执行成功即可 */ }
  }
  const key = (el, k) => el.onkeydown({ key: k, preventDefault() {}, currentTarget: el });
  assert(typeof tabs[0].onkeydown === 'function', 'a41. tab onkeydown 已挂(vm 顶层执行)');
  key(tabs[0], 'ArrowRight');
  assert(tabs[1]['aria-selected'] === 'true' && tabs[1].focused && tabs[0]['aria-selected'] === 'false', 'a42. ArrowRight 切 exp+聚焦+rec 退选');
  key(tabs[1], 'Home');
  assert(tabs[0]['aria-selected'] === 'true' && tabs[0].focused, 'a43. Home 跳首并聚焦');
  key(tabs[0], 'End');
  assert(tabs[2]['aria-selected'] === 'true' && tabs[2].focused, 'a44. End 跳尾并聚焦');
  key(tabs[2], 'ArrowRight');
  assert(tabs[0]['aria-selected'] === 'true', 'a45. 末端右箭头循环回首');
  key(tabs[0], 'ArrowLeft');
  assert(tabs[2]['aria-selected'] === 'true', 'a46. 首位左箭头循环到尾');
  const sel = tabs[2]['aria-selected'];
  key(tabs[2], 'a');
  assert(sel === tabs[2]['aria-selected'], 'a47. 非方向键不切 tab(不拦截)');
}

// --- 行为级: 列表条目 Tab 停留点端到端(v1.0.60) ---
// v1.0.11/v1.0.42 的"30 条=30 个 Tab 停留点 + checkbox 保留可聚焦"取舍注释只被
// 静态断言(a1/a2/a3)锚过"代码在", 行为级(条目 div 三件套真实落位 / Enter-Space
// 真选中 / 非激活键不拦截 / checkbox onclick stopPropagation 不冒泡成选条目 /
// 两模式 aria-label 分流)从未被验证。真浏览器不可自动化(DOM 焦点), vm 行为级
// 钉"onkeydown 挂上、按下真的 select"——渲染结构改动砸掉键盘主线时这里先红。
{
  const vm = require('vm');
  const elements = new Map();
  let ctr = 0;
  const mkEl = (id) => { if (elements.has(id)) return elements.get(id);
    const el = { id, style: {}, dataset: {}, children: [], value: '', textContent: '', innerHTML: '', className: '', checked: true, disabled: false,
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } }, addEventListener() {},
      appendChild(c) { this.children.push(c); return c; },
      setAttribute(k, v) { this[k === 'aria-label' ? 'ariaLabel' : k] = v; },
      insertBefore(c, ref) { const i = ref ? this.children.indexOf(ref) : -1; if (i >= 0) this.children.splice(i, 0, c); else this.children.push(c); return c; },
      querySelector() { return mkEl(id + '_q'); }, querySelectorAll() { return []; }, focus() {}, onclick: null };
    elements.set(id, el); return el; };
  const documentObj = { getElementById: (id) => mkEl(id), createElement: () => mkEl('gen' + (ctr++)), createDocumentFragment: () => mkEl('frag' + (ctr++)), querySelectorAll: () => [], body: mkEl('body') };
  const sb = { console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, URL, URLSearchParams, AbortController,
    navigator: { clipboard: { writeText: async () => {} } }, document: documentObj, performance: { now: () => Date.now() }, fetch: async () => { throw new Error('nf'); },
    chrome: { storage: { local: { get: async (k) => { const o = {}; for (const x of [].concat(k)) o[x] = sb.__sd[x]; return o; }, set: async (o) => { Object.assign(sb.__sd, o); }, remove: async () => {} },
      onChanged: { addListener() {} } },
      runtime: { sendMessage: async () => ({ ok: true, recState: 'idle', count: 0, pending: 0, attachedTabs: 0, domains: [], unmatched: [], harvestCorrupt: false }), openOptionsPage() {} },
      tabs: { query: async () => [{ id: 1, url: 'https://a.b.com/x' }] }, scripting: { executeScript: async () => [{ result: { status: 200, ok: true, text: '{}' } }] },
      sidePanel: {}, permissions: { contains: async () => true, request: async () => true } } };
  sb.__sd = {};
  sb.window = sb; sb.globalThis = sb; vm.createContext(sb);
  const htmlSrc = fs.readFileSync(ROOT + '/sidepanel/sidepanel.html', 'utf8');
  for (const m of htmlSrc.matchAll(/<script src="([^"]+)"><\/script>/g)) {
    new vm.Script(fs.readFileSync(path.resolve(ROOT + '/sidepanel', m[1]), 'utf8'), { filename: m[1] }).runInContext(sb);
  }
  const mk = (i, method) => ({ id: i, method, url: `https://a.b.com/web/api/p${i}`, path: `/web/api/p${i}`, query: '', headers: {}, body: '', status: 200, response: '{}', mime: '', ts: '', durationMs: 30 });
  sb.__entries = [mk(1, 'GET'), mk(2, 'POST'), mk(3, 'GET')];
  vm.runInContext('entries = __entries; renderList()', sb);
  const frag = elements.get('list').children[elements.get('list').children.length - 1];
  const items = frag.children;
  assert(items.length === 3, 'a52. 三条录制渲染三条目(append 真实 push 后可断言)');
  const d0 = items[0];
  assert(d0.role === 'button' && d0.tabindex === '0' && /GET|POST/.test(d0.ariaLabel || ''), 'a53. 条目 role/tabindex/aria-label 三件套行为级落位');
  assert(typeof d0.onkeydown === 'function' && typeof d0.onclick === 'function', 'a54. 条目 onkeydown+onclick 双挂载');
  d0.onkeydown({ key: 'Enter', preventDefault() {} });
  assert(vm.runInContext('selectedId', sb) === 3, 'a55. Enter 选中条目(倒序首条 id=3)');
  items[2].onkeydown({ key: ' ', preventDefault() {} });
  assert(vm.runInContext('selectedId', sb) === 1, 'a56. Space 同样选中(id=1)');
  const before = vm.runInContext('selectedId', sb);
  items[1].onkeydown({ key: 'ArrowDown', preventDefault() {} });
  assert(vm.runInContext('selectedId', sb) === before, 'a57. 非激活键(ArrowDown)不选中不拦截');
  const cb0 = d0.children[0];
  assert(cb0.type === 'checkbox' && cb0.tabindex !== '-1', 'a58. checkbox 可聚焦保留(v1.0.42 取舍: 未移出 Tab 序)');
  assert((cb0.ariaLabel || '').includes('标为登录前置'), 'a59. 普通模式 checkbox aria-label=前置标记');
  cb0.onclick({ stopPropagation() {} });
  assert(vm.runInContext('selectedId', sb) === 1, 'a60. checkbox onclick 不冒泡成选条目(selectedId 保持 1)');
  vm.runInContext('togglePickMode()', sb);
  const frag2 = elements.get('list').children[elements.get('list').children.length - 1];
  const cb2 = frag2.children[0].children[0];
  assert((cb2.ariaLabel || '').includes('进导出集'), 'a61. 勾选模式 checkbox aria-label 分流(进导出集)');
  cb2.onclick({ stopPropagation() {} });
  assert(vm.runInContext('pickIds.has(3)', sb) === true, 'a62. 勾选模式 checkbox 点击真实 togglePick(id=3)');
}

console.log('');
console.log('=== aria 契约 PASS ===');
