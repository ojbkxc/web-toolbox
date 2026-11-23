// check_ui_wiring.js —— 页面 JS ↔ HTML 的 id 接线闸门(零依赖)。
//
// 追的是一类"点了没反应"的静默故障: JS 里 $("xxx") 拿不到元素(null.classList 直接抛),
// 或 HTML 里有重复 id(getElementById 只回第一个, 另一半按钮永远是死的)。
//
// 只做**能判定**的检查, 不做猜测:
//   1. JS 里 `$("literal")` / `getElementById("literal")` 的 id 必须存在于
//      HTML 静态 id ∪ JS 模板字符串里声明的 id(侧栏详情面板是 innerHTML 拼出来的,
//      例如 dResp/dBody 就只存在于 JS 模板里) —— 这是"声明面"而不是"HTML 面";
//   2. 拼接形态(如 $("pg" + tab))不参与判定: 参数不是单个字面量时无法静态枚举,
//      宁可漏判也不误红(首版就栽在这 —— "pg" 被当成缺失 id, 实际是 pgExp/pgCk/... 的前缀);
//   3. HTML 内 id 不得重复;
//   4. role="tab" 的 aria-controls 必须指向真实存在的 id(键盘/读屏跳转的前提)。
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");

let fails = 0;
const ok = (name, cond, got) => {
  if (cond) console.log("  OK " + name);
  else { fails++; console.log("FAIL " + name + " → " + JSON.stringify(got)); }
};

const PAIRS = [
  ["sidepanel/sidepanel.html", ["sidepanel/sidepanel.js"]],
  ["popup/popup.html", ["popup/popup.js"]],
  ["options/options.html", ["options/options.js"]],
];

for (const [htmlRel, jsRels] of PAIRS) {
  const html = fs.readFileSync(path.join(ROOT, htmlRel), "utf8");
  const jsAll = jsRels.map((r) => fs.readFileSync(path.join(ROOT, r), "utf8")).join("\n");

  const htmlIds = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  const jsDeclared = [...jsAll.matchAll(/\bid="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]);
  const declared = new Set([...htmlIds, ...jsDeclared]);

  // 只取"整参就是一个字面量"的调用: $("x") / getElementById('x') —— 后面紧跟 ) 才算
  const refs = [];
  for (const m of jsAll.matchAll(/(?:\$\(|getElementById\()\s*(["'])([A-Za-z0-9_-]+)\1\s*\)/g)) refs.push(m[2]);

  const missing = [...new Set(refs)].filter((r) => !declared.has(r)).sort();
  ok(`${htmlRel}: JS 引用的 id 都有声明(${new Set(refs).size} 个)`, missing.length === 0, missing);

  const dupes = htmlIds.filter((id, i) => htmlIds.indexOf(id) !== i);
  ok(`${htmlRel}: HTML id 不重复(${htmlIds.length} 个)`, dupes.length === 0, [...new Set(dupes)]);

  const badControls = [...html.matchAll(/role="tab"[^>]*aria-controls="([^"]+)"/g)]
    .map((m) => m[1]).filter((id) => !htmlIds.includes(id));
  ok(`${htmlRel}: tab 的 aria-controls 指向真实面板`, badControls.length === 0, badControls);

  // 反向抽查: HTML 里形如 btn*/input/select 的控件若从未被 JS 引用, 至少要能在 HTML 里有事件属性
  // (有些按钮靠 addEventListener 绑定; 这里只断言"既没被引用也没有 onclick"这类绝对死件)
  const controls = htmlIds.filter((id) => /^(btn|input|llm|add|del|edit)/i.test(id));
  const dead = controls.filter((id) => !refs.includes(id) && !new RegExp(`on\\w+="[^"]*${id}`).test(html) && !html.includes(`#${id}`));
  ok(`${htmlRel}: 控件没有"既无引用也无内联事件"的死件(${controls.length} 个)`, dead.length === 0, dead);
}

console.log(fails ? `=== ui wiring FAIL: ${fails} ===` : "=== ui wiring PASS ===");
process.exit(fails ? 1 : 0);
