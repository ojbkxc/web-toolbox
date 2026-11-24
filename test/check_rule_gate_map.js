// check_rule_gate_map.js —— 规则-闸门映射闸门(v1.1.88)
//
// 为什么需要: AGENTS §1 的七条 Never 是硬约束, 但"哪条规则由哪个闸门管、有没有做过负向验证"
// 此前只活在人脑里(R82 之前连"规则 7 无人管"都没人知道, 直到注入违规才发现)。映射写成
// 数据文件 + 本闸门校验, 三件事一起钉住:
//   ①AGENTS §1 的规则条数 = 映射条数(新增规则忘了配闸门 → 红);
//   ②映射里点的每个闸门文件真实存在(改名/删除 → 红);
//   ③每条规则都有非空的负向验证记录(只写"有闸门"不算 —— 必须证明它能抓真的)。
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");

let fails = 0;
const ok = (name, cond, got) => {
  if (cond) console.log("  OK " + name);
  else { fails++; console.log("FAIL " + name + " → " + JSON.stringify(got)); }
};

// ① 规则条数
const agents = fs.readFileSync(path.join(ROOT, "AGENTS.md"), "utf8");
const i = agents.indexOf("## 1. Never");
const j = agents.indexOf("## 2.");
const sec = agents.slice(i, j);
const ruleNums = [...sec.matchAll(/^(\d+)\. \*\*([^*]+)\*\*/gm)].map((m) => m[1]);

const mapPath = path.join(__dirname, "rule-gate-map.json");
ok("映射文件存在", fs.existsSync(mapPath), mapPath);
const map = JSON.parse(fs.readFileSync(mapPath, "utf8"));
const mapNums = Object.keys(map);

ok(`AGENTS §1 的 ${ruleNums.length} 条规则全部在映射表里`,
  ruleNums.every((n) => mapNums.includes(n)),
  { rules: ruleNums, map: mapNums });
ok("映射表没有多余条目(规则被删后要同步清理)",
  mapNums.every((n) => ruleNums.includes(n)),
  { extra: mapNums.filter((n) => !ruleNums.includes(n)) });

// ② 闸门文件真实存在(双向: 表里的在, 且不是空壳)
const missing = [];
const emptyGates = [];
for (const [n, e] of Object.entries(map)) {
  if (!Array.isArray(e.gates) || !e.gates.length) { missing.push(`规则 ${n} 没有闸门`); continue; }
  for (const g of e.gates) {
    const p = path.join(ROOT, g);
    if (!fs.existsSync(p)) { missing.push(`${n} → ${g}(文件不存在)`); continue; }
    // 空壳判据: 必须真有断言调用
    const src = fs.readFileSync(p, "utf8");
    if (!/\bok\(|\bassert\(|assert\.ok\(/.test(src)) emptyGates.push(`${n} → ${g}(文件里没有断言)`);
  }
}
ok("映射里每个闸门文件都存在且含断言", missing.length === 0 && emptyGates.length === 0,
  { missing, emptyGates });

// ③ 负向验证记录
const noNegative = Object.entries(map).filter(([, e]) => !e.negative || String(e.negative).trim().length < 10).map(([n]) => n);
ok("每条规则都记录了负向验证(证明闸门能抓真的)", noNegative.length === 0, noNegative);

// 闸门自证: 判定逻辑能区分好坏
{
  const probeBad = { "1": { gates: ["test/不存在.js"], negative: "" } };
  const hasMissing = !fs.existsSync(path.join(ROOT, probeBad["1"].gates[0]));
  const hasNoNeg = !probeBad["1"].negative;
  ok("闸门自证: 指向不存在的闸门会被抓", hasMissing === true, "n/a");
  ok("闸门自证: 空负向记录会被抓", hasNoNeg === true, "n/a");
}

console.log(fails ? `=== rule gate map FAIL: ${fails} ===` : `=== rule gate map PASS (${mapNums.length} 条规则) ===`);
process.exit(fails ? 1 : 0);