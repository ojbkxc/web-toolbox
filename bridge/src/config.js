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
  const opts = {
    host: "127.0.0.1",
    port: 9280,
    token: null,
    tokenPath: defaultTokenPath(),
    allowControl: false,
    daemon: false,
    archiveDir: path.join(os.homedir(), ".web-toolbox", "archive"),
    quiet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--host") opts.host = argv[++i];
    else if (a === "--port") opts.port = Number(argv[++i]);
    else if (a === "--token") opts.token = argv[++i];
    else if (a === "--token-file") opts.tokenPath = argv[++i];
    else if (a === "--archive-dir") opts.archiveDir = argv[++i];
    else if (a === "--allow-control") opts.allowControl = true;
    else if (a === "--daemon") opts.daemon = true;
    else if (a === "--quiet") opts.quiet = true;
    else if (a === "--help" || a === "-h") opts.help = true;
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

// 定长比较, 避免逐字符提前返回带来的时间差(本地场景风险低, 但成本为零)
export function safeEqual(a, b) {
  const ba = Buffer.from(String(a == null ? "" : a));
  const bb = Buffer.from(String(b == null ? "" : b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}
