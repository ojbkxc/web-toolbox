// bridge-protocol.js —— 扩展与 MCP bridge 之间的线协议(唯一契约来源)。
//
// 为什么单独一个文件: 两边必须用同一份常量, 任何一处漂移都会变成"连上了但工具全废"。
// 加载方式:
//   · 扩展 service worker: importScripts("bridge-protocol.js") —— 挂到全局, 用 BRIDGE 前缀避免撞名
//   · bridge(Node ESM):    import protocol from "../../bridge-protocol.js"
//   · node 单测:           require("./bridge-protocol.js")
// 本项目零构建, 所以用 UMD 形态(与 common.js 同款: 浏览器全局 + module.exports 双通道)。
//
// 传输: WebSocket, 扩展【主动拨出】到 127.0.0.1。浏览器扩展不能监听端口, 只能拨出 ——
// 这也是选择 WS 而非 Native Messaging 的原因(免安装器、免注册表、免签名)。

(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.BRIDGE = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  // 协议版本: 帧结构/语义变更时 +1。握手时双方互换, 不同则拒连(宁可明确报错, 不静默错位)。
  const PROTOCOL_VERSION = 1;

  const DEFAULT_HOST = "127.0.0.1";
  const DEFAULT_PORT = 9280;
  const WS_PATH = "/ext";

  // 帧类型
  const FRAME = {
    HELLO: "hello",   // 客户端(扩展或 MCP 代理) → bridge: {type, protocol, token, ext}
    READY: "ready",   // bridge → 客户端: {type, protocol, bridge}
    ERROR: "error",   // 双向: {type, code, message}
    REQ: "req",       // bridge → 扩展: {type, id, method, params}
    RES: "res",       // 扩展 → bridge: {type, id, ok, result|error}
    QUERY: "query",   // MCP 代理 → daemon: {type, id, method, params}(由 daemon 转给扩展)
    EVENT: "event",   // 扩展 → bridge: {type, event, data}; daemon → 代理: 状态通知
    PING: "ping",
    PONG: "pong",
  };

  // 错误码(字符串, 便于 MCP 侧原样透出)
  const ERR = {
    UNAUTHORIZED: "unauthorized",
    BAD_FRAME: "bad_frame",
    PROTOCOL_MISMATCH: "protocol_mismatch",
    UNKNOWN_METHOD: "unknown_method",
    TIMEOUT: "timeout",
    NOT_CONNECTED: "not_connected",
    EEXT: "ext_error",
    FORBIDDEN: "forbidden",
  };

  // 只读方法白名单: bridge 只允许这些方法触达扩展。新增控制类方法必须显式列出 ——
  // 防止 bridge 被改坏后成为"任意命令直通浏览器"的通道。
  // ⚠ 与 bridge-client.js 的 bridgeDispatch switch 分支严格一一对应(改一边必须改另一边)。
  const READ_METHODS = [
    "rec.status",
    "net.list", "net.get", "net.hosts",
    "tab.list",
  ];
  // 控制方法(需要用户显式启用): 在 bridge 启动参数 --allow-control 打开后才转发。
  const CONTROL_METHODS = [
    "rec.start", "rec.stop",
    "tab.navigate",
    "page.snapshot", "page.eval", "page.click", "page.type", "page.press",
    "page.screenshot",
  ];

  function isReadMethod(m) { return READ_METHODS.includes(m); }
  function isControlMethod(m) { return CONTROL_METHODS.includes(m); }

  // 请求 id: 时间戳 + 随机后缀, 单进程内不会撞
  function makeId(prefix) {
    return (prefix || "q") + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  // 线协议一律 JSON 文本帧; 这个守卫让"收到了非对象帧"在两端表现一致
  function isFrame(v) {
    return v != null && typeof v === "object" && typeof v.type === "string";
  }

  return {
    PROTOCOL_VERSION, DEFAULT_HOST, DEFAULT_PORT, WS_PATH,
    FRAME, ERR, READ_METHODS, CONTROL_METHODS,
    isReadMethod, isControlMethod, makeId, isFrame,
  };
});
