// 把"bridge 的 npm test 聚合必须覆盖全部套件"钉成闸门。
// 实测缺口: R112/R113 新增的两个套件没进聚合也没独立 script —— 用户跑 npm test 会漏掉它们。
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");

let fails = 0;
const ok = (name, cond, got) => {
  if (cond) console.log("  OK " + name);
  else { fails++; console.log("FAIL " + name + " → " + JSON.stringify(got)); }
};

const pkgPath = path.join(ROOT, "bridge", "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
const bridgeDir = path.join(ROOT, "bridge");

// 实际套件: test-*.mjs / smoke.mjs / unit.mjs
const actual = fs.readdirSync(bridgeDir)
  .filter((f) => /^(test-.*\.mjs|smoke\.mjs|unit\.mjs)$/.test(f))
  .sort();
ok("bridge 下有套件文件", actual.length >= 5, actual.length);

// ① test 聚合必须覆盖全部
const inAgg = [...(pkg.scripts.test || "").matchAll(/node \.\/([\w.-]+)/g)].map((m) => m[1]);
const missingAgg = actual.filter((f) => !inAgg.includes(f));
ok(`npm test 聚合覆盖全部 ${actual.length} 个套件`, missingAgg.length === 0, missingAgg);

// ② 聚合里不得引用不存在的文件(防改名后残留)
const ghost = inAgg.filter((f) => !fs.existsSync(path.join(bridgeDir, f)));
ok("npm test 聚合里没有不存在的文件", ghost.length === 0, ghost);

// ③ 每个套件都应有独立 script(方便单独跑)
const scriptTargets = Object.entries(pkg.scripts)
  .filter(([k]) => k !== "test")
  .map(([, v]) => (v.match(/node \.\/([\w.-]+)/) || [])[1])
  .filter(Boolean);
const noScript = actual.filter((f) => !scriptTargets.includes(f));
ok("每个套件都有独立 npm script", noScript.length === 0, noScript);

// ④ 闸门自证
{
  const probe = (list, agg) => list.filter((f) => !agg.includes(f));
  ok("闸门自证: 漏一个套件会被抓", probe(["a.mjs", "b.mjs"], ["a.mjs"]).length === 1, "n/a");
  ok("闸门自证: 全覆盖不误判", probe(["a.mjs"], ["a.mjs"]).length === 0, "n/a");
}

console.log(fails ? `\n=== bridge aggregate FAIL: ${fails} ===` : `\n=== bridge aggregate PASS (${actual.length} 套件) ===`);
process.exit(fails ? 1 : 0);