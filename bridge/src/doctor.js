#!/usr/bin/env node
// doctor.js —— 桥接自检: 一条命令回答"为什么 AI 客户端连不上"。
//
// 设计取向(对齐 chrome-devtools-mcp 的"错误信息要能自解释"): 不猜、不吞, 每项检查
// 独立给 PASS/FAIL + 一句可执行的下一步; 退出码 0 = 全通, 1 = 有项失败(可直接接 CI)。
//
// 检查项: node 版本 / 三个运行时依赖能否加载 / 协议契约 / 令牌来源 / daemon 端口是否在听 /
// 扩展 manifest 与 bridge-client 是否就位。
//
// 用法: node src/doctor.js [--host 127.0.0.1] [--port 9280] [ --quiet ]

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import protocol from "../../bridge-protocol.js";
import { parseArgs, defaultTokenPath } from "./config.js";
import { Archive } from "./archive.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
let opts;
try {
  opts = parseArgs(process.argv.slice(2));
} catch (e) {
  process.stdout.write("[FAIL] 参数解析 — " + (e && e.message ? e.message : e) + "\n");
  process.exit(2);
}

if (opts.help) {
  process.stdout.write(`web-toolbox doctor —— 桥接自检(18 项, 每条 FAIL 带"下一步")

用法: node bridge/src/doctor.js [选项]

选项(--flag=value 也支持):
  --host <ip>            daemon 监听地址, 默认 127.0.0.1
  --port <n>             daemon 端口, 默认 9280
  --token <value>        令牌覆盖(默认读 ~/.web-toolbox/bridge-token)
  --token-file <path>    令牌文件路径
  --archive-dir <path>   归档目录(默认 ~/.web-toolbox/archive)
  --archive-keep-days <n> 保留天数(只用 dry-run 展示会删哪些)
  --help / -h            显示本帮助

典型: 连不上时第一个跑它。18 项含令牌活体握手(需 daemon 在跑)、协议/包版本一致性。`);
  process.exit(0);
}

const results = [];
function check(name, ok, detail, hint) {
  results.push({ name, ok: !!ok, detail: detail || "" });
  const mark = ok ? "PASS" : "FAIL";
  process.stdout.write(`[${mark}] ${name}${detail ? " — " + detail : ""}\n`);
  if (!ok && hint) process.stdout.write(`       下一步: ${hint}\n`);
  return ok;
}

// ---- 0. 监听地址暴露面 ----
// 令牌是唯一防线: 绑到非回环地址(0.0.0.0 / 局域网 IP)等于把浏览器控制面挂到网络上,
// 只靠一串本地文件里的令牌兜着。默认回环是对的, 改成对外监听要明说。
{
  const loopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(opts.host);
  check("监听地址是本机回环", loopback, opts.host,
    "非回环监听时令牌是唯一防线: 确认这是你要的(局域网其他机器可连), 否则用 --host 127.0.0.1");
}

// ---- 1. node 版本(与 bridge/package.json engines 对齐) ----
{
  const [maj, min] = process.versions.node.split(".").map(Number);
  const ok = maj > 18 || (maj === 18 && min >= 17);
  check("node 版本 >= 18.17", ok, `当前 ${process.versions.node}`, "升级 Node.js 后重跑");
}

// ---- 2. 运行时依赖 ----
for (const dep of ["ws", "zod", "@modelcontextprotocol/sdk/server/mcp.js"]) {
  try {
    await import(dep);
    check(`依赖可加载: ${dep}`, true);
  } catch (e) {
    check(`依赖可加载: ${dep}`, false, e && e.message, "在 bridge/ 目录执行 npm install");
  }
}

// ---- 3. 协议契约 ----
{
  const read = protocol.READ_METHODS || [];
  const ctrl = protocol.CONTROL_METHODS || [];
  check("协议版本可读", protocol.PROTOCOL_VERSION != null, `v${protocol.PROTOCOL_VERSION}`);
  check("WS 路径可读", typeof protocol.WS_PATH === "string", protocol.WS_PATH);
  check("方法白名单非空", read.length + ctrl.length > 0, `只读 ${read.length} / 控制 ${ctrl.length}`);
  const overlap = read.filter((m) => ctrl.includes(m));
  check("只读与控制白名单不重叠", overlap.length === 0, overlap.join(",") || "无重叠",
    "bridge-protocol.js 的 READ_METHODS/CONTROL_METHODS 有交集, 控制开关会被绕过");
}

// ---- 4. 令牌 ----
// 解析顺序与 config.resolveToken 一致, 但**不生成**(doctor 只读, 不制造副作用)。
const tokenInfo = (() => {
  const file = opts.tokenPath || defaultTokenPath();
  if (opts.token) return { token: opts.token.trim(), source: "命令行 --token" };
  if (process.env.WEB_TOOLBOX_TOKEN) return { token: process.env.WEB_TOOLBOX_TOKEN.trim(), source: "环境变量" };
  try { return { token: fs.readFileSync(file, "utf8").trim(), source: file }; } catch { return { token: "", source: "" }; }
})();
check("令牌可用", tokenInfo.token.length >= 16,
  tokenInfo.token ? `${tokenInfo.source} (长度 ${tokenInfo.token.length})` : "未找到",
  "先起一次 daemon: node src/index.js --daemon, 它会生成令牌并打印");

// ---- 5. daemon 端口 ----
const portOk = await new Promise((resolve) => {
  const sock = net.connect({ host: opts.host, port: opts.port });
  const done = (ok, detail) => {
    sock.destroy();
    check("daemon 端口在监听", ok, detail,
      "常驻 daemon 没起: node src/index.js --daemon --allow-control (扩展只能主动拨出, 不能自己监听)");
    resolve(ok);
  };
  sock.setTimeout(1500, () => done(false, `${opts.host}:${opts.port} 连接超时`));
  sock.on("connect", () => done(true, `ws://${opts.host}:${opts.port}${protocol.WS_PATH}`));
  sock.on("error", (e) => done(false, `${opts.host}:${opts.port} ${e && e.code ? e.code : e}`));
});

// ---- 5b. 令牌活体校验 ----
// 只验"文件存在 + 端口在听"会放过"令牌已轮换/填错"这种最常见的连不上原因。
// 这里真拨一次 WebSocket, 让 daemon 用**它自己的令牌**判定我们手里的这串能不能过。
// 只在端口确实在听时做(否则重复报同一个"daemon 没起")。
let extOnline = null;      // 活体握手顺带读到的"扩展是否在线"(只作 INFO, 不参与退出码)
let readyProtocol = null;  // READY 里 daemon 回的协议版本
let readyAllowControl = null;
let readyVersion = null;   // READY 里 daemon 自报的 bridge 版本
if (portOk && tokenInfo.token) {
  const { WebSocket } = await import("ws");
  const outcome = await new Promise((resolve) => {
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
    let ws;
    try { ws = new WebSocket(`ws://${opts.host}:${opts.port}${protocol.WS_PATH}`); }
    catch (e) { return finish({ ok: false, detail: "无法建立连接: " + (e && e.message) }); }
    const timer = setTimeout(() => { try { ws.terminate(); } catch { /* ignore */ } finish({ ok: false, detail: "5s 内无应答" }); }, 5000);
    ws.on("open", () => ws.send(JSON.stringify({
      type: protocol.FRAME.HELLO, protocol: protocol.PROTOCOL_VERSION,
      token: tokenInfo.token, ext: { version: "doctor", ua: "web-toolbox-mcp" },
    })));
    ws.on("message", (raw) => {
      clearTimeout(timer);
      let f;
      try { f = JSON.parse(raw.toString()); } catch { return; }
      try { ws.close(); } catch { /* ignore */ }
      if (f.type === protocol.FRAME.READY) {
        extOnline = !!(f.bridge && f.bridge.extensionOnline);
        readyProtocol = f.protocol;
        readyAllowControl = !!(f.bridge && f.bridge.allowControl);
        readyVersion = (f.bridge && f.bridge.version) || null;
        finish({ ok: true, detail: "READY(角色 " + ((f.bridge && f.bridge.role) || "extension") + ")" });
      } else {
        finish({ ok: false, detail: `daemon 拒绝: ${f.code || f.type}${f.message ? " " + f.message : ""}` });
      }
    });
    ws.on("error", (e) => { clearTimeout(timer); finish({ ok: false, detail: "连接错误: " + (e && e.message) }); });
  });
  check("令牌被 daemon 接受(活体握手)", outcome.ok, outcome.detail,
    "令牌与 daemon 不一致: 用 daemon 打印的那串, 或重启 daemon 让它重读 ~/.web-toolbox/bridge-token");
  // 协议版本不一致会在 Hub 那里变成 protocol_mismatch, 提前查出来更好定位。
  if (outcome.ok) {
    check("协议版本一致(READY)", readyProtocol === protocol.PROTOCOL_VERSION,
      `daemon ${readyProtocol} / 本地 ${protocol.PROTOCOL_VERSION}`,
      "两端不同版本: 把扩展与 bridge 更新到同一版本后重连");
  }
  // 版本漂移: hub/index 里的 VERSION 是手写常量, 与 package.json 脱钩后客户端会看到
  // "报的版本"和"装的版本"不是一回事(MCP 客户端也靠它判断兼容性)。
  if (outcome.ok) {
    let pkgVersion = "";
    try {
      pkgVersion = JSON.parse(fs.readFileSync(path.join(ROOT, "bridge", "package.json"), "utf8")).version;
    } catch { /* 下面判失败 */ }
    check("daemon 版本 = 包版本", !!pkgVersion && readyVersion === pkgVersion,
      `daemon ${readyVersion || "?"} / package ${pkgVersion || "?"}`,
      "把 bridge/src/index.js 与 hub.js 里的 VERSION 常量同步到 package.json");
  }
  // 扩展在线与否不是 doctor 的"错", 但决定用户下一步做什么 —— 单列 INFO, 不影响退出码。
  if (outcome.ok) {
    process.stdout.write(`[INFO] 控制类工具: ${readyAllowControl ? "已启用(点击/输入/导航/录制/重放)" : "未启用(需要时加 --allow-control)"}\n`);
    process.stdout.write(extOnline
      ? "[INFO] 扩展在线: 是(工具可直接用)\n"
      : "[INFO] 扩展在线: 否 —— 在 Chrome 打开扩展配置页「AI 桥接」点「立即连接」(抓包/页面工具都依赖它)\n");
  }
}

// ---- 5c. 归档目录可写(daemon 的 --archive-dir) ----
{
  const dir = opts.archiveDir;
  let okDir = false, detail = "";
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, ".doctor-probe");
    fs.writeFileSync(probe, "ok");
    fs.unlinkSync(probe);
    okDir = true;
    detail = dir;
  } catch (e) {
    detail = `${dir} — ${e && e.code ? e.code : e}`;
  }
  check("归档目录可写", okDir, detail,
    "换一个可写目录: --archive-dir <path>(daemon 与 MCP 进程要看到同一路径)");
  // 体积提示: 归档是明文流量, 长跑前先知道它有多大(只读 INFO, 不参与退出码)。
  if (okDir) {
    try {
      const stack = [dir];
      let bytes = 0;
      while (stack.length) {
        const cur = stack.pop();
        for (const ent of fs.readdirSync(cur, { withFileTypes: true })) {
          const p = path.join(cur, ent.name);
          if (ent.isDirectory()) stack.push(p);
          else { try { bytes += fs.statSync(p).size; } catch { /* ignore */ } }
        }
      }
      process.stdout.write(`[INFO] 归档体积: ${(bytes / (1024 * 1024)).toFixed(1)} MB${bytes > 1024 * 1024 * 1024 ? " —— 偏大, 可清理旧日文件" : ""}\n`);
      // 日期跨度: 判断"还在不在写"比只看体积直观(停机后体积不变, 但最新日期会停住)
      const days = fs.readdirSync(dir)
        .map((n) => (/^harvest-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(n) || [])[1])
        .filter(Boolean)
        .sort();
      if (days.length) {
        process.stdout.write(`[INFO] 归档日期跨度: ${days[0]} → ${days[days.length - 1]}(共 ${days.length} 天)\n`);
      }
    } catch { /* 拿不到就不报 */ }
  }

  // 保留期: 告诉用户"这次启动会删掉哪些日归档" —— 清理不可逆, 提前可见。
  {
    const keep = Number(opts.archiveKeepDays) || 0;
    if (keep > 0) {
      const plan = new Archive(opts.archiveDir, { keepDays: keep }).prune(keep, { dryRun: true });
      process.stdout.write(`[INFO] 归档保留期: ${keep} 天 —— 本次启动将删除 ${plan.removed.length} 个旧日归档${plan.removed.length ? "(" + plan.removed.join(", ") + ")" : ""}\n`);
    } else {
      process.stdout.write("[INFO] 归档保留期: 0(不清理; 需要时加 --archive-keep-days N)\n");
    }
  }
  // 归档是长跑型数据(按天追加明文流量), 余量不足时先提示, 而不是写到一半失败。
  if (okDir && typeof fs.statfsSync === "function") {
    try {
      const st = fs.statfsSync(dir);
      const freeGb = (st.bavail * st.bsize) / (1024 ** 3);
      process.stdout.write(`[INFO] 归档磁盘余量: ${freeGb.toFixed(1)} GB${freeGb < 1 ? " —— 偏少, 建议清理 " + dir : ""}\n`);
    } catch { /* 拿不到就不报, 不影响退出码 */ }
  }
}

// ---- 5d. 令牌文件权限(仅 POSIX; Windows 由用户目录 ACL 继承) ----
{
  const file = opts.tokenPath || defaultTokenPath();
  if (process.platform === "win32") {
    check("令牌文件权限", true, "Windows 不适用(ACL 由用户目录继承)", "");
  } else {
    let mode = null;
    try { mode = fs.statSync(file).mode & 0o777; } catch { /* 下面判 */ }
    const okMode = mode !== null && (mode & 0o077) === 0;
    check("令牌文件权限(组/其他不可读)", okMode, mode === null ? "文件不存在" : "0o" + mode.toString(8),
      `chmod 600 ${file}`);
  }
}

// ---- 6. 扩展侧就位 ----
{
  try {
    const mf = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
    check("扩展 manifest 可读", true, `${mf.name} v${mf.version}`);
  } catch (e) {
    check("扩展 manifest 可读", false, e && e.message, "doctor 应在 bridge/src 下运行, 且仓库根有 manifest.json");
  }
  check("bridge-client.js 存在", fs.existsSync(path.join(ROOT, "bridge-client.js")),
    path.join(ROOT, "bridge-client.js"), "扩展目录不完整, 重新拉取仓库");
}

const failed = results.filter((r) => !r.ok);
process.stdout.write(failed.length
  ? `\n=== doctor FAIL: ${failed.length}/${results.length} —— ${failed.map((r) => r.name).join(", ")} ===\n`
  : `\n=== doctor PASS: ${results.length}/${results.length} ===\n`);
process.exit(failed.length ? 1 : 0);
