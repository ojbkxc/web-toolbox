#!/usr/bin/env node
// index.js —— bridge 主进程。
//
// 两种运行模式, 解决的问题不同:
//
//   daemon (常驻)  node src/index.js --daemon
//     · 只开 WebSocket 端口, 监听扩展连接。不接 MCP stdio。
//     · 扩展要连的是【长连接】, 必须有个进程一直活着。MCP 客户端是"用的时候才 spawn"
//       的语义, 靠它维持长连接会断(这也是扩展侧"连接失败"的根因)。
//     · 建议开机自启(见 bridge/README.md)。
//
//   mcp (默认)     node src/index.js --allow-control
//     · MCP stdio server, 由 AI 客户端 spawn。
//     · 内部先尝试【连接已在运行的 daemon】并通过它转发; daemon 不在时自己起一个 WS
//       (此时扩展连它也工作, 但 AI 客户端退出后端口就没了)。
//     · 这样单进程也能用, 配 daemon 则常驻更稳。
//
// ⚠ stdout 只能写 MCP 协议帧。所有日志走 stderr。

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Hub } from "./hub.js";
import { Archive } from "./archive.js";
import { registerTools } from "./tools.js";
import { parseArgs, resolveToken } from "./config.js";
import protocol from "../../bridge-protocol.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "0.1.0";
const opts = parseArgs(process.argv.slice(2));
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function log(...args) {
  if (!opts.quiet) process.stderr.write("[web-toolbox-bridge] " + args.join(" ") + "\n");
}

if (opts.help) {
  process.stderr.write(`web-toolbox-bridge ${VERSION}

用法:
  node src/index.js --daemon [--port 9280]     常驻: 只监听扩展连接(推荐开机自启)
  node src/index.js [--allow-control]          MCP stdio server(AI 客户端自动拉起)

选项:
  --daemon              常驻模式(不开 MCP stdio)
  --host <ip>           监听地址, 默认 127.0.0.1
  --port <n>            监听端口, 默认 9280
  --token <value>       共享令牌(默认读 ~/.web-toolbox/bridge-token)
  --token-file <path>   令牌文件路径
  --allow-control       启用控制类工具(点击/输入/导航/录制)
  --archive-dir <path>  抓包归档目录(默认 ~/.web-toolbox/archive)
  --quiet               不输出日志

典型用法: 先起 daemon, 再让 AI 客户端连。
  node src/index.js --daemon --allow-control
`);
  process.exit(0);
}

const { token, source } = resolveToken(opts);
if (source === "generated") {
  log(`已生成新令牌, 保存到 ${opts.tokenPath}`);
  log(`请把这串令牌填进扩展配置页: ${token}`);
}

// ============================================================ daemon 模式
// 只开 WS, 保持进程常驻, 不接 MCP。
async function runDaemon() {
  const archive = new Archive(opts.archiveDir);
  if (!(await archive.init())) log(`归档目录不可写, 归档关闭: ${opts.archiveDir}`);

  const hub = new Hub({
    host: opts.host, port: opts.port, token,
    allowControl: opts.allowControl, log,
  });
  hub.on("event", (event, data) => {
    if (event === "harvest" && data && Array.isArray(data.entries)) {
      archive.append(data.entries, { batchId: data.batchId });
    }
  });
  hub.on("connected", (info) => log(`扩展已连接: ${JSON.stringify(info)}`));
  hub.on("disconnected", () => log("扩展已断开, 等待重连..."));

  try {
    await hub.start();
  } catch (e) {
    if (e && e.code === "EADDRINUSE") {
      log(`端口 ${opts.port} 已在监听 —— 已有 daemon 在跑, 本进程退出。`);
      process.exit(0);
    }
    log(`启动失败: ${e && e.message ? e.message : e}`);
    process.exit(1);
  }

  log(`模式: daemon (常驻) · 协议版本 ${protocol.PROTOCOL_VERSION}`);
  log(`扩展应连接: ws://${opts.host}:${opts.port}${protocol.WS_PATH}`);
  log(`令牌来源: ${source}`);
  log(`控制类工具: ${opts.allowControl ? "启用" : "关闭(加 --allow-control)"}`);
  log("等待扩展连接... (Ctrl+C 退出)");

  const shutdown = async (sig) => {
    log(`收到 ${sig}, 关闭...`);
    archive.close();
    try { await hub.stop(); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("uncaughtException", (e) => log("未捕获异常: " + (e && e.stack || e)));
  process.on("unhandledRejection", (e) => log("未处理 rejection: " + (e && e.stack || e)));
  // 常驻进程不监听 stdin 结束(Windows 下无控制台时 stdin 可能立刻 EOF)。
  // 用永不 resolve 的 Promise 挂住进程 —— 直接 return 会让调用方继续往下跑 MCP 段。
  await new Promise(() => {});
}

// ============================================================ 入口分发
// 注意: 这里只声明, 实际调用在本文件最末尾 —— hub/proxyMode 是 let 声明,
// 在声明之前调用会触发 TDZ(ReferenceError: Cannot access before initialization)。
const MODE = opts.daemon ? "daemon" : "mcp";

// ============================================================ mcp 模式
// 优先连已有 daemon(端口在听), 复用它的扩展连接; 连不上就自己起 WS。
// hub/proxyMode 用顶层变量: registerTools 在函数外使用它们。
let hub = null;
let proxyMode = false;

async function runMcpMode() {
const daemonUrl = `ws://${opts.host}:${opts.port}${protocol.WS_PATH}`;

// 探测: 用最小 WebSocket 握手看端口是否有 bridge
async function probeDaemon() {
  const { WebSocket } = await import("ws");
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let ws;
    try { ws = new WebSocket(daemonUrl); } catch { return finish(false); }
    const timer = setTimeout(() => { try { ws.terminate(); } catch { /* */ } finish(false); }, 1200);
    ws.on("open", () => {
      clearTimeout(timer);
      // 发 hello 验证令牌; 对方回 ready 说明是同一套 bridge
      ws.send(JSON.stringify({
        type: protocol.FRAME.HELLO, protocol: protocol.PROTOCOL_VERSION,
        token, ext: { version: "mcp-proxy", ua: "web-toolbox-mcp" },
      }));
      // 收到任何帧即认为 daemon 存在(令牌不对也算"存在")
      ws.once("message", () => { try { ws.close(); } catch { /* */ } finish(true); });
    });
    ws.on("error", () => { clearTimeout(timer); finish(false); });
    ws.on("close", () => { clearTimeout(timer); finish(false); });
  });
}

async function spawnDaemon() {
  // 后台拉起 daemon, 脱离当前进程的 stdio
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, [
    path.join(__dirname, "index.js"),
    "--daemon",
    "--host", opts.host,
    "--port", String(opts.port),
    "--token-file", opts.tokenPath,
    "--archive-dir", opts.archiveDir,
    ...(opts.allowControl ? ["--allow-control"] : []),
  ], { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
  // 等它把端口起好
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (await probeDaemon()) return true;
  }
  return false;
}

// 代理 Hub: 保持一条到 daemon 的连接, 把 request() 转过去。
// 接口与 Hub 保持一致(connected / extInfo / request / stop), 工具层不需要区分。
async function createProxyHub(WS) {
  // extOnline 与 connected 不是一回事:
  //   connected  = 代理连上了 daemon(自己活着)
  //   extOnline  = daemon 那边有扩展在线(真正能干活)
  // 工具层的 connected 判定必须用 extOnline, 否则扩展没开时 bridge_status 会误报已连接。
  const state = { ws: null, pending: new Map(), extInfo: null, connected: false, extOnline: false };
  let reconnectTimer = null;

  function connect() {
    return new Promise((resolve) => {
      const ws = new WS(daemonUrl);
      state.ws = ws;
      let settled = false;
      const settle = (v) => { if (!settled) { settled = true; resolve(v); } };
      const timer = setTimeout(() => { try { ws.terminate(); } catch { /* */ } settle(false); }, 3000);

      ws.on("open", () => {
        ws.send(JSON.stringify({
          type: protocol.FRAME.HELLO, protocol: protocol.PROTOCOL_VERSION,
          token, ext: { version: "mcp-proxy", ua: "web-toolbox-mcp" },
        }));
      });
      ws.on("message", (raw) => {
        clearTimeout(timer);
        let f;
        try { f = JSON.parse(raw.toString()); } catch { return; }
        if (f.type === protocol.FRAME.READY) {
          state.connected = true;
          state.extInfo = f.bridge || {};
          state.extOnline = !!(f.bridge && f.bridge.extensionOnline);
          settle(true);
          return;
        }
        // 扩展上下线通知
        if (f.type === protocol.FRAME.EVENT && f.event === "ext.status") {
          state.extOnline = !!(f.data && f.data.online);
          state.extInfo = (f.data && f.data.extension) || state.extInfo;
          return;
        }
        // daemon 会把"扩展的实际状态"也通过事件/查询暴露; 这里只处理应答
        if (f.type === protocol.FRAME.RES) {
          const p = state.pending.get(f.id);
          if (!p) return;
          state.pending.delete(f.id);
          clearTimeout(p.timer);
          if (f.ok) p.resolve(f.result);
          else p.reject(new Error(f.error || "daemon 返回错误"));
        }
      });
      ws.on("error", () => { clearTimeout(timer); settle(false); });
      ws.on("close", () => {
        state.connected = false;
        state.extOnline = false;
        for (const [, p] of state.pending) { clearTimeout(p.timer); p.reject(new Error("daemon 连接断开")); }
        state.pending.clear();
        if (!reconnectTimer) {
          reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, 1000);
        }
      });
    });
  }

  await connect();

  return {
    // connected 的语义 = "扩展在线, 能真正干活"(不是"代理连上了 daemon")。
    // 工具层(bridge_status / 各工具)一律用这个判定。
    get connected() { return state.connected && state.extOnline; },
    get daemonConnected() { return state.connected; },
    get extInfo() { return state.extInfo; },
    // 代理层不做白名单判定 —— daemon 侧(真正的 Hub)会判。这里只转发。
    request(method, params = {}, { timeoutMs = 30000 } = {}) {
      if (!state.connected) {
        return Promise.reject(Object.assign(new Error("bridge daemon 未连接"), { code: "not_connected" }));
      }
      // 扩展在线状态先判一次, 给比超时更快的反馈(否则要等 30s)
      if (!state.extOnline) {
        return Promise.reject(Object.assign(
          new Error("Chrome 扩展未连接: 请在扩展配置页点「立即连接」"),
          { code: "not_connected" },
        ));
      }
      const id = protocol.makeId("p");
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          state.pending.delete(id);
          reject(Object.assign(new Error(`请求超时(${timeoutMs}ms): ${method}`), { code: "timeout" }));
        }, timeoutMs);
        state.pending.set(id, { resolve, reject, timer });
        try {
          state.ws.send(JSON.stringify({ type: "query", id, method, params }));
        } catch (e) {
          clearTimeout(timer);
          state.pending.delete(id);
          reject(e);
        }
      });
    },
    async stop() {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (state.ws) { try { state.ws.close(); } catch { /* */ } }
    },
  };
}
hub = null;
proxyMode = false;

const hasDaemon = await probeDaemon();
if (hasDaemon) {
  proxyMode = true;
  log(`检测到运行中的 daemon (${daemonUrl}), 通过它转发`);
  // 代理模式: Hub 不监听端口, 只用 request() 的语义 —— 这里用一个连接型客户端
  const { WebSocket } = await import("ws");
  hub = await createProxyHub(WebSocket);
} else {
  // 没有 daemon: 自动起一个, 保证扩展随时能连(而不是 AI 退出就断)
  log("未检测到 daemon, 正在后台启动...");
  const started = await spawnDaemon();
  if (started) {
    proxyMode = true;
    const { WebSocket } = await import("ws");
    hub = await createProxyHub(WebSocket);
    log("daemon 已就绪, 通过它转发");
  } else {
    log("daemon 启动失败, 退回单进程模式(AI 客户端退出后端口即消失)");
    hub = new Hub({
      host: opts.host, port: opts.port, token,
      allowControl: opts.allowControl, log,
    });
    try {
      await hub.start();
      hub.on("connected", (info) => log(`扩展已连接: ${JSON.stringify(info)}`));
      hub.on("disconnected", () => log("扩展已断开"));
    } catch (e) {
      log(`本地端口启动失败: ${e && e.message ? e.message : e}`);
    }
  }
}
}



// ============================================================ MCP
async function runMcpServer() {
  const server = new McpServer({ name: "web-toolbox", version: VERSION });
  registerTools(server, hub, { archive: { append: () => 0, close: () => {} }, allowControl: opts.allowControl });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`MCP stdio 已就绪 (${proxyMode ? "经 daemon 转发" : "单进程"})`);

  let closing = false;
  async function shutdown(sig) {
    if (closing) return;
    closing = true;
    try { await hub.stop(); } catch { /* ignore */ }
    process.exit(0);
  }
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.stdin.on("end", () => shutdown("stdin end"));
  process.on("uncaughtException", (e) => log("未捕获异常: " + (e && e.stack || e)));
  process.on("unhandledRejection", (e) => log("未处理 rejection: " + (e && e.stack || e)));
}

// ============================================================ 实际分发
// 放在文件末尾: 上面的 let hub / let proxyMode 声明必须先执行完(TDZ)。
if (MODE === "daemon") {
  await runDaemon();
} else {
  await runMcpMode();
  await runMcpServer();
}
