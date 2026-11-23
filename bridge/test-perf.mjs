// bridge/test-perf.mjs —— 热路径性能基线(v1.1.57)。
//
// 为什么: R15 曾给 net_list 设过 <1000ms 断言, 全量套件并发时就假红(R26 记录在案)。
// 这次先把**实测基线**量出来再定阈值 —— 每条断言只拦"数量级退化"(实测中位的 ~8-12 倍),
// 不拦机器抖动。基线数字全部来自本机实测(见 CHANGELOG), 改实现时请同步更新基线注释。
//
// 实测基线(本机, 2026-11-24):
//   checkXml    500 条 JMX  ~16ms  → 阈值 300ms(19x)
//   net_list    3000 条/50  ~1ms   → 阈值 3000ms 是病态线, 但已有 gate(R15); 这里测带 UTF-8 字节的摘要 ~2ms → 100ms(50x)
//   buildHar    1000 条中文  ~8ms  → 阈值 200ms(25x)
//   buildJmx    500 条       ~15ms → 阈值 400ms(27x)
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");
const req = createRequire(path.join(ROOT, "bridge", "x.js"));

let pass = 0, fail = 0;
const ok = (cond, msg) => {
  if (cond) { pass++; console.log("  OK " + msg); }
  else { fail++; console.log("  ✗ FAIL " + msg); }
};

function median(ts) { const s = [...ts].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; }
async function bench(fn, n = 7) {
  const ts = [];
  for (let i = 0; i < n; i++) { const t0 = performance.now(); await fn(); ts.push(performance.now() - t0); }
  return { med: median(ts), max: Math.max(...ts) };
}

const mkEntries = (n) => Array.from({ length: n }, (_, i) => ({
  id: "e" + i, method: i % 2 ? "GET" : "POST",
  url: "https://h.test/p" + i + "?i=" + i, path: "/p" + i, query: "i=" + i,
  headers: { "Content-Type": "application/json", "x-noise": "v" + i },
  body: 'a'.repeat(40), response: "内容".repeat(60), status: i % 10 === 0 ? 500 : 200,
  mime: "application/json", ts: "2026-11-24T00:00:00Z", durationMs: i % 90,
}));

// ① checkXml
{
  const TC = req(path.join(ROOT, "test", "lib", "toolchain.js"));
  const jmx = req(path.join(ROOT, "jmx.js"));
  const xml = jmx.buildJmx(mkEntries(500));
  const { med } = await bench(() => TC.checkXml(xml), 7);
  ok(med < 300, `checkXml(500 条 JMX) 中位 ${med.toFixed(1)}ms < 300ms(基线 ~16ms, 拦数量级退化)`);
}

// ② net_list handler(3000 条 + UTF-8 字节统计, 真注册真 handler)
{
  const tools = await import("file:///" + path.join(ROOT, "bridge", "src", "tools.js").replace(/\\/g, "/"));
  const captured = {};
  const fakeServer = { registerTool: (n2, d, h) => { captured[n2] = h; } };
  const big = mkEntries(3000);
  const hubStub = { connected: true, extInfo: {}, daemonAllowControl: null, request: async (m) => (m === "net.list" ? big : {}) };
  tools.registerTools(fakeServer, hubStub, { archive: { append: () => 0, close() {} }, allowControl: false });
  const { med } = await bench(() => captured.net_list({ limit: 50 }), 7);
  ok(med < 100, `net_list(3000 条, UTF-8 字节摘要) 中位 ${med.toFixed(1)}ms < 100ms(基线 ~2ms)`);
}

// ③ buildHar(1000 条中文 —— TextEncoder 字节统计路径)
{
  const exp = await import("file:///" + path.join(ROOT, "bridge", "src", "exporters.js").replace(/\\/g, "/"));
  const mid = mkEntries(1000);
  const { med } = await bench(() => exp.buildHarText(mid), 5);
  ok(med < 200, `buildHAR(1000 条中文 content.size) 中位 ${med.toFixed(1)}ms < 200ms(基线 ~8ms)`);
}

// ④ buildJmx(500 条 —— clean + prelude + CSV 路径)
{
  const jmx = req(path.join(ROOT, "jmx.js"));
  const { med } = await bench(() => jmx.buildJmx(mkEntries(500)), 5);
  ok(med < 400, `buildJmx(500 条全管线) 中位 ${med.toFixed(1)}ms < 400ms(基线 ~15ms)`);
}

console.log(`\n=== perf baseline: ${pass} PASS / ${fail} FAIL ===`);
process.exit(fail ? 1 : 0);
