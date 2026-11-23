// check_bridge_errors.js —— 桥接错误语义契约(零依赖):
//   1. 线上协议码 ERR.* 与 errors.js 的 ERROR_HINTS **一一对应**(漏一个 → 客户端拿到裸异常);
//   2. 每条错误都带"下一步"(没有 hint 的错误等于让调用方瞎猜);
//   3. 渲染格式稳定: `错误[<code>]: <原因>` + 换行 + `下一步: <动作>`, 客户端可正则以码分流;
//   4. tools.js 不许再出现旧形态(`fail("...")` / 裸 `"错误: " + msg` / 手写未连接提示);
//   5. 异常兜底: 带 code 的异常按码查表并保留原始原因; 裸异常退化为 `error` 仍给下一步。
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const protocol = require(path.join(ROOT, "bridge-protocol.js"));
const TOOLS_SRC = fs.readFileSync(path.join(ROOT, "bridge", "src", "tools.js"), "utf8");

const fail = [];
const ok = (name, cond, got) => {
  if (cond) console.log("  OK " + name);
  else { fail.push(name); console.log("FAIL " + name + " → " + JSON.stringify(got)); }
};

(async () => {
  const E = await import("file:///" + path.join(ROOT, "bridge", "src", "errors.js").replace(/\\/g, "/"));

  // ---- 1. 码覆盖 ----
  const wireCodes = Object.values(protocol.ERR);
  const missing = wireCodes.filter((c) => !E.ERROR_HINTS[c]);
  const orphan = Object.keys(E.ERROR_HINTS).filter((c) => !wireCodes.includes(c));
  ok("线协议码全部有错误文案", missing.length === 0, missing);
  ok("错误文案表无孤儿码", orphan.length === 0, orphan);
  const localCodes = Object.values(E.LOCAL);
  const missingLocal = localCodes.filter((c) => !E.LOCAL_HINTS[c]);
  ok("业务码全部有错误文案", missingLocal.length === 0, missingLocal);

  // ---- 2. 每条都有 text + hint ----
  for (const [code, m] of Object.entries(E.ERROR_HINTS)) {
    ok(`${code} 有文案与下一步`, typeof m.text === "string" && m.text.length > 3
      && typeof m.hint === "string" && m.hint.length > 8, m);
  }
  for (const [code, h] of Object.entries(E.LOCAL_HINTS)) {
    ok(`${code} 有下一步`, typeof h === "string" && h.length > 8, h);
  }

  // ---- 3. 渲染格式 ----
  const rendered = E.describeError(E.LOCAL.NO_ENTRIES, "过滤后没有条目");
  ok("格式: 错误[code]: 原因", /^错误\[no_entries\]: 过滤后没有条目\n下一步: /.test(rendered), rendered);
  const withHint = E.describeError(E.LOCAL.BAD_ARGS, "缺少 id", "补 id: 先调 net_list 拿一条的 id");
  ok("hint 可覆盖(工具给更具体动作)", withHint.includes("下一步: 补 id: 先调 net_list"), withHint);
  const unknown = E.describeError("weird_code", "x");
  ok("未登记码退化仍给下一步", unknown.startsWith("错误[weird_code]: x") && unknown.includes("下一步: "), unknown);

  // ---- 4. 工具结果形态 ----
  const tf = E.toolFail(E.LOCAL.BAD_ARGS, "缺少 ref");
  ok("toolFail 是 isError=true 的文本结果", tf.isError === true
    && tf.content && tf.content[0].type === "text" && tf.content[0].text.includes("下一步: "), tf);
  const fx = E.fromException(Object.assign(new Error("扩展未连接"), { code: protocol.ERR.NOT_CONNECTED }));
  ok("异常带 code → 按码查表", fx.content[0].text.startsWith("错误[not_connected]: 扩展未连接"), fx.content[0].text);
  ok("异常带 code → 下一步来自码表", fx.content[0].text.includes("doctor.js"), fx.content[0].text);
  const bare = E.fromException(new Error("boom"));
  ok("裸异常退化为 error 码", bare.content[0].text.startsWith("错误[error]: boom"), bare.content[0].text);

  // ---- 5. tools.js 单一真相(不许回退到旧形态) ----
  ok("tools.js 引入 errors.js", /from "\.\/errors\.js"/.test(TOOLS_SRC), "缺少 import");
  ok("tools.js 无旧式 fail(\"...\")", !/\bfail\("/.test(TOOLS_SRC), (TOOLS_SRC.match(/\bfail\("[^\n]*/g) || []).slice(0, 2));
  ok("tools.js 无手写'错误: ' 前缀", !/"错误: "\s*\+/.test(TOOLS_SRC), "仍有手写前缀");
  ok("bridge_status 未连接提示来自码表", /ERROR_HINTS\.not_connected\.hint/.test(TOOLS_SRC), "未走单源");
  ok("tools.js 无旧未连接提示文案", !TOOLS_SRC.includes("填入 bridge 地址与令牌后点击"), "旧文案残留");
  // fail(...) 第一个参数必须是已知业务/线协议码(LOCAL.X 或字符串码)
  const badCalls = [...TOOLS_SRC.matchAll(/\bfail\(([^,\n]+),/g)].map((m) => m[1].trim())
    .filter((c) => !/^LOCAL\.[A-Z_]+$/.test(c) && !/^ERR\./.test(c) && !/^[a-z_.]+$/.test(c));
  ok("所有 fail() 首参都是码", badCalls.length === 0, badCalls);

  console.log(fail.length ? `=== bridge errors FAIL: ${fail.length} ===` : "=== bridge errors PASS ===");
  process.exit(fail.length ? 1 : 0);
})();
