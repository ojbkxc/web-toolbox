// hub.js —— WebSocket 端点: 接住扩展的拨入连接, 提供 request/event 两类原语。
//
// 单连接模型: 同一个用户通常只开一个 Chrome profile 用扩展。后连上的会顶掉先连上的
// (重装扩展/重载 service worker 是常态, 旧连接可能还没断干净)。
//
// 断线语义: request 在等待期间连接断开 → 立刻以 NOT_CONNECTED 失败, 不干等超时。

import { EventEmitter } from "node:events";
import { WebSocketServer } from "ws";
import protocol from "../../bridge-protocol.js";
import { safeEqual } from "./config.js";

const { FRAME, ERR, PROTOCOL_VERSION, WS_PATH, isFrame, makeId } = protocol;

export class Hub extends EventEmitter {
  constructor({ host, port, token, allowControl, log }) {
    super();
    this.host = host;
    this.port = port;
    this.token = token;
    this.allowControl = allowControl;
    this.log = log || (() => {});
    this.wss = null;
    this.socket = null;          // 当前扩展连接
    this.extInfo = null;
    this.proxies = new Set();    // 连上来的 MCP 代理连接
    this.pending = new Map();    // id -> {resolve, reject, timer}
  }

  async start() {
    await new Promise((resolve, reject) => {
      this.wss = new WebSocketServer({ host: this.host, port: this.port, path: WS_PATH });
      this.wss.once("listening", resolve);
      this.wss.once("error", reject);
      this.wss.on("connection", (ws, req) => this._onConnection(ws, req));
    });
    this.log(`WebSocket 监听 ws://${this.host}:${this.port}${WS_PATH}`);
  }

  async stop() {
    this._failAll(ERR.NOT_CONNECTED, "bridge 关闭");
    if (this.socket) {
      try { this.socket.close(); } catch { /* 已断 */ }
      this.socket = null;
    }
    if (this.wss) {
      await new Promise((r) => this.wss.close(r));
      this.wss = null;
    }
  }

  get connected() {
    return !!(this.socket && this.socket.readyState === 1);
  }

  _onConnection(ws, req) {
    const remote = (req.socket && req.socket.remoteAddress) || "?";
    this.log(`扩展连接来自 ${remote}`);

    // 握手超时: 连上后 5 秒内不说话就断开(防止半开连接长期占位)
    const authTimer = setTimeout(() => {
      if (!ws.authed) {
        this.log("握手超时(5s), 断开");
        this._send(ws, { type: FRAME.ERROR, code: ERR.UNAUTHORIZED, message: "auth timeout" });
        try { ws.close(); } catch { /* ignore */ }
      }
    }, 5000);

    ws.on("message", (raw) => {
      let frame;
      try {
        frame = JSON.parse(raw.toString());
      } catch {
        return this._send(ws, { type: FRAME.ERROR, code: ERR.BAD_FRAME, message: "invalid json" });
      }
      if (!isFrame(frame)) {
        return this._send(ws, { type: FRAME.ERROR, code: ERR.BAD_FRAME, message: "not a frame" });
      }

      // ---- 未鉴权: 只接受 hello ----
      if (!ws.authed) {
        if (frame.type !== FRAME.HELLO) {
          this.log("未鉴权即收到业务帧, 断开");
          return this._send(ws, { type: FRAME.ERROR, code: ERR.UNAUTHORIZED, message: "hello first" });
        }
        if (!safeEqual(frame.token, this.token)) {
          this.log("令牌不匹配, 拒绝连接");
          this._send(ws, { type: FRAME.ERROR, code: ERR.UNAUTHORIZED, message: "bad token" });
          try { ws.close(); } catch { /* ignore */ }
          return;
        }
        if (frame.protocol !== PROTOCOL_VERSION) {
          this.log(`协议版本不匹配: 扩展 ${frame.protocol} / bridge ${PROTOCOL_VERSION}`);
          this._send(ws, {
            type: FRAME.ERROR, code: ERR.PROTOCOL_MISMATCH,
            message: `extension protocol ${frame.protocol}, bridge expects ${PROTOCOL_VERSION}`,
          });
          try { ws.close(); } catch { /* ignore */ }
          return;
        }
        clearTimeout(authTimer);
        ws.authed = true;
        // 区分两类客户端: 扩展(ext.ua !== "web-toolbox-mcp")和 MCP 代理。
        // 代理是 AI 客户端里的 mcp 进程, 它自己没有任何浏览器能力, 只是把 query 转进来。
        const isProxy = frame.ext && frame.ext.ua === "web-toolbox-mcp";

        if (isProxy) {
          ws.isProxy = true;
          this.proxies.add(ws);
          this._send(ws, {
            type: FRAME.READY,
            protocol: PROTOCOL_VERSION,
            bridge: {
              version: "0.1.0", allowControl: this.allowControl,
              role: "proxy",
              // 代理要区分"我连上了 daemon"和"扩展在线"—— 两者语义不同。
              // bridge_status 的 connected 字段必须反映后者。
              extensionOnline: this.connected,
              extension: this.extInfo,
            },
          });
          this.log(`MCP 代理已接入 (扩展${this.connected ? "在线" : "离线"}): ${JSON.stringify(frame.ext)}`);
          return;
        }

        // 顶掉旧连接: 重载扩展/重启 SW 后旧 socket 可能还在
        if (this.socket && this.socket !== ws) {
          this._failAll(ERR.NOT_CONNECTED, "扩展重新连接, 旧请求作废");
          try { this.socket.close(); } catch { /* ignore */ }
        }
        this.socket = ws;
        this.extInfo = frame.ext || {};
        this._send(ws, {
          type: FRAME.READY,
          protocol: PROTOCOL_VERSION,
          bridge: { version: "0.1.0", allowControl: this.allowControl },
        });
        this.log(`扩展已鉴权: ${JSON.stringify(this.extInfo)}`);
        this.emit("connected", this.extInfo);
        this._broadcastExtStatus();
        return;
      }

      // ---- 已鉴权 ----
      if (frame.type === FRAME.RES) {
        const p = this.pending.get(frame.id);
        if (!p) return;                       // 已超时/已断开, 迟到响应直接丢
        this.pending.delete(frame.id);
        clearTimeout(p.timer);
        if (frame.ok) p.resolve(frame.result);
        else p.reject(Object.assign(new Error(frame.error || "扩展返回错误"), { code: ERR.EEXT }));
        return;
      }
      // MCP 代理发来的查询: 中转到扩展, 结果按原 id 回给代理。
      // 代理自己不做白名单判定 —— 那是本 Hub 的职责(唯一的信任边界)。
      if (frame.type === FRAME.QUERY) {
        if (!ws.isProxy) {
          this._send(ws, { type: FRAME.ERROR, code: ERR.FORBIDDEN, message: "query 仅限代理使用" });
          return;
        }
        this.request(frame.method, frame.params || {}, { timeoutMs: 30000 })
          .then(
            (result) => this._send(ws, { type: FRAME.RES, id: frame.id, ok: true, result }),
            (e) => this._send(ws, {
              type: FRAME.RES, id: frame.id, ok: false,
              error: (e && e.message) ? e.message : String(e),
            }),
          );
        return;
      }
      if (frame.type === FRAME.EVENT) {
        this.emit("event", frame.event, frame.data);
        return;
      }
      if (frame.type === FRAME.PING) {
        this._send(ws, { type: FRAME.PONG });
        return;
      }
    });

    ws.on("close", () => {
      clearTimeout(authTimer);
      if (ws.isProxy) {
        this.proxies.delete(ws);
        return;
      }
      if (this.socket === ws) {
        this.socket = null;
        this.extInfo = null;
        this._failAll(ERR.NOT_CONNECTED, "扩展连接已断开");
        this.log("扩展连接已断开");
        this.emit("disconnected");
        this._broadcastExtStatus();
      }
    });

    ws.on("error", (e) => this.log("socket 错误: " + String(e && e.message || e)));
  }

  _send(ws, obj) {
    if (!ws || ws.readyState !== 1) return false;
    try { ws.send(JSON.stringify(obj)); return true; } catch { return false; }
  }

  // 扩展上下线时通知所有代理。代理据此更新"扩展是否在线",
  // 与"我连上了 daemon"区分开(两者语义不同, 混用会让状态显示错误)。
  _broadcastExtStatus() {
    const frame = {
      type: FRAME.EVENT, event: "ext.status",
      data: { online: this.connected, extension: this.extInfo },
    };
    for (const ws of this.proxies) this._send(ws, frame);
  }

  _failAll(code, message) {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(Object.assign(new Error(message), { code }));
    }
    this.pending.clear();
  }

  // 向扩展发请求并等响应。allowControl=false 时控制类方法直接拒绝。
  request(method, params = {}, { timeoutMs = 30000 } = {}) {
    if (!this.connected) {
      return Promise.reject(Object.assign(new Error("扩展未连接"), { code: ERR.NOT_CONNECTED }));
    }
    if (protocol.isControlMethod(method) && !this.allowControl) {
      return Promise.reject(Object.assign(
        new Error(`控制类方法 ${method} 未启用(启动 bridge 时加 --allow-control)`),
        { code: ERR.FORBIDDEN },
      ));
    }
    if (!protocol.isReadMethod(method) && !protocol.isControlMethod(method)) {
      return Promise.reject(Object.assign(new Error(`未知方法: ${method}`), { code: ERR.UNKNOWN_METHOD }));
    }

    const id = makeId("q");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error(`请求超时(${timeoutMs}ms): ${method}`), { code: ERR.TIMEOUT }));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const ok = this._send(this.socket, { type: FRAME.REQ, id, method, params });
      if (!ok) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(Object.assign(new Error("发送失败: 连接已断开"), { code: ERR.NOT_CONNECTED }));
      }
    });
  }
}
