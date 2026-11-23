// check_security_claims.js —— SECURITY.md 里写的每条事实, 都要在实现里找得到(零依赖)。
//
// 为什么: 安全文档比功能文档更危险 —— 写"权限只有这 8 个"而 manifest 多了一个, 或者写
// "令牌 0600"而代码没带 mode, 用户会基于错的保证做决定。这里把可静态核对的事实全部钉住:
//   1. 权限清单 = SECURITY.md 列的那 8 个, 且没有 host_permissions(域名只走 optional)
//   2. 默认监听 127.0.0.1(回环)、默认端口 9280
//   3. 令牌文件 0600 + 定长比较(timingSafeEqual)
//   4. 控制类默认关闭(allowControl 默认 false), 且 SECURITY 里点名 page_eval 为破坏性
//   5. 扩展本体零依赖(仓库根没有 package.json)
//   6. debugger / sidePanel 权限在位(录制引擎与侧栏的硬前提)
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

let fails = 0;
const ok = (name, cond, got) => {
  if (cond) console.log("  OK " + name);
  else { fails++; console.log("FAIL " + name + " → " + JSON.stringify(got)); }
};

const SEC = read("SECURITY.md");
const mf = JSON.parse(read("manifest.json"));
const config = read("bridge/src/config.js");
const hub = read("bridge/src/hub.js");
const tools = read("bridge/src/tools.js");

// ---- 1. 权限清单 ----
const DOC_PERMS = ["cookies", "storage", "activeTab", "scripting", "debugger", "tabs", "alarms", "sidePanel"];
const docList = (SEC.match(/权限清单固定为([^\n]+)/) || [])[1] || "";
const docPerms = [...docList.matchAll(/`?([a-zA-Z]+)`?/g)].map((m) => m[1]).filter((x) => DOC_PERMS.includes(x));
ok("SECURITY 列出全部 8 个权限", DOC_PERMS.every((p) => docPerms.includes(p)), docPerms);
ok("manifest permissions 与文档集合一致",
  JSON.stringify([...mf.permissions].sort()) === JSON.stringify([...DOC_PERMS].sort()),
  { manifest: mf.permissions, doc: DOC_PERMS });
ok("没有 host_permissions(域名只走 optional)", !("host_permissions" in mf), mf.host_permissions);
ok("optional_host_permissions 只声明 http/https 两类",
  JSON.stringify(mf.optional_host_permissions) === JSON.stringify(["http://*/*", "https://*/*"]),
  mf.optional_host_permissions);
ok("debugger 权限在位(录制引擎前提)", mf.permissions.includes("debugger"), mf.permissions);
ok("sidePanel 权限在位(侧栏前提)", mf.permissions.includes("sidePanel"), mf.permissions);

// ---- 2. 默认监听/端口 ----
ok("config 默认 host = 127.0.0.1", /host:\s*"127\.0\.0\.1"/.test(config), (config.match(/host:\s*"[^"]*"/) || [])[0]);
ok("config 默认 port = 9280", /port:\s*9280/.test(config), (config.match(/port:\s*\d+/) || [])[0]);
ok("SECURITY 写默认 127.0.0.1", SEC.includes("127.0.0.1") && SEC.includes("回环"), "SECURITY 未写回环默认");

// ---- 3. 令牌 0600 + 定长比较 ----
ok("令牌文件以 0600 落盘", /mode:\s*0o600/.test(config), (config.match(/mode:\s*0o\d+/) || [])[0]);
ok("令牌目录 0700", /mode:\s*0o700/.test(config), (config.match(/mode:\s*0o700/) || [])[0]);
ok("比较用 timingSafeEqual(定长)", /timingSafeEqual/.test(config), "未见 timingSafeEqual");
ok("hub 用 safeEqual 校验令牌", /safeEqual\(frame\.token/.test(hub), "hub 未走 safeEqual");
ok("SECURITY 声明 0600", /0600/.test(SEC), "SECURITY 未写 0600");

// ---- 4. 控制类默认关闭 + page_eval 破坏性 ----
ok("config 默认 allowControl = false", /allowControl:\s*false/.test(config), (config.match(/allowControl:\s*\w+/) || [])[0]);
ok("hub 对控制方法二次拦截", /isControlMethod\(method\)\s*&&\s*!this\.allowControl/.test(hub), "hub 缺二次拦截");
const annBlock = tools.slice(tools.indexOf("const ANNOTATIONS = {"), tools.indexOf("};", tools.indexOf("const ANNOTATIONS = {")));
ok("page_eval 标 destructive", /page_eval:\s*\{[^}]*destructiveHint:\s*true/.test(annBlock), "page_eval 未标破坏性");
ok("SECURITY 点名 page_eval 的 JS 执行面", /page_eval/.test(SEC) && /destructiveHint/.test(SEC), "SECURITY 未写 page_eval");

// ---- 5. 扩展本体零依赖 ----
ok("仓库根没有 package.json(扩展零依赖)", !fs.existsSync(path.join(ROOT, "package.json")), "根目录出现 package.json");
ok("bridge/package.json 存在(桥接独立包)", fs.existsSync(path.join(ROOT, "bridge", "package.json")), "缺 bridge/package.json");

// ---- 6. SECURITY 必须声明"不做"清单(避免高估边界) ----
ok("SECURITY 有'不做'清单", /## 已知的"不做"|## 已知的“不做”/.test(SEC), "缺'不做'小节");
ok("SECURITY 写明不隐藏 debugger 黄条", /黄条/.test(SEC), "未提黄条");

console.log(fails ? `=== security claims FAIL: ${fails} ===` : "=== security claims PASS ===");
process.exit(fails ? 1 : 0);
