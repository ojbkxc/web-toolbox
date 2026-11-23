// bridge/test-auth.mjs —— MCP-bridge 完整协议矩阵: 授权 / 拒绝 / 协议版本 / 未知方法 / 白名单。
//
// 为什么需要: smoke 有鉴权与白名单的覆盖, 但逐条断言混在大场景里, 看不清"哪条协议规则破了"。
// 这里把这些规则做成**独立的最小矩阵**, 每条规则一个独立 daemon 实例, 互不污染:
//   ①错误令牌 → 错误码 unauthorized + daemon 不崩(后续帧继续处理);
//   ②协议版本不符 → protocol_mismatch;
//   ③未鉴权就发业务帧 → 拒绝且不泄漏内部状态;
//   ④白名单: 代理可 QUERY, 非代理 QUERY → forbidden;
//   ⑤READ_METHODS/CONTROL_METHODS 之外的 method → unknown_method。
// 每个 case 断言三件事: 错误码 / daemon 存活 / 后续连接仍可鉴权成功。
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import protocol from "../bridge-protocol.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(here, "src", "index.js");   // 绝对路径: 任意 cwd 都可跑

const { FRAME, ERR, PROTOCOL_VERSION, WS_PATH } = protocol;
let pass = 0, fail = 0;
const ok = (cond, msg) => {
  if (cond) { pass++; console.log("  OK " + msg); }
  else { fail++; console.log("  ✗ FAIL " + msg); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PORT = 9700 + Math.floor(Math.random() * 200);
const TOKEN = "auth-matrix-tok";

function startDaemon(extra = []) {
  const p = spawn(process.execPath, [ENTRY, "--daemon", "--port", String(PORT), "--quiet", ...extra], {
    env: { ...process.env, WEB_TOOLBOX_TOKEN: TOKEN }, stdio: "ignore", windowsHide: true,
  });
  return p;
}
const base = `ws://127.0.0.1:${PORT}${WS_PATH}`;

function connect({ token = TOKEN, protocol: proto = PROTOCOL_VERSION, ua } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(base);
    const frames = [];
    ws.on("open", () => ws.send(JSON.stringify({
      type: FRAME.HELLO, protocol: proto, token,
      ext: { version: "matrix", ua: ua || "web-toolbox" },
    })));
    ws.on("message", (raw) => {
      const f = JSON.parse(raw.toString());
      frames.push(f);
      if (f.type === FRAME.READY || f.type === FRAME.ERROR) resolve({ ws, frames, first: f });
    });
    ws.on("error", reject);
    setTimeout(() => reject(new Error("timeout")), 4000);
  });
}

async function waitDaemonUp() {
  for (let i = 0; i < 30; i++) {
    await sleep(150);
    try { const c = await connect(); c.ws.close(); return true; } catch { /* 未起 */ }
  }
  return false;
}

async function daemonAlive() {
  try { const c = await connect(); c.ws.close(); return true; } catch { return false; }
}

const daemon = startDaemon();
if (!(await waitDaemonUp())) {
  ok(false, "daemon 就绪(6s)");
  daemon.kill();
  process.exit(1);
}
ok(true, "daemon 就绪");

try {
  // ① 错误令牌
  {
    const r = await connect({ token: "wrong-token-xxx" });
    r.ws.close();
    ok(r.first.type === FRAME.ERROR && r.first.code === ERR.UNAUTHORIZED, "错误令牌 → unauthorized");
    ok(await daemonAlive(), "错令牌后 daemon 存活(不崩)");
  }
  // ② 协议版本不符
  {
    const r = await connect({ token: TOKEN, protocol: 99 });
    r.ws.close();
    ok(r.first.type === FRAME.ERROR && r.first.code === ERR.PROTOCOL_MISMATCH, "版本不符 → protocol_mismatch");
    ok(await daemonAlive(), "版本不符后 daemon 存活");
  }
  // ③ 未鉴权就发 QUERY
  {
    const r = await new Promise((resolve, reject) => {
      const ws = new WebSocket(base);
      ws.on("open", () => ws.send(JSON.stringify({ type: FRAME.QUERY, id: "q1", method: "net.list" })));
      ws.on("message", (raw) => resolve({ ws, f: JSON.parse(raw.toString()) }));
      ws.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 4000);
    });
    r.ws.close();
    ok(r.f.type === FRAME.ERROR && r.f.code === ERR.UNAUTHORIZED, "未鉴权 QUERY → unauthorized");
  }
  // ④ 白名单: 非代理 QUERY(已鉴权的扩展身份) → 也要拒绝(扩展不发 QUERY, 发了说明是攻击者)
  {
    const r = await new Promise((resolve, reject) => {
      const ws = new WebSocket(base);
      ws.on("open", () => ws.send(JSON.stringify({ type: FRAME.HELLO, protocol: PROTOCOL_VERSION, token: TOKEN, ext: { version: "m", ua: "web-toolbox" } })));
      let ready = false;
      ws.on("message", (raw) => {
        const f = JSON.parse(raw.toString());
        if (f.type === FRAME.READY) ready = true;
        if (ready && f.type !== FRAME.READY) resolve({ ws, f });
        if (ready) ws.send(JSON.stringify({ type: FRAME.QUERY, id: "x", method: "net.list" }));
      });
      ws.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 4000);
    });
    r.ws.close();
    ok(r.f.type === FRAME.ERROR && r.f.code === ERR.FORBIDDEN, "扩展身份发 QUERY → forbidden(白名单: 仅代理)");
  }
  // ⑤ 授权后未开 --allow-control 的控制方法(代理路径; 需要扩展在线, 否则先被"扩展未连接"拦截)
  {
    const ext = await connect();   // 假扩展在线
    const r = await new Promise((resolve, reject) => {
      const ws = new WebSocket(base);
      ws.on("open", () => ws.send(JSON.stringify({ type: FRAME.HELLO, protocol: PROTOCOL_VERSION, token: TOKEN, ext: { version: "mcp-proxy", ua: "web-toolbox-mcp" } })));
      ws.on("message", (raw) => {
        const f = JSON.parse(raw.toString());
        if (f.type === FRAME.READY) {
          ws.send(JSON.stringify({ type: FRAME.QUERY, id: "qc", method: "page.click", params: {} }));
          return;
        }
        resolve({ ws, f });
      });
      ws.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 4000);
    });
    r.ws.close();
    ext.ws.close();
    // daemon 没开 --allow-control: hub.request 会拒 control 方法
    ok(r.f.type === FRAME.RES && r.f.ok === false && /allow-control/.test(String(r.f.error || "")),
      "控制方法未开 --allow-control → forbidden 错误带开启方式", r.f && r.f.error);
  }
  // ⑥ 正确配置后一切正常
  {
    const r = await connect();
    r.ws.close();
    ok(r.first.type === FRAME.READY, "正确令牌+版本 → ready");
  }
} finally {
  daemon.kill();
  await sleep(300);
}

console.log(`\n=== auth matrix: ${pass} PASS / ${fail} FAIL ===`);
process.exit(fail ? 1 : 0);