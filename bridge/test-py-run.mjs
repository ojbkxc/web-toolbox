// bridge/test-py-run.mjs —— PY 导出物的"能真实运行"闸门(v1.1.99)
//
// 为什么需要: 此前 PY 导出的验证只到 **py_compile 通过**(能编译)。但 v1.1.99 实测发现:
// 导出脚本**开箱即崩** —— `main()` 显式传 `base_url=None`, 而 Python 默认参数只在"不传"时
// 生效, 显式传 None 会把默认值覆盖成 None → `url = None + "/path"` → TypeError。
// 也就是说 **每一份导出的 PY 脚本, 不改那一行就跑不起来**, 而编译检查完全看不出来。
//
// 判据(真实消费方): 用真实 python 运行导出脚本, 断言
//   ①脚本能启动到"发请求"这一步(不因参数处理崩);
//   ②错误必须是**网络层**的(a.test 不存在 → 连接/DNS/SSL 错误), 而不是 TypeError/NameError;
//   ③改 main 里那一行 base_url 后仍能跑(覆盖入口真的生效)。
// 本机无 python 时 SKIP 并打印原因, 不伪装通过。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

let pass = 0, fail = 0;
const ok = (name, cond, got) => {
  if (cond) { pass++; console.log("  OK " + name); }
  else { fail++; console.log("  FAIL " + name + " → " + JSON.stringify(got).slice(0, 220)); }
};

function hasPython() {
  for (const c of ["python", "python3", "py"]) {
    const r = spawnSync(c, ["-c", "print(1)"], { encoding: "utf8", timeout: 15000 });
    if (r.status === 0) return c;
  }
  return null;
}

const PY = hasPython();
if (!PY) {
  console.log("  SKIP(env) python 不可用 —— 跳过真实运行验证(不伪装通过)");
  console.log("\n=== py run PASS (skipped) ===");
  process.exit(0);
}
console.log("  使用 python:", PY);

const py = require(path.join(ROOT, "pyscript.js"));
const base = [{
  method: "GET", url: "https://a.test/plain", path: "/plain", query: "",
  headers: {}, body: "", status: 200, response: "{}", ts: "", durationMs: 1,
}];

const runGen = (code, dir, name) => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, code, "utf8");
  const r = spawnSync(PY, [p], { encoding: "utf8", timeout: 60000, cwd: dir });
  const out = (r.stdout || "") + (r.stderr || "");
  return { status: r.status, out };
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pyrun-"));

// ① 默认导出: 不得因参数处理崩(必须跑到网络层)
{
  const code = py.buildPyScript(base);
  const r = runGen(code, dir, "default.py");
  const paramCrash = /TypeError.*NoneType|NameError|AttributeError/.test(r.out);
  ok("默认导出能启动到发请求这一步(不因 base_url 为 None 而 TypeError)", !paramCrash, r.out.split("\n").filter((l) => /Error/.test(l))[0]);
  // 错误必须是网络层的(a.test 不存在)
  const netErr = /SSLError|ConnectionError|NameResolution|URLError|getaddrinfo|Max retries|Temporary failure/i.test(r.out);
  ok("失败原因是网络层(a.test 无法解析), 而不是脚本自身缺陷", netErr, r.out.split("\n").filter((l) => /Error/.test(l))[0]);
}

// ② 覆盖入口真的生效: 把 main 那行改成 http 的本地不可达地址, 错误类型应随之改变
{
  const code = py.buildPyScript(base).replace(
    'base_url = None  # 环境切换',
    'base_url = "http://127.0.0.1:9"  # 环境切换',
  );
  const r = runGen(code, dir, "override.py");
  ok("改 main 的 base_url 后仍能跑(覆盖入口生效)", !/NameError|AttributeError|NoneType/.test(r.out), r.out.split("\n").filter((l) => /Error/.test(l))[0]);
}

// ③ 源码级: step 的 base_url 必须是"可选覆盖"语义(None 回退录制 origin)
{
  const code = py.buildPyScript(base);
  // 两道保障缺一不可(v1.1.99 + R113 CI 各抓到一次):
  //   ①签名带默认值 <录制 origin> —— "不传"时生效, 也是按 base_url="..." 做字符串替换的落点;
  //   ②函数体内 base_url = base_url or <origin> —— "显式传 None"(main 的语义)时的回退。
  ok("step 签名保留 base_url=\"<录制 origin>\"(不传时生效, 且是字符串替换的落点)",
    /def step_\w+\(sess, ctx=None, base_url="https:\/\/a\.test"\)/.test(code), "签名形态不符");
  ok("step 内有 base_url or <录制 origin> 的回退(防 main 显式传 None)",
    /base_url = base_url or "https:\/\/a\.test"/.test(code), "缺回退行");
}

// ④ 恶意字符下的产物仍可运行(不执行注入代码)
{
  const evil = [{
    method: "GET", url: "https://a.test/x", path: "/x", query: "",
    headers: { "x-evil": 'a"); import os; os.system("echo PWNED"); #' },
    body: 'a"); import os; os.system("echo PWNED"); #',
    status: 200, response: "", ts: "", durationMs: 1,
  }];
  const r = runGen(py.buildPyScript(evil), dir, "evil.py");
  ok("注入尝试不会被执行(产物里没有 PWNED 副作用)", !/PWNED/.test(r.out), "出现 PWNED");
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n=== py run: ${pass} PASS / ${fail} FAIL ===`);
process.exit(fail ? 1 : 0);