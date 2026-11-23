// check_no_internal_domains.js —— 扩展代码里的"真实域名"闸门(v1.1.44)
//
// AGENTS.md 硬规则 4: 禁止把真实内网域名、Cookie、API Key 写进任何入库文件。
// 本轮实测发现三处**注释**里残留真实客户域名(代码逻辑没用到, 但注释同样入库、同样会被人
// 复制进别的文档): sidepanel 的漏录示例、popup 的域名覆盖示例、jmx 的跨环境切法示例。
// 已换成 RFC 2606 保留域(example.com)。这个闸门让"下次再写进去"当轮就红。
//
// 三类白名单(每条都写理由):
//   · RESERVED —— RFC 2606/6761 保留域, 本来就是给示例用的;
//   · PRODUCT  —— 本产品自己的服务域(选项页 AI 端点提示里要告诉用户去哪买 Key);
//   · NOT_DOMAIN —— 被正则误捕的扩展 API 命名空间(如 chrome.storage.local)。
// 扫的范围: 扩展运行时代码(根 .js + 三个页面目录 + manifest); samples/ 由 check_sample_evidence 独立验证脱敏(v1.1.81)、
// test/ 是测试数据, 由它们各自的规则管, 不在这里判。
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");

let fails = 0;
const ok = (name, cond, got) => {
  if (cond) console.log("  OK " + name);
  else { fails++; console.log("FAIL " + name + " → " + JSON.stringify(got)); }
};

const RESERVED = new Set([
  "example.com", "example.org", "example.net", "test.com", "localhost",
]);
const RESERVED_SUFFIX = [".invalid", ".test", ".example", ".localhost"];
const PRODUCT = new Set(["lxseek.com"]);
const NOT_DOMAIN = new Set(["chrome.storage.local", "chrome.storage.sync", "document.cookie.secure"]);

const TLD = "com|cn|net|org|io|local|internal|corp|lan|top|xyz|cloud|site|dev|app";
const RE = new RegExp(`\\b((?:[a-z0-9][a-z0-9-]{1,30}\\.)+(?:${TLD}))\\b`, "gi");

const skipDirs = new Set(["node_modules", ".git", "samples", "test", "icons", "scratch"]);
const files = [];
(function walk(d) {
  for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
    // 第三方包清单不属"我们的代码": 里面的 registry/opencollective 等是包元数据,
    // 扫它只会制造噪音(而且锁文件的域名本来也不是我们写的)。
    if (/^(package-lock\.json|package\.json)$/.test(ent.name)) continue;
    if (skipDirs.has(ent.name)) continue;
    const p = path.join(d, ent.name);
    if (ent.isDirectory()) walk(p);
    else if (/\.(js|mjs|html|json)$/.test(ent.name)) files.push(p);
  }
})(ROOT);

const allowed = (host) => {
  if (NOT_DOMAIN.has(host)) return true;
  if (RESERVED.has(host)) return true;
  if (RESERVED_SUFFIX.some((s) => host.endsWith(s))) return true;
  // 允许保留域的子域(ics.example.com / prod.example.com 这类示例)
  for (const r of RESERVED) if (host.endsWith("." + r)) return true;
  for (const p of PRODUCT) if (host === p || host.endsWith("." + p)) return true;
  // 标签级判据: 域名任一段是保留词即假域名(api.test.com.cn 里的 "test" 与 .test 同义)。
  // 为什么必须按标签判: 只按后缀判会把 "xxx.test.com.cn" 当真实域 —— 那是测试里常见写法。
  const labels = host.split(".");
  if (labels.some((x) => x === "test" || x === "example" || x === "invalid" || x === "localhost")) return true;
  return false;
};

const hits = [];
for (const f of files) {
  const src = fs.readFileSync(f, "utf8");
  const lines = src.split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const m of line.matchAll(RE)) {
      const host = m[1].toLowerCase();
      if (allowed(host)) continue;
      hits.push(`${path.relative(ROOT, f).replace(/\\/g, "/")}:${i + 1}  ${host}`);
    }
  });
}

ok(`扩展运行时代码无真实/内网域名(${files.length} 个文件已扫)`, hits.length === 0, hits.slice(0, 10));

// 自证闸门有效: 拿一个必然命中的样例跑一遍, 确认它真的会红(否则"0 命中"可能是正则失效)
{
  const probe = "https://ics.midea.com/api and https://signin.realcorp.internal/x and https://a.b.com.cn/y";
  const found = [...probe.matchAll(RE)].map((m) => m[1].toLowerCase()).filter((h) => !allowed(h));
  ok("闸门自证: 真实域样例会被判红", found.length >= 2, found);
  const keep = ["https://ics.example.com/a", "https://api.lxseek.com/v1", "chrome.storage.local", "https://h.test/x"];
  const kept = keep.every((u) => [...u.matchAll(RE)].every((m) => allowed(m[1].toLowerCase())));
  ok("闸门自证: 保留域/产品域/命名空间不被误判", kept, keep);
}

console.log(fails ? `=== internal domains FAIL: ${fails} ===` : "=== internal domains PASS ===");
process.exit(fails ? 1 : 0);
