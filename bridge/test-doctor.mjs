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
    ok("失败时仍跑完其余检查(不是半路退出)", /\[PASS\] node 版本/.test(r.out) && /\[PASS\] 扩展 manifest/.test(r.out), "缺后续检查行");
    ok("末尾汇总列出失败项", /doctor FAIL: \d+\/\d+/.test(r.out), r.out.slice(-120));
    ok("无 daemon 时不做活体握手(不连坐)", !/令牌被 daemon 接受/.test(r.out), "出现了活体握手行");
  }

  // ② 有 daemon + 正确令牌
  {
    console.log("\n[doctor] 有 daemon + 正确令牌");
    const PORT = 19732;
    const daemon = spawn(process.execPath, [ENTRY, "--daemon", "--port", String(PORT), "--quiet",
      "--archive-dir", tmpArchive], {
      env: { ...process.env, WEB_TOOLBOX_TOKEN: TOKEN }, stdio: "ignore", windowsHide: true,
    });
    await sleep(1800);
    try {
      const r = runDoctor(["--port", String(PORT)], { WEB_TOOLBOX_TOKEN: TOKEN });
      ok("退出码 0", r.code === 0, { code: r.code, tail: r.out.slice(-200) });
      for (const name of ["daemon 端口在监听", "令牌可用", "令牌被 daemon 接受", "协议版本一致", "daemon 版本 = 包版本", "归档目录可写"]) {
        ok(`${name} → PASS`, new RegExp(`\\[PASS\\] ${name}`).test(r.out), r.out.split("\n").filter((l) => l.includes(name)));
      }
      ok("汇总显示全项通过", /doctor PASS: \d+\/\d+/.test(r.out), r.out.slice(-80));
      ok("给出归档保留期与体积两行 INFO", /归档保留期/.test(r.out) && /归档体积/.test(r.out), "缺 INFO 行");
    } finally {
      daemon.kill();
      await sleep(300);
    }
  }

  // ③ 有 daemon + 错令牌
  {
    console.log("\n[doctor] 有 daemon + 错令牌");
    const PORT = 19733;
    const daemon = spawn(process.execPath, [ENTRY, "--daemon", "--port", String(PORT), "--quiet",
      "--archive-dir", tmpArchive], {
      env: { ...process.env, WEB_TOOLBOX_TOKEN: TOKEN }, stdio: "ignore", windowsHide: true,
    });
    await sleep(1800);
    try {
      const r = runDoctor(["--port", String(PORT)], { WEB_TOOLBOX_TOKEN: "wrong-token-xxxxxxxx" });
      ok("退出码 1", r.code === 1, r.code);
      ok("令牌活体项 FAIL", /\[FAIL\] 令牌被 daemon 接受/.test(r.out), "该项未红");
      ok("失败原因含 unauthorized", /unauthorized/i.test(r.out), r.out.split("\n").filter((l) => l.includes("令牌被")));
      const failedLines = (r.out.match(/\[FAIL\]/g) || []).length;
      ok("恰好 1 项失败(不连坐端口/协议/版本)", failedLines === 1, failedLines);
    } finally {
      daemon.kill();
      await sleep(300);
    }
  }

  // ④ 参数错误
  {
    console.log("\n[doctor] 参数错误");
    const r = runDoctor(["--port", "0"], { WEB_TOOLBOX_TOKEN: TOKEN });
    ok("退出码 2(参数错误)", r.code === 2, r.code);
    ok("一行明说且含正确用法", /\[FAIL\] 参数解析/.test(r.out) && /1\.\.65535/.test(r.out), r.out.slice(0, 160));
    ok("不甩栈(无 at Object.<anonymous>)", !/at Object\.<anonymous>/.test(r.out), "出现了栈帧");
  }
} finally {
  fs.rmSync(tmpArchive, { recursive: true, force: true });
}

console.log(`\n=== doctor e2e: ${pass} PASS / ${fail} FAIL ===`);
process.exit(fail ? 1 : 0);
