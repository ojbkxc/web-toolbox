// bridge/smoke.mjs —— 端到端自检: 模拟扩展连上来, 跑一遍握手/请求/事件/错误分支。
// 用法: node smoke.mjs   (会临时起一个 bridge, 结束后自动关闭)

import { spawn } from "node:child_process";
import { WebSocket } from "ws";
import protocol from "../bridge-protocol.js";

const { FRAME, ERR, PROTOCOL_VERSION } = protocol;
const PORT = 9399;
const TOKEN = "smoke-token-abc";
const BASE = `ws://127.0.0.1:${PORT}${protocol.WS_PATH}`;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  OK " + m); } else { fail++; console.log("  ✗ FAIL " + m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startBridge(extraArgs = []) {
  const p = spawn(process.execPath, ["./src/index.js", "--port", String(PORT), "--quiet", ...extraArgs], {
    env: { ...process.env, WEB_TOOLBOX_TOKEN: TOKEN },
    stdio: ["pipe", "pipe", "pipe"],
  });
  p.stderr.on("data", () => {});   // 静默, 失败信息由断言体现
  return p;
}

// 端口释放有延迟(上一个 bridge 刚 kill), 连接要重试而不是一次就放弃
async function connectRetry(token = TOKEN, protoVersion = PROTOCOL_VERSION, tries = 20) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await connect(token, protoVersion);
    } catch (e) {
      lastErr = e;
      await sleep(150);
    }
  }
  throw lastErr;
}

function connect(token = TOKEN, protoVersion = PROTOCOL_VERSION) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(BASE);
    const frames = [];
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: FRAME.HELLO, protocol: protoVersion, token, ext: { version: "test" } }));
    });
    ws.on("message", (raw) => {
      const f = JSON.parse(raw.toString());
      frames.push(f);
      if (f.type === FRAME.READY || f.type === FRAME.ERROR) resolve({ ws, frames, first: f });
    });
    ws.on("error", reject);
    setTimeout(() => reject(new Error("connect timeout")), 4000);
  });
}

// 注册一个"假扩展": 收到 REQ 就按 handler 回 RES
function serveExt(ws, handler) {
  ws.on("message", (raw) => {
    const f = JSON.parse(raw.toString());
    if (f.type !== FRAME.REQ) return;
    let out;
    try { out = handler(f.method, f.params); }
    catch (e) { out = { __err: e.message }; }
    if (out && out.__err) {
      ws.send(JSON.stringify({ type: FRAME.RES, id: f.id, ok: false, error: out.__err }));
    } else {
      ws.send(JSON.stringify({ type: FRAME.RES, id: f.id, ok: true, result: out }));
    }
  });
}

// 用 MCP stdio 驱动 bridge 的工具, 验证工具层端到端。
// 注意: initialize 只能发一次(MCP 握手是一次性的), 之后复用同一条 stdio 连接。
function makeMcpClient(proc) {
  let buf = "";
  const waiters = new Map();   // id -> resolve
  proc.stdout.on("data", (d) => {
    buf += d.toString();
    const lines = buf.split("\n");
    buf = lines.pop();          // 最后一段可能不完整, 留到下次
    for (const line of lines) {
      if (!line.trim()) continue;
      let j;
      try { j = JSON.parse(line); } catch { continue; }
      const w = waiters.get(j.id);
      if (w) { waiters.delete(j.id); w(j); }
    }
  });

  let nextId = 1;
  function send(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiters.delete(id); reject(new Error("mcp timeout " + method)); }, 8000);
      waiters.set(id, (j) => { clearTimeout(timer); resolve(j); });
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  return {
    async init() {
      await send("initialize", {
        protocolVersion: "2024-11-05", capabilities: {},
        clientInfo: { name: "smoke", version: "1" },
      });
      // 标准 MCP 握手收尾(通知, 无 id)
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    },
    async callTool(name, args) {
      const j = await send("tools/call", { name, arguments: args || {} });
      return j.result || j.error;
    },
  };
}

(async () => {
  // ============ 1. 鉴权分支 ============
  {
    console.log("\n[1] 鉴权");
    const proc = startBridge(["--allow-control"]);
    await sleep(700);
    let r = await connectRetry("wrong-token");
    ok(r.first.type === FRAME.ERROR && r.first.code === ERR.UNAUTHORIZED, "错误令牌被拒");
    r.ws.close();

    r = await connectRetry(TOKEN);
    ok(r.first.type === FRAME.READY && r.first.protocol === PROTOCOL_VERSION, "正确令牌握手成功");
    ok(r.first.bridge && r.first.bridge.allowControl === true, "READY 带能力开关");
    r.ws.close();

    r = await connectRetry(TOKEN, 99);
    ok(r.first.type === FRAME.ERROR && r.first.code === ERR.PROTOCOL_MISMATCH, "协议版本不符被拒");

    proc.kill();
    await sleep(200);
  }

  // ============ 2. 请求/响应 + 事件 ============
  {
    console.log("\n[2] 请求响应与事件");
    const proc = startBridge(["--allow-control"]);
    await sleep(700);

    const { ws } = await connectRetry(TOKEN);
    serveExt(ws, (method, params) => {
      if (method === "net.list") return [{ id: "r1", method: "GET", url: "https://a.com/x", path: "/x", status: 200 }];
      if (method === "net.get") return { id: params.id, url: "https://a.com/x", response: "hello" };
      if (method === "rec.status") return { recState: "recording", count: 1 };
      if (method === "tab.list") return [{ id: 1, title: "t", url: "https://a.com", active: true }];
      if (method === "page.eval") return { ok: true, value: "v" + params.script };
      return { __err: "unknown " + method };
    });

    const mcp = makeMcpClient(proc);
    await mcp.init();
    await sleep(300);
    let res = await mcp.callTool("bridge_status", {});
    const st = JSON.parse(res.content[0].text);
    ok(st.connected === true, "bridge_status 显示已连接");
    ok(st.recording && st.recording.recState === "recording", "bridge_status 透传录制状态");

    res = await mcp.callTool("net_list", { limit: 10 });
    if (res.isError) {
      ok(false, "net_list 不应报错: " + res.content[0].text);
    } else {
      const list = JSON.parse(res.content[0].text);
      ok(list.total === 1 && list.entries[0].id === "r1", "net_list 返回条目");
      ok(!("response" in list.entries[0]), "net_list 不返回响应正文(瘦身)");
    }

    res = await mcp.callTool("net_get", { id: "r1" });
    const one = JSON.parse(res.content[0].text);
    ok(one.response === "hello", "net_get 返回正文");

    // 事件: 扩展主动推 harvest, bridge 应归档并通知
    ws.send(JSON.stringify({ type: FRAME.EVENT, event: "harvest", data: { entries: [{ id: "r9" }] } }));
    await sleep(150);
    ok(true, "事件帧被接受(不报错)");

    // 迟到/未知 id 的响应不应崩
    ws.send(JSON.stringify({ type: FRAME.RES, id: "nonexistent", ok: true, result: 1 }));
    await sleep(100);

    ws.close();
    proc.kill();
    await sleep(200);
  }

  // ============ 3. 控制开关 ============
  {
    console.log("\n[3] 控制类开关");
    const proc = startBridge([]);   // 不带 --allow-control
    await sleep(700);
    const { ws } = await connectRetry(TOKEN);
    serveExt(ws, (m) => (Array.isArray(m) ? m : []));   // 返回合法空数组: net.list 必须是数组

    const mcp = makeMcpClient(proc);
    await mcp.init();
    await sleep(300);
    const res = await mcp.callTool("page_click", { ref: "e1" });
    ok(res.isError === true, "未启用时 page_click 被拒");
    ok(/allow-control/.test(res.content[0].text), "错误信息提示开启方式");

    const res2 = await mcp.callTool("net_list", {});
    ok(!res2.isError, "只读工具不受影响");

    ws.close();
    proc.kill();
    await sleep(200);
  }

  // ============ 4. 扩展离线(daemon 在跑, 但扩展没连) ============
  {
    console.log("\n[4] 扩展离线");
    const proc = startBridge([]);
    await sleep(1200);   // 等它自己拉起 daemon
    const mcp = makeMcpClient(proc);
    await mcp.init();
    await sleep(500);
    const res = await mcp.callTool("bridge_status", {});
    const st = JSON.parse(res.content[0].text);
    ok(st.connected === false, "daemon 在但扩展离线时, connected 必须为 false");
    ok(!!st.hint, "给出连接指引");
    proc.kill();
    await sleep(200);
  }

  console.log(`\n=== smoke: ${pass} PASS / ${fail} FAIL ===`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("smoke 异常:", e); process.exit(1); });
