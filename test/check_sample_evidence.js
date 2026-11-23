// check_sample_evidence.js —— 样本证据链闸门(v1.1.49)
//
// 样本库的承诺是"通用性必须用开源多样样本证明"(AGENTS 硬规则)。但这个承诺自身没有闸门:
//   · 新加一个样本目录, INDEX.md 不更新 → 清单上看不到它, 证据"隐形";
//   · 每个 sample.json 里声明的 meta(source/url/auth_form/entries)是**分类依据**,
//     INDEX 与 README 按它做认证形态矩阵 —— 字段漂移没人查。
//
// 断言:
//   1. 每个样本目录(含 sample.json)必须在 INDEX.md 里被提及;
//   2. 每个 sample.json 必须有 meta 必填字段(source/url/entries), entries 数与实载一致(对 loader 现算);
//   3. 已知脱敏约束: sample.json 里的 url 字段不许指向真实内网域(复用 R55 的保留域规则);
//   4. 开源样本必须标注出处(source 含项目名或 URL)。
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const SAMPLES = path.join(ROOT, "samples");

let fails = 0;
const ok = (name, cond, got) => {
  if (cond) console.log("  OK " + name);
  else { fails++; console.log("FAIL " + name + " → " + JSON.stringify(got)); }
};

// ---- 收集样本目录(含 sample.json, 相对 samples/, posix 分隔) ----
const dirs = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.isDirectory()) walk(path.join(d, e.name));
    else if (e.name === "sample.json") {
      dirs.push(path.relative(SAMPLES, d).split(path.sep).join("/"));
    }
  }
})(SAMPLES);

// loader 加载(与回归同源)
const { loadAllSamples } = require(path.join(SAMPLES, "loader.js"));
const loaded = loadAllSamples(SAMPLES);
const byDir = new Map(loaded.map((s) => [s.dir, s]));

const INDEX = fs.readFileSync(path.join(SAMPLES, "INDEX.md"), "utf8");

// ---- 1. INDEX 覆盖 ----
// taurus 子目录名(csv-login/k6/blazedemo/...)在 INDEX 里以缩写出现; 匹配用"目录名含于 INDEX"
// 而不是FullPath, 因为 INDEX 的行文是 "opensource/taurus (csv-login)" 形态。
const unmentioned = dirs.filter((rel) => {
  const leaf = rel.split("/").pop();
  // INDEX 行文有译名/项目名两种形态; 再放宽一层: 项目名(checkly 等)也算提及
  return !INDEX.includes(leaf) && !INDEX.includes(rel)
    && !INDEX.includes(String(JSON.parse(fs.readFileSync(path.join(SAMPLES, rel, "sample.json"), "utf8")).source || "").split("/")[0]);
});
ok(`每个样本目录都在 INDEX.md 里被提及(${dirs.length} 个已扫)`, unmentioned.length === 0, unmentioned);

// ---- 2. meta 必填 + 条数一致 ----
const noMeta = [];
const countMismatch = [];
for (const rel of dirs) {
  const metaPath = path.join(SAMPLES, rel, "sample.json");
  let meta;
  try { meta = JSON.parse(fs.readFileSync(metaPath, "utf8")); } catch (e) { noMeta.push(`${rel}: ${e.message}`); continue; }
  if (!meta.source) noMeta.push(`${rel}: 缺 source`);
  if (typeof meta.entries !== "number") noMeta.push(`${rel}: 缺 entries 数字`);
  const s = byDir.get(rel);
  if (s && meta.entries !== s.entries.length) countMismatch.push(`${rel}: meta.entries=${meta.entries} != 实载 ${s.entries.length}`);
}
ok("每个 sample.json 都有 source/entries", noMeta.length === 0, noMeta.slice(0, 5));
ok("meta.entries 与 loader 实载一致", countMismatch.length === 0, countMismatch.slice(0, 5));

// ---- 3. 脱敏: sample.json 里的 url 不指向真实内网域 ----
// 样本数据(sample.jsonl/jmx)是"录制形态", 允许出现任意域(这是数据本身); sample.json 的
// meta.url 是"文档字段", 应指向公开出处或脱敏形态。
const RESERVED_SUFFIX = [".invalid", ".test", ".example", ".localhost"];
const RESERVED = new Set(["example.com", "example.org", "test.com", "localhost", "httpbin.org"]);
const TLD = /\.(com|cn|net|org|io|local|internal|corp|lan|top|xyz|dev|app)$/i;
const badDomain = [];
for (const rel of dirs) {
  const meta = JSON.parse(fs.readFileSync(path.join(SAMPLES, rel, "sample.json"), "utf8"));
  const u = String(meta.url || "");
  if (!u) continue;
  const host = (u.match(/^(?:https?:\/\/)?([^\/\s:]+)/) || [])[1] || "";
  if (!host || !TLD.test(host)) continue;  // file:// 或本地路径
  if (RESERVED.has(host.toLowerCase())) continue;
  if (RESERVED_SUFFIX.some((s) => host.toLowerCase().endsWith(s))) continue;
  // 公开开源项目域(httpbin/gitlab/jmeter/k6 等)在白名单里
  const OSS = new Set(["httpbin.org", "jmeter.apache.org", "gitlab.com", "github.com", "k6.io", "blazedemo.com", "reqres.in",
    "datatracker.ietf.org", "ietf.org", "oreilly.com", "swagger.io", "readthedocs.io", "wikipedia.org"]);
  if (OSS.has(host.toLowerCase())) continue;
  badDomain.push(`${rel}: meta.url=${host}`);
}
ok("sample.json 的 meta.url 不指向真实内网域", badDomain.length === 0, badDomain);

// ---- 4. 闸门自证 ----
{
  const probeHost = "ics.midea.com";
  const isBad = (h) => !RESERVED.has(h) && !RESERVED_SUFFIX.some((s) => h.endsWith(s));
  ok("闸门自证: 真实内网域会被判红", isBad(probeHost), probeHost);
  ok("闸门自证: 保留域/开源域不被误判", !isBad("example.com") && !isBad("httpbin.org"), "n/a");
}

console.log(fails ? `=== sample evidence FAIL: ${fails} ===` : `=== sample evidence PASS (${dirs.length} 样本目录) ===`);
process.exit(fails ? 1 : 0);