// bridge/test-doctor.mjs —— doctor 端到端(真起 daemon, 不看源码只看输出与退出码)。
//
// 为什么单列: doctor 是"连不上时第一个该跑的东西", 它的检查项、顺序、文案都是**排障承诺**。
// 静态断言只能证明"字符串在文件里", 证明不了"运行时真的查了、失败时真的红"。这里:
//   ① 无 daemon → 端口项 FAIL 且退出码 1(其余项仍要跑完并打印, 不能半路退出);
//   ② 有 daemon + 正确令牌 → 退出码 0, 且关键项(端口/令牌活体/协议/版本)都 PASS;
//   ③ 有 daemon + 错令牌 → **恰好**令牌活体那项 FAIL, 退出码 1(不能连坐其它项);
//   ④ 参数错误(--port 0) → 退出码 2 且一行明说, 不甩栈。
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(here, "src", "index.js");
const DOCTOR = path.join(here, "src", "doctor.js");
const TOKEN = "doctor-test-token-abc123";

let pass = 0, fail = 0;
const ok = (name, cond, got) => {
  if (cond) { pass++; console.log("  OK " + name); }
  else { fail++; console.log("  ✗ FAIL " + name + " → " + JSON.stringify(got)); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 复用就绪探测(代替固定 sleep): 起完 daemon 立即探, 实测快 ~1.4s/处。
let PORT_FOR_READY = 0;   // 调用方起 daemon 前设置, 供就绪探测用
async function waitDaemonUp() {
  // 只探 TCP 端口: "就绪"= 端口在监听。不在这里做 WS 握手(那要令牌与协议, 且握手失败
  // 会被误判成"daemon 没起"—— 本文件正是要测令牌/协议错的场景, 就绪判定不能预设它们对)。
  const net = await import("node:net");
  for (let i = 0; i < 60; i++) {
    const up = await new Promise((resolve) => {
      const sock = net.connect({ host: "127.0.0.1", port: PORT_FOR_READY });
      const done = (v) => { sock.destroy(); resolve(v); };
      sock.on("connect", () => done(true));
      sock.on("error", () => done(false));
      setTimeout(() => done(false), 300);
    });
    if (up) return true;
    await sleep(150);
  }
  return false;
}
function runDoctor(args, env = {}) {
  const r = spawnSync(process.execPath, [DOCTOR, ...args], {
    encoding: "utf8",
    timeout: 60000,
    windowsHide: true,
    env: { ...process.env, ...env },
  });
  return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
}

const tmpArchive = fs.mkdtempSync(path.join(os.tmpdir(), "wt_doctor_"));

try {
  // ① 无 daemon
  {
    console.log("\n[doctor] 无 daemon");
    const r = runDoctor(["--port", "19731"], { WEB_TOOLBOX_TOKEN: TOKEN, WEBTOOLBOX_ARCHIVE_DIR: tmpArchive });
    ok("退出码 1(有项失败)", r.code === 1, r.code);
    ok("端口项 FAIL 且给出下一步", /\[FAIL\] daemon 端口在监听/.test(r.out) && /daemon 没起|--daemon/.test(r.out), r.out.slice(0, 200));
    ok("失败时仍跑完其余检查(不是半路退出)", /\[PASS\] node 版本/.test(r.out) && /\[PASS\] 扩展 manifest/.test(r.out));
    ok("末尾汇总列出失败项", /doctor FAIL: \d+\/\d+/.test(r.out), r.out.slice(-120));
    ok("无 daemon 时不做活体握手(不连坐)", !/令牌被 daemon 接受/.test(r.out));
  }

  // ② 有 daemon + 正确令牌
  {
    console.log("\n[doctor] 有 daemon(两个令牌 case 共用一个 daemon, 冷启动只付一次)");
{
  // 端口探测(R96 同款教训): 固定端口会撞上残留 daemon / 并发套件 → 随机假红。
  const PORT = await (async () => {
    const net2 = await import("node:net");
    for (let i = 0; i < 100; i++) {
      const p = 19700 + Math.floor(Math.random() * 900);
      const free = await new Promise((resolve) => {
        const srv = net2.createServer();
        srv.once("error", () => resolve(false));
        srv.once("listening", () => srv.close(() => resolve(true)));
        srv.listen(p, "127.0.0.1");
      });
      if (free) return p;
    }
    throw new Error("找不到空闲端口");
  })();
  PORT_FOR_READY = PORT;
  const daemon = spawn(process.execPath, [ENTRY, "--daemon", "--port", String(PORT), "--quiet",
    "--archive-dir", tmpArchive], {
    env: { ...process.env, WEB_TOOLBOX_TOKEN: TOKEN }, stdio: "ignore", windowsHide: true,
  });
  if (!(await waitDaemonUp())) { ok("daemon 就绪", false); }
  try {
    // case A: 正确令牌
    console.log("  · 正确令牌");
    const r = runDoctor(["--port", String(PORT)], { WEB_TOOLBOX_TOKEN: TOKEN });
    ok("退出码 0", r.code === 0, { code: r.code, tail: r.out.slice(-200) });
    for (const name of ["daemon 端口在监听", "令牌可用", "令牌被 daemon 接受", "协议版本一致", "daemon 版本 = 包版本", "归档目录可写"]) {
      ok(`${name} → PASS`, r.out.includes("[PASS] " + name), r.out.split("\n").filter((l) => l.includes(name)));
    }
    ok("汇总显示全项通过", /doctor PASS: \d+\/\d+/.test(r.out), r.out.slice(-80));
    ok("给出归档保留期与体积两行 INFO", /归档保留期/.test(r.out) && /归档体积/.test(r.out));
    // case B: 错令牌(同一个 daemon, 不重启)
    console.log("  · 错令牌");
    const r2 = runDoctor(["--port", String(PORT)], { WEB_TOOLBOX_TOKEN: "wrong-token-xxxxxxxx" });
    ok("退出码 1", r2.code === 1, r2.code);
    ok("令牌活体项 FAIL", r2.out.includes("[FAIL] 令牌被 daemon 接受"));
    ok("失败原因含 unauthorized", /unauthorized/i.test(r2.out), r2.out.split("\n").filter((l) => l.includes("令牌被")));
    const failedLines = (r2.out.match(/\[FAIL\]/g) || []).length;
    ok("恰好 1 项失败(不连坐端口/协议/版本)", failedLines === 1, failedLines);
  } finally {
    daemon.kill();
    await sleep(300);
  }
}
// ⑤ --help / -h: 显示用法且退出 0(此前被忽略直接跑检查 —— CLI 最基本的约定)
{
  console.log("\n[doctor] --help / -h");
  const rh = runDoctor(["--help"], {});
  const rh2 = runDoctor(["-h"], {});
  ok("--help 与 -h 都退出 0", rh.code === 0 && rh2.code === 0, { h: rh.code, s: rh2.code });
  ok("--help 打印用法含选项", /--host/.test(rh.out) && /doctor/.test(rh.out), rh.out.slice(0, 60));
  ok("--help 不跑检查(不应出现检查行)", !/\[PASS\]|\[FAIL\]/.test(rh.out), "出现了检查行");
}
console.log("\n[doctor] 参数错误");
    const r = runDoctor(["--port", "0"], { WEB_TOOLBOX_TOKEN: TOKEN });
    ok("退出码 2(参数错误)", r.code === 2, r.code);
    ok("一行明说且含正确用法", /\[FAIL\] 参数解析/.test(r.out) && /1\.\.65535/.test(r.out), r.out.slice(0, 160));
    ok("不甩栈(无 at Object.<anonymous>)", !/at Object\.<anonymous>/.test(r.out));
  }
} finally {
  fs.rmSync(tmpArchive, { recursive: true, force: true });
}

console.log(`\n=== doctor e2e: ${pass} PASS / ${fail} FAIL ===`);
process.exit(fail ? 1 : 0);
