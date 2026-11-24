// check_dom_escape.js —— 扩展页面 DOM 注入面闸门(v1.1.96)
//
// 威胁模型: 侧栏/popup/options 把**抓包数据**渲染进 DOM。抓到的 method/url/header/AI 输出
// 都是**远程可控**的; 若未转义就拼进 innerHTML, 恶意页面只要返回一个自定义 HTTP 方法名
// 就能在**扩展上下文**里执行脚本 —— 而扩展上下文能调 chrome.debugger / chrome.cookies /
// chrome.scripting, 等于把「任意页面读取 + 任意页面操作 + Cookie」交给被录制的响应。
//
// 实证缺口(v1.1.96): sidepanel.js 的列表行与冒烟面板把 `e.method` 裸拼进 innerHTML
// (method 来自 CDP, **不是枚举** —— 服务端可自定义任意方法名); AI 断言列表的 `a.type`
// 同样裸拼(同行 target/expect 都转义了, 只漏 type)。
//
// 判据(精确形态, 不猜子串 —— 假红会让闸门被关掉, 那才是真损失):
//   危险 = 插值整体是「远程字段引用」或「未转义的字段取值表达式」;
//   安全 = escHtml(...) / 白名单包装 / 纯长度与数字运算 / 已构造好的 *Html/*Mark 片段 /
//          只输出引号字面量的三元。
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");

let fails = 0;
const ok = (name, cond, got) => {
  if (cond) console.log("  OK " + name);
  else { fails++; console.log("FAIL " + name + " → " + JSON.stringify(got)); }
};

// 远程可控的文本字段(来自抓包 / AI 输出)。status 不在内: CDP 的 response.status 是数字。
const REMOTE_FIELD = /^(?:e|a|r|c|f|x)\.(method|url|path|query|headers|body|response|mime|host|name|value|target|expect|type|text|content|verdict|msg)$/;

// 数字字段: 来自 CDP 的类型就是 number, 拼进 DOM 不构成标记注入。
const NUMERIC_FIELD = /^(?:e|a|r|c|f|x)\.(status|durationMs|count|size|len|n|startTs)$/;
function isSafeInterp(inner) {
  const t = String(inner).trim();
  if (/^escHtml\s*\(/.test(t)) return true;                 // 已转义
  if (/^methodClass\s*\(/.test(t)) return true;             // 类名白名单包装
  if (/^[\w.]+\.length$/.test(t)) return true;              // 纯长度(数字)
  if (/^[\w.]+\s*[-+]\s*\d+$/.test(t)) return true;         // 数字运算, 如 shown.length - 50
  // 已构造好的 HTML 片段(名字约定声明了"我已自己转义")
  if (/^[\w.]+$/.test(t) && /(Html|Mark|Note|Cls|Badge|Icon|Hint)$/.test(t)) return true;
  // 三元: 各分支都是引号字面量且不再嵌套插值
  if (/\?/.test(t)) {
    const stripped = t.replace(/(===?|!==?)\s*("[^"]*"|'[^']*')/g, "X");
    // 分支可以是单引号或双引号; 关键是"不再嵌套插值"且冒号两侧都是字面量
    if (/["'][^"']*["']\s*:\s*["']/.test(stripped) && !/\$\{/.test(stripped)) return true;
  }
  return false;
}

function isDangerous(inner) {
  const t = String(inner).trim();
  if (isSafeInterp(t)) return false;
  if (NUMERIC_FIELD.test(t)) return false;                  // 数字字段不算注入
  if (REMOTE_FIELD.test(t)) return true;                     // 裸字段引用
  // 未转义的字段取值表达式(方法调用链 / String(...) 包一层)
  if (/^(?:String\s*\(\s*)?(?:e|a|r|c|f|x)\.\w+/.test(t)) return true;
  return false;
}

// ---- 扫三个页面脚本 ----
const FILES = ["sidepanel/sidepanel.js", "popup/popup.js", "options/options.js"];
const bad = [];
for (const rel of FILES) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) continue;
  const lines = fs.readFileSync(p, "utf8").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!/innerHTML\s*=/.test(lines[i])) continue;
    // 攒到语句结束(模板字符串可能跨多行)
    let stmt = lines[i];
    let j = i;
    while (!/;\s*$/.test(stmt) && j < lines.length - 1 && j < i + 16) { j++; stmt += "\n" + lines[j]; }
    for (const m of stmt.matchAll(/\$\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g)) {
      if (isDangerous(m[1])) bad.push(`${rel}:${i + 1}  ${String(m[1]).trim().slice(0, 70)}`);
    }
  }
}
ok("innerHTML 插值里没有裸远程字段(未转义)", bad.length === 0, bad.slice(0, 10));

// ---- 闸门自证: 判定逻辑必须能区分新旧形态 ----
{
  ok("闸门自证: 裸 e.method 判危险", isDangerous("e.method") === true, "n/a");
  ok("闸门自证: 裸 a.type 判危险", isDangerous("a.type") === true, "n/a");
  ok("闸门自证: escHtml(e.method) 不判危险", isDangerous("escHtml(e.method)") === false, "n/a");
  ok("闸门自证: methodClass(e.method) 不判危险", isDangerous("methodClass(e.method)") === false, "n/a");
  ok("闸门自证: 纯长度 entries.length 不判危险", isDangerous("entries.length") === false, "n/a");
  ok("闸门自证: 已构造片段 msHtml 不判危险", isDangerous("msHtml") === false, "n/a");
  ok("闸门自证: 字面量三元不判危险",
    isDangerous('r.verdict === "OK" ? "✅" : "❌"') === false, "n/a");
  ok("闸门自证: e.method.toUpperCase() 判危险(未转义的取值表达式)",
    isDangerous("e.method.toUpperCase()") === true, "n/a");
}

// ---- 源码级: escHtml 必须覆盖属性上下文需要的五个字符 ----
{
  const side = fs.readFileSync(path.join(ROOT, "sidepanel/sidepanel.js"), "utf8");
  const m = side.match(/function escHtml\(s\) \{\s*return String\(s\)\.replace\(\/\[([^\]]+)\]\//);
  const chars = m ? m[1] : "";
  ok("escHtml 转义 & < > \" ' 五个字符(属性与文本上下文都安全)",
    chars.includes("&") && chars.includes("<") && chars.includes(">") && chars.includes('"') && chars.includes("'"),
    chars);
}

console.log(fails ? `=== dom escape FAIL: ${fails} ===` : "=== dom escape PASS ===");
process.exit(fails ? 1 : 0);