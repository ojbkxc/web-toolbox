// config.js —— bridge 进程配置: 端口、令牌、控制开关。
//
// 令牌来源(优先级从高到低):
//   1. --token <value> 命令行
//   2. WEB_TOOLBOX_TOKEN 环境变量
//   3. 令牌文件(默认 ~/.web-toolbox/bridge-token), 不存在则生成一个并落盘
//
// 为什么要有令牌: 本地端口对本机任意进程开放, 没有鉴权就等于把浏览器控制权
// 交给任何程序。令牌只存在用户目录(ACL 限当前用户), 扩展在配置页填一次即可。

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function defaultTokenPath() {
  return path.join(os.homedir(), ".web-toolbox", "bridge-token");
}

export function parseArgs(argv) {
  argv = [...argv];   // 不原地改调用方数组(--flag=value 的展开会重建)
  const opts = {
    host: "127.0.0.1",
    port: 9280,
    token: null,
    tokenPath: defaultTokenPath(),
    allowControl: false,
    daemon: false,
    archiveDir: path.join(os.homedir(), ".web-toolbox", "archive"),
    archiveKeepDays: 0,   // 0 = 永不清理(默认保守: 清理是不可逆动作)
    quiet: false,
  };
  // 参数值守卫: 早先 --port 直接 Number(), 传错(--port http / 漏值)会得到 NaN 并在
  // 建 WebSocketServer 时抛晦涩错误; 未知参数更是被静默忽略(--alow-control 打错 = 控制类
  // 悄悄不可用, 用户只会看到 "未启用")。这里一律在启动前明确报错。
  const FLAGS = "--daemon --host --port --token --token-file --allow-control --archive-dir --archive-keep-days --quiet --help";
  const needValue = (flag, idx) => {
    const v = argv[idx];
    // 负数("-1")是合法取值, 不能被当成"下一个 flag" —— 否则范围校验会让位给"缺少值",
    // 用户看到的是误导性错误。只把 "--xxx" 与 "-字母" 当作 flag。
    const looksLikeFlag = typeof v === "string" && /^--/.test(v) || /^-[A-Za-z]/.test(String(v));
    if (v === undefined || looksLikeFlag) {
      throw new Error(`参数 ${flag} 缺少值(用法: ${flag} <value>)`);
    }
    return v;
  };
  // --flag=value 形式: 只对"已知带值 flag"在第一个 '=' 处切开, 值里允许再出现 '='
  // (令牌/路径里常见)。未知 flag 保持原样, 继续走下面的未知参数报错。
  const VALUE_FLAGS = new Set(["--host", "--port", "--token", "--token-file", "--archive-dir", "--archive-keep-days"]);
  const flat = [];
  for (const arg of argv) {
    if (typeof arg === "string" && arg.startsWith("--") && arg.includes("=")) {
      const eq = arg.indexOf("=");
      const flag = arg.slice(0, eq);
      if (VALUE_FLAGS.has(flag)) { flat.push(flag, arg.slice(eq + 1)); continue; }
    }
    flat.push(arg);
  }
  argv = flat;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--host") {
      const v = needValue(a, ++i).trim();
      if (!v) throw new Error("--host 不能为空");
      opts.host = v;
    } else if (a === "--port") {
      const raw = needValue(a, ++i);
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1 || n > 65535) {
        throw new Error(`--port 必须是 1..65535 的整数, 收到: ${raw}`);
      }
      opts.port = n;
    } else if (a === "--token") opts.token = needValue(a, ++i).trim();
    else if (a === "--token-file") opts.tokenPath = needValue(a, ++i);
    else if (a === "--archive-dir") opts.archiveDir = needValue(a, ++i);
    else if (a === "--archive-keep-days") {
      const raw = needValue(a, ++i);
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0 || n > 3650) {
        throw new Error(`--archive-keep-days 必须是 0..3650 的整数(0=不清理), 收到: ${raw}`);
      }
      opts.archiveKeepDays = n;
    }
    else if (a === "--allow-control") opts.allowControl = true;
    else if (a === "--daemon") opts.daemon = true;
    else if (a === "--quiet") opts.quiet = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else if (a.startsWith("-")) throw new Error(`未知参数: ${a}(可用: ${FLAGS})`);
  }
  return opts;
}

// 读取或生成令牌。文件权限 0600, 内容只有一行十六进制串。
export function resolveToken(opts) {
  if (opts.token) return { token: opts.token.trim(), source: "cli" };
  const env = process.env.WEB_TOOLBOX_TOKEN;
  if (env && env.trim()) return { token: env.trim(), source: "env" };

  const file = opts.tokenPath;
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (existing) return { token: existing, source: "file" };
  } catch {
    // 不存在 → 下面生成
  }
  const token = crypto.randomBytes(24).toString("hex");
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, token + "\n", { mode: 0o600 });
  return { token, source: "generated" };
}

// 定长比较: 先各自摘要到固定长度再比, 连「长度不同」这条早退分支都去掉 ——
// 否则本机进程可用计时差探出令牌长度(默认 48 hex), 属低危信息泄露。
export function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a == null ? "" : a)).digest();
  const hb = crypto.createHash("sha256").update(String(b == null ? "" : b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
