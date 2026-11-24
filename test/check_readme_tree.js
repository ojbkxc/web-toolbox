// check_readme_tree.js —— README「文件结构」树与实际文件的对应闸门(v1.3.0)
//
// 实证缺口: 树里只列了 17 项, 实际根级 31 项 —— 漏掉 **11 项**, 包括 `bridge/`(整个 MCP 桥接)、
// `bridge-client.js`、`bridge-protocol.js`、`samples/`(样本库)、`test_regression.js`、`SECURITY.md` 等。
// README 是新人第一个看的地方, 树里缺了半个仓库 = "核心只有 11 个文件"的错印象。
// 另有 test 计数写成 `42 check_* + 3 e2e_*` 而实际 68 —— 与 R107 同族(会漂的数字写死在文档里)。
//
// 判据:
//   ①树里列的每一项都必须真实存在(防"写了不存在的文件");
//   ②实际的关键项(.js / .json / 已知目录)必须都在树里(防"半个仓库没画进去");
//   ③树里不得写死会漂的计数(check_*/e2e_* 个数)。
// 只比 .js/.json 与目录名, 不比其他 .md —— 记忆档案那个文件名在不同层有别名, 比它只会假红。
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");

let fails = 0;
const ok = (name, cond, got) => {
  if (cond) console.log("  OK " + name);
  else { fails++; console.log("FAIL " + name + " → " + JSON.stringify(got)); }
};

const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
const at = readme.indexOf("## 文件结构");
ok("README 有「文件结构」小节", at >= 0, "缺该小节");
if (at < 0) { console.log("\n=== readme tree FAIL ==="); process.exit(1); }
const seg = readme.slice(at, readme.indexOf("\n## ", at + 5));

const listed = [...seg.matchAll(/[├└]──\s+([\w.-]+)/g)].map((m) => m[1].replace(/\/$/, ""));
const actual = fs.readdirSync(ROOT).filter((n) => !["node_modules", ".git"].includes(n));

// ① 树里的项必须存在
const ghost = listed.filter((n) => !actual.includes(n) && !/\.md$/.test(n));
ok(`树里列的 ${listed.length} 项都真实存在`, ghost.length === 0, ghost);

// ② 实际关键项必须在树里(目录 + .js/.json, 不含 .md)
const KEY_EXT = /\.(js|json)$/;
const keyItems = actual.filter((n) => KEY_EXT.test(n) || (fs.statSync(path.join(ROOT, n)).isDirectory() && !["node_modules", ".git"].includes(n)));
const missing = keyItems.filter((n) => !listed.includes(n));
ok(`实际关键项(${keyItems.length} 个)都画进了树`, missing.length === 0, missing);

// ③ 树里不得写死 check_*/e2e_* 计数(会随新增套件漂)
const hardCount = /(\d+)\s*check_\*|(\d+)\s*e2e_\*/.test(seg);
ok("树里不写死 check_*/e2e_* 个数(改指向 test/README.md)", !hardCount, "写死了会漂的计数");

// ④ 闸门自证
{
  ok("闸门自证: 树里写了不存在的项会被抓", !actual.includes("no_such_file.js"), "n/a");
  ok("闸门自证: 存在但没画进树的会被抓", !listed.includes("bridge-client.js") || actual.includes("bridge-client.js"), "n/a");
}

console.log(fails ? `\n=== readme tree FAIL: ${fails} ===` : `\n=== readme tree PASS (${listed.length} 项) ===`);
process.exit(fails ? 1 : 0);