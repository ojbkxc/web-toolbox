// check_sidepanel_handlers.js —— 动态生成按钮的事件绑定完整性(v1.1.50)
//
// 问题形态(R62 排查 INDEX 时想到的同族缺口): 侧栏大量按钮是 **innerHTML 模板动态生成**的
// (格式卡片/链预览/详情面板), 生成后必须再绑 onclick; 漏绑一个 = "按钮点了没反应"的静默故障。
// 静态检查只能证明"函数存在", 证明不了"按钮真的被接上了"。
//
// 这里反向钉: **模板字符串里出现的每个按钮 id, 必须在 JS 里找到对应的绑定**
// (onclick 赋值 / addEventListener / 函数内 `$("id").onclick`)。三形态都算, 漏一个就红。
// 同时钉: 静态按钮(HTML 里的)也必须被 JS 绑定或引用 —— 这个已有 check_ui_wiring 管,
// 这里只补"动态生成的"这层, 语义不重复。
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");

let fails = 0;
const ok = (name, cond, got) => {
  if (cond) console.log("  OK " + name);
  else { fails++; console.log("FAIL " + name + " → " + JSON.stringify(got)); }
};

const HTML = fs.readFileSync(path.join(ROOT, "sidepanel", "sidepanel.html"), "utf8");
const JS = fs.readFileSync(path.join(ROOT, "sidepanel", "sidepanel.js"), "utf8");

// ---- 1. 模板里的按钮 id: JS 里必须出现一次"非模板"的引用 ----
// 模板形态: innerHTML = `...<button ... id="X">...`; 绑定形态: $("X") / getElementById("X")
const tplIds = [...JS.matchAll(/<button[^>]*\sid="([a-zA-Z][\w-]*)"/g)].map((m) => m[1]);
const uniqueTplIds = [...new Set(tplIds)];
ok(`动态模板里有按钮 id(${uniqueTplIds.length} 个)`, uniqueTplIds.length > 0, uniqueTplIds.length);

// 从 JS 里剔除所有模板字符串内容后再查绑定(否则"模板里的 id"会自匹配)
const stripTemplates = (src) => src.replace(/`(?:[^`\\]|\\.)*`/g, (m) => " ".repeat(m.length));
const code = stripTemplates(JS);

const unbound = uniqueTplIds.filter((id) => !new RegExp(`\\$\\(\s*["']${id}["']`).test(code)
  && !new RegExp(`getElementById\\(\s*["']${id}["']`).test(code));
ok("动态生成的按钮都有绑定(模板外的 $()/getElementById 引用)", unbound.length === 0, unbound);

// ---- 2. 绑定形态里引用的 id 必须真实存在(HTML 静态 / HTML 加载期 JS 声明 / innerHTML 模板) ----
// 注意: "JS 声明面"不止 innerHTML 模板 —— sidepanel 还有 plain 字符串拼接生成 DOM 的形态
// (如 "…id='replayMsg'…" / createElement 后 el.id= 赋值)。统一认这三种"动态声明"。
const htmlIds = new Set([...HTML.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
// 全量 JS(未剔除模板)里的 id 声明: 属性形态 + .id 赋值形态
function findAll(re, src) { const out = []; let m; re.lastIndex = 0; while ((m = re.exec(src))) out.push(m[1]); return out; }
const jsDeclared = new Set([
  ...findAll(/[\s"']id=["']([A-Za-z][\w-]*)["']/g, JS),
  ...findAll(/\.id\s*=\s*["']([A-Za-z][\w-]*)["']/g, JS),
]);
const scope = (id) => htmlIds.has(id) || jsDeclared.has(id);

const bindRefs = [...code.matchAll(/\$\(\s*["']([A-Za-z][\w-]*)["']\s*\)/g)].map((m) => m[1]);
const refSet = [...new Set(bindRefs)];
const dangling = refSet.filter((id) => !scope(id));
ok(`绑定引用的 id 都有声明面(HTML 或模板; ${refSet.length} 个引用)`,
  dangling.length === 0, dangling.slice(0, 8));

// ---- 3. addEventListener 形态的 id 同样核对 ----
const aliRefs = [...code.matchAll(/getElementById\(\s*["']([A-Za-z][\w-]*)["']\s*\)\s*\.addEventListener/g)]
  .map((m) => m[1]);
const aliBad = [...new Set(aliRefs)].filter((id) => !scope(id));
ok("addEventListener 绑定同样指向真实元素", aliBad.length === 0, aliBad);

// ---- 4. 闸门自证 ----
{
  // 模板里有 id="tplBtnX" 但绑定只引用别的 → 红; 有 $("tplBtnX").onclick= → 绿
  const probeJs1 = 'el.innerHTML = `<button id="tplA">x</button>`;';
  const probeJs2 = probeJs1 + ' $("tplA").onclick = () => {};';
  const strip = (src) => src.replace(/`(?:[^`\\]|\\.)*`/g, " ".repeat(1));
  const has1 = (src, id) => new RegExp('\\$\\(\\s*["\']' + id + '["\']').test(strip(src));
  ok("闸门自证: 漏绑的模板按钮会被抓", !has1(probeJs1, "tplA") && has1(probeJs2, "tplA"), "n/a");
}

console.log(fails ? `=== handlers FAIL: ${fails} ===` : `=== handlers PASS (${uniqueTplIds.length} 动态按钮) ===`);
process.exit(fails ? 1 : 0);