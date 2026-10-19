// check_pychain.js —— PY 脚本导出应用 AI 参数链:
//   1. 生成脚本 py_compile 可过
//   2. 无链时与旧形态兼容(step_X(sess, ctx), ctx 默认 {})
//   3. 链定位: id 优先/下标兜底/源不在集跳过/倒序跳过
//   4. 生成脚本真实跑(mock server): login 提取 → save body 注入 → list query 注入, server 侧断言
// 运行前提: mock server 在 18999(脚本自带起停, 用完即杀)
const { execSync, spawn } = require("child_process");
const ROOT = require('path').resolve(__dirname, '..');
const fs = require("fs");
const os = require("os");
const path = require("path");

const P = require(ROOT + "/pyscript.js");
let fails = 0;
const ok = (name, cond, got) => {
  if (!cond) { fails++; console.log("FAIL " + name + " → " + JSON.stringify(got)); }
  else console.log("  OK " + name);
};

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "pychain_"));

// ---- mock server ----
const SERVER_SRC = `
import json
from http.server import BaseHTTPRequestHandler, HTTPServer
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _r(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)
    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n).decode("utf-8", "replace")
        if self.path == "/login":
            self._r(200, {"resultCode": "0", "data": {"orderNo": "LIVE123"}})
        elif self.path == "/save":
            self._r(200, {"resultCode": "0", "ok": "LIVE123" in body, "seen": body[:120]})
        elif self.path == "/save-form":
            self._r(200, {"resultCode": "0", "ok": "orderNo=LIVE123" in body, "seen": body[:120]})
        elif self.path == "/login-va":
            self._r(200, {"resultCode": "0", "data": {"orderNo": "LIVE\\\\g<1>123"}})
        elif self.path == "/save-va":
            self._r(200, {"resultCode": "0", "ok": ('"orderNo": "LIVE\\\\g<1>123"' in body) and ('"orderNo":"KEEP"' in body), "seen": body[:200]})
        else:
            self._r(404, {"resultCode": "404"})
    def do_GET(self):
        if self.path.startswith("/list?orderNo=LIVE123"):
            self._r(200, {"resultCode": "0", "ok": True})
        elif self.path.startswith("/detail/orderNo/LIVE123"):
            self._r(200, {"resultCode": "0", "ok": True})
        else:
            self._r(200, {"resultCode": "0", "ok": False, "seen": self.path})
HTTPServer(("127.0.0.1", 18999), H).serve_forever()
`;
const serverFile = path.join(WORK, "srv.py");
fs.writeFileSync(serverFile, SERVER_SRC, "utf-8");
const srv = spawn("python", ["-X", "utf8", serverFile], { stdio: "ignore" });
// 等 server 起来
execSync("python - <<'EOF'\nimport time, urllib.request\nfor _ in range(50):\n    try:\n        urllib.request.urlopen('http://127.0.0.1:18999/login', data=b'{}', timeout=1)\n        break\n    except Exception:\n        time.sleep(0.1)\nEOF", { shell: "bash" });

(async () => {
  try {
    const mkEntries = () => ([
      { id: "p0", method: "POST", url: "https://h.com/login", path: "/login", query: "", headers: {}, body: "{}", status: 200, response: "", ts: "" },
      { id: "p1", method: "POST", url: "https://h.com/save", path: "/save", query: "", headers: {}, body: '{"orderNo":"OLD","x":1}', status: 200, response: "", ts: "" },
      { id: "p2", method: "GET", url: "https://h.com/list?orderNo=OLD", path: "/list", query: "orderNo=OLD", headers: {}, body: "", status: 200, response: "", ts: "" },
      { id: "p3", method: "GET", url: "https://h.com/detail/orderNo/OLD", path: "/detail/orderNo/OLD", query: "", headers: {}, body: "", status: 200, response: "", ts: "" },
      { id: "p4", method: "POST", url: "https://h.com/save-form", path: "/save-form", query: "", headers: {}, body: "orderNo=OLD&x=1", status: 200, response: "", ts: "" },
      { id: "p5", method: "POST", url: "https://h.com/login-va", path: "/login-va", query: "", headers: {}, body: "{}", status: 200, response: "", ts: "" },
      { id: "p6", method: "POST", url: "https://h.com/save-va", path: "/save-va", query: "", headers: {}, body: '{"inner":{"orderNo":"KEEP"},"orderNo":"OLD"}', status: 200, response: "", ts: "" },
    ]);
    const chain = [
      { from: 0, fromId: "p0", fromJsonPath: "data.orderNo", to: 1, toId: "p1", toParam: "orderNo", var: "v_ord", value: "" },
      { from: 0, fromId: "p0", fromJsonPath: "data.orderNo", to: 2, toId: "p2", toParam: "url.orderNo", var: "v_ord", value: "" },
      { from: 0, fromId: "p0", fromJsonPath: "data.orderNo", to: 3, toId: "p3", toParam: "url.orderNo", var: "v_ord", value: "" },
      { from: 0, fromId: "p0", fromJsonPath: "data.orderNo", to: 4, toId: "p4", toParam: "orderNo", var: "v_ord", value: "" },
      { from: 5, fromId: "p5", fromJsonPath: "data.orderNo", to: 6, toId: "p6", toParam: "orderNo", var: "v_va", value: "OLD" },
    ];
    const script = P.buildPyScript(mkEntries(), "cookies.state.json", { aiChain: chain });

    // 1. py_compile
    const py = path.join(WORK, "gen.py");
    fs.writeFileSync(py, script, "utf-8");
    execSync(`python -m py_compile "${py.replace(/\\/g, "/")}"`, { shell: "bash" });
    ok("生成脚本 py_compile 过", true);

    // 2. 形态: step 定义带 ctx
    ok("def 带 ctx 参数", /def step_\w+\(sess, ctx=None,/.test(script), script.match(/def step_\w+\([^)]*\)/)?.[0]);
    ok("main 用共享 ctx", /ctx = \{\}.*AI 参数链/.test(script), script.match(/ctx = \{[^}]*\}/)?.[0]);
    ok("pick 函数已生成(链场景)", script.includes("def pick(obj, path):"), "");
    // 值锚定 + repl lambda 化(v1.0.97): 链带录制值时生成 _new 先试值锚定; JSON 注入的
    // repl 必须是 lambda —— 字符串 repl 形态下 ctx 值含 \g/\1 会被 re.sub 当组引用
    // 解释(re.error 或静默毁 payload)。
    ok("值锚定分支生成(_new 形态)", script.includes("_new = re.sub"), "");
    ok("JSON 注入 repl 是 lambda(防 \\g 组引用)", script.includes("lambda m: " + P.pyStr('"orderNo": "') + " + str(ctx["), "");

    // 2b. GBK 控制台编码防线: 生成的脚本必须自带 reconfigure(⚠/✓ 等 print 字符
    //     在 Windows GBK 控制台直接 UnicodeEncodeError, 降级路径比正常路径先死)
    ok("含 stdout reconfigure(utf-8)", /sys\.stdout\.reconfigure\(encoding="utf-8", errors="replace"\)/.test(script), "");
    ok("含 stderr reconfigure(带 hasattr 保护)", /hasattr\(sys\.stdout, "reconfigure"\)/.test(script), "");

    // 3. 无链时脚本不含 pick/注入
    const plain = P.buildPyScript(mkEntries().slice(0, 1), "cookies.state.json", {});
    ok("无链时不生成 pick", !plain.includes("def pick"), "");

    // 4. 定位规则: 源不在集(裁剪) → 不生成对应注入
    const cut = P.buildPyScript(mkEntries().slice(1), "cookies.state.json", { aiChain: chain });
    ok("源不在集 → 无注入行", !cut.includes("ctx.get(") || cut.indexOf("v_ord") === -1 || !/payload = re\.sub/.test(cut), cut.match(/ctx\.get[^)]*\)/)?.[0]);

    // 4b. PY/JMX 变量名同源对拍(v1.0.62, #155 方向②): 同一链集喂两导出器,
    //     JMX JSONPostProcessor referenceNames 与 PY ctx 存入键必须同名 ——
    //     变量名分叉 = 用户在 JMX 里看到 ${vx}、在 PY 里看到 ctx["vy"],
    //     跨工具链对照回放结果时对不上号(链语义相同但变量名漂移)。
    //     两导出器都消费 chain[].var 原文 → 结构上同源, 这里钉住防未来一方加前缀/改名。
    {
      const vm = require("vm");
      const mods = {};
      const req = (n) => {
        const key = n.replace(/^\.?\//, "").replace(/\.js$/, "");
        if (mods[key]) return mods[key];
        const realm = { console, URL, URLSearchParams, require: (m) => req(m), module: { exports: {} } };
        vm.createContext(realm);
        new vm.Script(fs.readFileSync(ROOT + "/" + key + ".js", "utf8"), { filename: key + ".js" }).runInContext(realm);
        mods[key] = realm.module.exports;
        return mods[key];
      };
      const common = req("./common"); // applyAiChainToJmx 在 common.js(jmx.js 只管渲染)
      const pairChain = [
        { from: 0, fromId: "q0", fromJsonPath: "data.token", to: 1, toId: "q1", toParam: "body.token", var: "v_tok", value: "T1" },
        { from: 0, fromId: "q0", fromJsonPath: "data.ord", to: 1, toId: "q1", toParam: "body.orderNo", var: "V_orderNo", value: "O1" },
      ];
      const pairEntries = [
        { id: "q0", method: "POST", url: "https://h.com/login", path: "/login", query: "", headers: {}, body: "{}", status: 200, response: '{"data":{"token":"T1","ord":"O1"}}', ts: "" },
        { id: "q1", method: "POST", url: "https://h.com/save", path: "/save", query: "", headers: {}, body: '{"token":"OLD","orderNo":"X9"}', status: 200, response: "{}", ts: "" },
      ];
      const jmxApplied = common.applyAiChainToJmx(pairEntries.map((e) => ({ ...e })), pairChain);
      const jmxVars = [...new Set(jmxApplied.flatMap((e) => (e._extractors || []).map((x) => x.var)))].sort();
      const pyText = P.buildPyScript(pairEntries.map((e) => ({ ...e })), "cookies.state.json", { aiChain: pairChain });
      const pyVars = [...new Set([...pyText.matchAll(/ctx\["([^"]+)"\] = _val/g)].map((m) => m[1]))].sort();
      ok("PY/JMX 提取变量名同源", JSON.stringify(jmxVars) === JSON.stringify(pyVars), { jmx: jmxVars, py: pyVars });
      ok("JMX body 注入与 PY 注入同名变量", jmxApplied[1].body.includes('"${v_tok}"') && pyText.includes('ctx["v_tok"]'), jmxApplied[1].body);
    }

    // 5. 真实执行(server 断言)
    fs.writeFileSync(py, script.replace(/base_url="https:\/\/h\.com"/g, 'base_url="http://127.0.0.1:18999"'), "utf-8");
    const drive = `
import json, re, urllib.parse
src = open(${JSON.stringify(py.replace(/\\/g, "/"))}, encoding="utf-8").read()
head = src[:src.index("def main():")]
ns = {"__file__": ${JSON.stringify(py.replace(/\\/g, "/"))}}
exec(compile(head, "gen.py", "exec"), ns)
import requests
sess = requests.Session()
ctx = {}
ns["step_login"](sess, ctx)
assert ctx.get("v_ord") == "LIVE123", ctx
r = ns["step_save"](sess, ctx)
assert r.json().get("ok") is True, r.json()
r2 = ns["step_list"](sess, ctx)
assert r2.json().get("ok") is True, r2.json()
r3 = ns["step_detail_orderNo_OLD"](sess, ctx) if "step_detail_orderNo_OLD" in ns else None
r4 = ns["step_save_form"](sess, ctx)
assert r4.json().get("ok") is True, r4.json()
rc = ns["step_save"](sess, {})
assert rc.json().get("ok") is False, "无链对照应保持录制值"
ns["step_login_va"](sess, ctx)
assert ctx.get("v_va") == "LIVE\\\\g<1>123", ctx
r5 = ns["step_save_va"](sess, ctx)
assert r5.json().get("ok") is True, r5.json()
r5b = ns["step_save_va"](sess, {})
assert r5b.json().get("ok") is False, "无 ctx 对照应保持录制原样(inner 未被动)"
print("PYCHAIN-E2E-OK")
`;
    const driveFile = path.join(WORK, "drive.py");
    fs.writeFileSync(driveFile, drive, "utf-8");
    const out = execSync(`python -X utf8 "${driveFile.replace(/\\/g, "/")}"`, { shell: "bash", encoding: "utf-8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
    ok("E2E: 提取+body/query/路径段/表单/值锚定/转义注入全过(server 断言)", out.includes("PYCHAIN-E2E-OK"), out.slice(-200));
  } finally {
    srv.kill();
    fs.rmSync(WORK, { recursive: true, force: true });
  }
  console.log(fails ? `=== FAIL ${fails} ===` : "=== PY 链注入 PASS ===");
  process.exit(fails ? 1 : 0);
})();
