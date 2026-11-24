// 把"选项页每个必填配置项, README 都要说清填什么"钉成闸门。
// 判据: 对每个关键配置项, README 里必须能找到它的**可填值或默认值**(不是泛指词)。
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");

let fails = 0;
const ok = (name, cond, got) => {
  if (cond) console.log("  OK " + name);
  else { fails++; console.log("FAIL " + name + " → " + JSON.stringify(got)); }
};

const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
const optionsHtml = fs.readFileSync(path.join(ROOT, "options", "options.html"), "utf8");

// 选项页的三个小节(用户装完必去的地方)
const sections = [...optionsHtml.matchAll(/<h2[^>]*>([^<]+)<\/h2>/g)].map((m) => m[1].trim());
ok("选项页小节可读", sections.length >= 3, sections);

// 每个配置"填什么"在 README 的可核验性: 用「默认值/具体形态」判, 不用泛指词
const CONFIG = [
  ["目标域名", /域名配置|域名授权|添加.*域名/],
  ["AI 接口地址", /8787|api\..*\/v1|OpenAI 兼容/],
  ["桥接地址", /ws:\/\/127\.0\.0\.1:\d+|ws:\/\/.*9280/],
  ["桥接令牌", /bridge-token|令牌.*打印|令牌.*复制/],
];
const missing = [];
for (const [name, re] of CONFIG) {
  if (!re.test(readme)) missing.push(name);
}
ok(`README 说清了 ${CONFIG.length} 个必填配置"填什么"`, missing.length === 0, missing);

// 闸门自证: 用两组对照样本证明判据能区分"给了具体值"与"只写配置一下"。
// (第一版这里用 `re.source.includes(...)` 自检正则源码, 是自指逻辑且把正则字符当判据 —— 恒红。)
{
  const vague = "桥接地址: 在选项页配置一下即可。";
  const concrete = "桥接地址默认 ws://127.0.0.1:9280/ext。";
  const bridgeRe = /ws:\/\/127\.0\.0\.1:\d+|ws:\/\/.*9280/;
  ok('闸门自证: 只写「配置一下」判红', !bridgeRe.test(vague), 'n/a');
  ok('闸门自证: 给出默认地址判绿', bridgeRe.test(concrete), 'n/a');
}

console.log(fails ? `\n=== options docs FAIL: ${fails} ===` : `\n=== options docs PASS (${sections.length} 小节) ===`);
process.exit(fails ? 1 : 0);