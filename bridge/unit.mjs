// bridge/unit.mjs —— 桥接内部单测(hub / archive), 不需要 Chrome、不需要扩展。
// 为什么单独一层: smoke.mjs 只覆盖"扩展视角"的端到端; hub 的拒绝分支(错令牌/版本不符/
// 控制开关/超时/断线失败/代理转发)与 archive 的落盘语义只有这里能精确断言。
// 用法: node bridge/unit.mjs   (需要 bridge/ 里 npm install 过: ws)

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import protocol from "../bridge-protocol.js";
import { z as z0 } from "zod";
import { Hub } from "./src/hub.js";
import { Archive } from "./src/archive.js";
import { parseArgs } from "./src/config.js";
import { makeRegister, registerTools } from "./src/tools.js";

const { FRAME, ERR, PROTOCOL_VERSION, WS_PATH } = protocol;
const TOKEN = "unit-token-xyz";
let pass = 0, fail = 0;
// 断言签名: ok(name, cond, got)。**参数反序是这套断言库唯一的静默失效方式**
// (ok(cond, "msg") 里字符串恒真 → 永远绿, 打印 "OK true")。本项目已因此栽过四次,
// 所以在库层拦住: 第一个参数是字符串以外的类型就直接抛, 不让它变成假绿。
const ok = (name, cond, got) => {
  if (typeof name !== "string") {
    throw new Error("ok() 参数顺序写反了: 第一个参数必须是断言名(字符串), 收到 " + typeof name);
  }
  if (cond) { pass++; console.log("  OK " + name); }
  else { fail++; console.log("  ✗ FAIL " + name + " → " + JSON.stringify(got)); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 工具函数: 起 hub / 连客户端 / 收一帧 ----
async function startHub(opts = {}) {
  const hub = new Hub({ host: "127.0.0.1", port: 0, token: TOKEN, allowControl: false, log: () => {}, ...opts });
  await hub.start();
  const port = hub.wss.address().port;
  return { hub, url: `ws://127.0.0.1:${port}${WS_PATH}` };
}

function connect(url, hello) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const frames = [];
    ws.on("open", () => ws.send(JSON.stringify(hello)));
    ws.on("message", (raw) => {
      const f = JSON.parse(raw.toString());
      frames.push(f);
      if (f.type === FRAME.READY || f.type === FRAME.ERROR) resolve({ ws, frames, first: f });
    });
    ws.on("error", reject);
    setTimeout(() => reject(new Error("connect timeout")), 4000);
  });
}

function extHello(extra = {}) {
  return { type: FRAME.HELLO, protocol: PROTOCOL_VERSION, token: TOKEN, ext: { version: "unit", ua: "unit-ext" }, ...extra };
}

// ============================================================ register 自校验
{
  console.log("\n[register] structuredContent 自校验");
  const captured = {};
  const fakeServer = { registerTool: (name, def, handler) => { captured[name] = { def, handler }; } };

  // 缺注解 → 立刻抛错(不给"忘了写注解"留静默通道)
  try {
    makeRegister(fakeServer)("ghost_tool", { title: "t", description: "d", inputSchema: {} }, async () => ({}));
    ok("缺注解 → 抛错", false, "未抛");
  } catch (e) {
    ok("缺注解 → 抛错", /缺少 annotations 声明/.test(e.message), e.message);
  }

  // structuredContent 不符 → 转成 bad_payload, 并指名工具与字段
  const reg = makeRegister(fakeServer);
  reg("bridge_status", {
    title: "t", description: "d", inputSchema: {},
    outputSchema: { connected: z0.boolean() },
  }, async () => ({ content: [{ type: "text", text: "x" }], structuredContent: { connected: "yes" } }));
  const bad = await captured.bridge_status.handler();
  ok("字段类型不符 → isError", bad.isError === true, bad);
  ok("不符 → 机读码 bad_payload 且指名工具", /^错误\[bad_payload\]: 工具 bridge_status /.test(bad.content[0].text), bad.content[0].text);
  ok("不符 → 指出具体字段", /connected/.test(bad.content[0].text), bad.content[0].text);

  // 多出未声明字段 → 同样被抓(zod 默认 strip? 这里用 strict 语义: safeParse 后对比键集合)
  reg("net_list", {
    title: "t", description: "d", inputSchema: {},
    outputSchema: { total: z0.number() },
  }, async () => ({ content: [{ type: "text", text: "x" }], structuredContent: { total: 1, extra: 2 } }));
  const extra = await captured.net_list.handler();
  ok("多声明外字段 → 被 strip 后仍结构化(schema 为准)", extra.structuredContent === undefined || extra.structuredContent.total === 1, extra.structuredContent);

  // 合法 → 原样透传
  reg("net_hosts", {
    title: "t", description: "d", inputSchema: {},
    outputSchema: { total: z0.number(), hosts: z0.array(z0.object({ host: z0.string(), count: z0.number() })) },
  }, async () => ({ content: [{ type: "text", text: "x" }], structuredContent: { total: 1, hosts: [{ host: "a", count: 1 }] } }));
  const good = await captured.net_hosts.handler();
  ok("合法 structuredContent → 原样透传", good.isError !== true && good.structuredContent.total === 1, good);

  // 错误结果不参与校验(错误里没有 structuredContent)
  reg("correlate", {
    title: "t", description: "d", inputSchema: {},
    outputSchema: { summary: z0.number() },
  }, async () => ({ content: [{ type: "text", text: "错误[no_entries]: x" }], isError: true }));
  const err = await captured.correlate.handler();
  ok("isError 结果跳过输出校验", err.isError === true, err);
}

// ============================================================ net_list 规模(3000 条)
// 抓包上限 3000 条/会话; net_list 要在这规模下仍然"快 + 只回摘要"。
// 这里不测绝对性能, 测三件会退化的事: 分页夹取、过滤扫全量、摘要不夹带正文。
{
  console.log("\n[net_list] 3000 条规模");
  const captured = {};
  const fakeServer = { registerTool: (n, d, h) => { captured[n] = { def: d, handler: h }; } };
  const entries = Array.from({ length: 3000 }, (_, i) => ({
    id: "e" + i,
    method: i % 2 ? "GET" : "POST",
    url: "https://h.test/p" + i,
    path: "/p" + i,
    status: i % 10 === 0 ? 500 : 200,
    durationMs: i,
    mime: "application/json",
    body: "x".repeat(200),
    response: "y".repeat(2000),
  }));
  const hubStub = { connected: true, extInfo: { version: "unit" }, request: async (m) => (m === "net.list" ? entries : {}) };
  registerTools(fakeServer, hubStub, { archive: { append: () => 0, close() {} }, allowControl: false });

  const t0 = Date.now();
  const r = await captured.net_list.handler({ limit: 50 });
  const ms = Date.now() - t0;
  const body = JSON.parse(r.content[0].text);
  ok("3000 条 limit=50 → 返回 50 条", body.entries.length === 50 && body.returned === 50, { n: body.entries.length, returned: body.returned });
  ok("total 报全量 3000", body.total === 3000, body.total);
  ok("摘要不含响应正文", body.entries.every((e) => !("response" in e)), Object.keys(body.entries[0]));
  ok("响应体积受控(摘要 < 60KB)", JSON.stringify(body).length < 60000, JSON.stringify(body).length);
  // 只拦"病态退化"(把 3000 条全量序列化/带正文之类), 不拦机器慢: 全量回归里前序套件
  // 刚跑完时这台机器就出现过 1s+ 抖动把断言打红(而单独跑 6 次全绿)—— 阈值放到 3s。
  ok("单次净耗时 < 3000ms(病态退化线)", ms < 3000, ms);

  const f = await captured.net_list.handler({ status: 500 });
  const fb = JSON.parse(f.content[0].text);
  ok("状态过滤扫全量(300 条命中)", fb.filtered === 300 && fb.returned === 50, { filtered: fb.filtered, returned: fb.returned });

  const off = await captured.net_list.handler({ offset: 2990, limit: 50 });
  const ob = JSON.parse(off.content[0].text);
  ok("末页不足一页时按实际返回(10 条)", ob.returned === 10 && ob.entries.length === 10, ob.returned);
}

// ============================================================ net_list 过滤语义
// 侧栏搜索框是"关键词分词 AND"(见 sidepanel matchFilter), bridge 的 net_* 是"字段级过滤";
// 两者口径**不同**且都合理(人搜词 vs 程序按字段筛), 但字段级这套的边界必须钉死 ——
// 尤其是 hostIncludes 的跨域误命中与 statusMin/Max 区间。
{
  console.log("\n[net_list] 字段过滤边界");
  const captured = {};
  const fakeServer = { registerTool: (n, d, h) => { captured[n] = { def: d, handler: h }; } };
  const rows = [
    { id: "f1", method: "GET", url: "https://api.test.com/a", path: "/a", status: 200, durationMs: 1, body: "", response: "" },
    { id: "f2", method: "POST", url: "https://api.test.com/b", path: "/b/order", status: 500, durationMs: 2, body: "{}", response: "" },
    { id: "f3", method: "GET", url: "https://other.test.com/a", path: "/a", status: 404, durationMs: 3, body: "", response: "" },
    { id: "f4", method: "GET", url: "https://api.test.com.cn/a", path: "/a", status: 302, durationMs: 4, body: "", response: "" },
  ];
  // 前缀陷阱: api.test.com 与 api.test.com.cn 的不同域; hostIncludes 是**子串**匹配, 会同时命中
  const hubStub = { connected: true, extInfo: {}, request: async (m) => (m === "net.list" ? rows : {}) };
  registerTools(fakeServer, hubStub, { archive: { append: () => 0, close() {} }, allowControl: false });
  const call = async (args) => JSON.parse((await captured.net_list.handler(args)).content[0].text);

  ok("method 精确匹配", (await call({ method: "post" })).returned === 1, (await call({ method: "post" })).returned);
  ok("status 数值精确", (await call({ status: 500 })).returned === 1, "n/a");
  // 四条数据 status: 200 / 500 / 404 / 302 —— ≥400 是 500 与 404 两条
  ok("statusMin 只看失败(≥400)", (await call({ statusMin: 400 })).filtered === 2, (await call({ statusMin: 400 })).filtered);
  ok("statusMax 只看成功(<400)", (await call({ statusMax: 399 })).filtered === 2, (await call({ statusMax: 399 })).filtered);
  ok("statusMin+Max 区间(300..404)", (await call({ statusMin: 300, statusMax: 404 })).filtered === 2,
    (await call({ statusMin: 300, statusMax: 404 })).filtered);
  ok("多条件 AND(method+statusMin)", (await call({ method: "GET", statusMin: 400 })).filtered === 1,
    (await call({ method: "GET", statusMin: 400 })).filtered);
  const hostHit = await call({ hostIncludes: "api.test.com" });
  ok("hostIncludes 是子串匹配(会同时命中 api.test.com.cn)", hostHit.filtered === 3, hostHit.filtered);
  ok("pathIncludes 路径子串", (await call({ pathIncludes: "/order" })).returned === 1, "n/a");
  ok("组合过滤无命中时仍报 total/filtered(不报错)", (await call({ method: "DELETE" })).filtered === 0, "n/a");
}

// ============================================================ config(参数校验)
{
  console.log("\n[config] 参数解析与守卫");
  const d = parseArgs([]);
  ok("默认值: 127.0.0.1:9280, 控制类关闭", d.host === "127.0.0.1" && d.port === 9280 && d.allowControl === false, d);

  const p = parseArgs(["--port", "19380", "--allow-control", "--host", "127.0.0.1"]);
  ok("正常解析端口/开关/地址", p.port === 19380 && p.allowControl === true, p);

  const bad = (argv) => { try { parseArgs(argv); return ""; } catch (e) { return e.message; } };
  ok("--port 非数字 → 明确报错", /--port 必须是 1\.\.65535/.test(bad(["--port", "http"])), bad(["--port", "http"]));
  ok("--port 越界 → 报错", /--port 必须是/.test(bad(["--port", "70000"])), bad(["--port", "70000"]));
  ok("--port 漏值 → 报错", /缺少值/.test(bad(["--port"])), bad(["--port"]));
  ok("--port 吞掉下一个 flag → 报错", /缺少值/.test(bad(["--port", "--quiet"])), bad(["--port", "--quiet"]));
  ok("未知参数 → 报错并列出可用参数", /未知参数: --alow-control/.test(bad(["--alow-control"])) && /--allow-control/.test(bad(["--alow-control"])),
    bad(["--alow-control"]));
  ok("--host 空串 → 报错", /不能为空/.test(bad(["--host", "  "])), bad(["--host", "  "]));
  ok("--help 仍可用", parseArgs(["--help"]).help === true, parseArgs(["--help"]));

  // --flag=value 形式(值里允许再出现 '=': 令牌常带 base64 padding)
  const eqForm = parseArgs(["--port=9400", "--token=abc==", "--archive-keep-days=7"]);
  ok("--port=9400 解析", eqForm.port === 9400, eqForm.port);
  ok("--token=abc== 原样保留", eqForm.token === "abc==", eqForm.token);
  ok("--archive-keep-days=7 解析", eqForm.archiveKeepDays === 7, eqForm.archiveKeepDays);
  ok("未知 --foo=bar 仍报未知参数", /未知参数: --foo=bar/.test(bad(["--foo=bar"])), bad(["--foo=bar"]));
  ok("不给调用方数组时也不原地改", (() => { const a = ["--port=1"]; parseArgs(a); return a[0] === "--port=1"; })(), "n/a");
}

// ============================================================ hub
{
  console.log("\n[hub] 握手与拒绝");
  const { hub, url } = await startHub();

  let r = await connect(url, { ...extHello(), token: "wrong" });
  ok("错令牌 → unauthorized", r.first.type === FRAME.ERROR && r.first.code === ERR.UNAUTHORIZED, r.first);
  r.ws.close();

  r = await connect(url, { ...extHello(), protocol: 99 });
  ok("协议版本不符 → protocol_mismatch", r.first.code === ERR.PROTOCOL_MISMATCH, r.first);
  r.ws.close();

  r = await connect(url, extHello());
  ok("正确握手 → ready", r.first.type === FRAME.READY && r.first.protocol === PROTOCOL_VERSION, r.first);
  ok("hub.connected 为真", hub.connected === true, hub.connected);
  ok("extInfo 记录扩展信息", hub.extInfo && hub.extInfo.version === "unit", hub.extInfo);

  // 请求超时: 扩展不回
  const t0 = Date.now();
  let timeoutCode = "";
  try { await hub.request("net.list", {}, { timeoutMs: 250 }); } catch (e) { timeoutCode = e.code; }
  ok("扩展不回 → timeout 码", timeoutCode === ERR.TIMEOUT, { timeoutCode, ms: Date.now() - t0 });

  // 扩展回包: 正常 resolve
  r.ws.on("message", (raw) => {
    const f = JSON.parse(raw.toString());
    if (f.type === FRAME.REQ) r.ws.send(JSON.stringify({ type: FRAME.RES, id: f.id, ok: true, result: [{ id: "u1" }] }));
  });
  const list = await hub.request("net.list");
  ok("扩展回包 → 原样返回结果", Array.isArray(list) && list[0].id === "u1", list);

  // 扩展回错误
  r.ws.removeAllListeners("message");
  r.ws.on("message", (raw) => {
    const f = JSON.parse(raw.toString());
    if (f.type === FRAME.REQ) r.ws.send(JSON.stringify({ type: FRAME.RES, id: f.id, ok: false, error: "扩展内部炸了" }));
  });
  let extCode = "", extMsg = "";
  try { await hub.request("net.get", { id: "x" }); } catch (e) { extCode = e.code; extMsg = e.message; }
  ok("扩展返回 ok:false → ext_error 码 + 原文", extCode === ERR.EEXT && extMsg === "扩展内部炸了", { extCode, extMsg });

  // 控制开关
  let forbid = "";
  try { await hub.request("page.click", { ref: "e1" }); } catch (e) { forbid = e.code; }
  ok("未开 --allow-control → forbidden(且没发给扩展)", forbid === ERR.FORBIDDEN, forbid);

  let unknown = "";
  try { await hub.request("no.such.method"); } catch (e) { unknown = e.code; }
  ok("未知方法 → unknown_method", unknown === ERR.UNKNOWN_METHOD, unknown);

  // 断线: 在途请求立刻失败(先摘掉扩展的应答器, 否则它会先回包, 测的是别的分支)
  r.ws.removeAllListeners("message");
  const inflight = hub.request("net.list", {}, { timeoutMs: 5000 }).then(() => "resolved", (e) => e.code);
  await sleep(50);
  r.ws.close();
  const afterClose = await inflight;
  ok("扩展断线 → 在途请求立刻 not_connected(不干等超时)", afterClose === ERR.NOT_CONNECTED, afterClose);
  let offCode = "";
  try { await hub.request("net.list"); } catch (e) { offCode = e.code; }
  ok("离线调用 → not_connected", offCode === ERR.NOT_CONNECTED, offCode);
  await hub.stop();
}

{
  console.log("\n[hub] MCP 代理转发与 ext.status 广播");
  const { hub, url } = await startHub({ allowControl: true });
  const ext = await connect(url, extHello());
  ext.ws.on("message", (raw) => {
    const f = JSON.parse(raw.toString());
    if (f.type === FRAME.REQ) {
      const result = f.method === "net.list" ? [{ id: "a1" }] : { ok: true };
      ext.ws.send(JSON.stringify({ type: FRAME.RES, id: f.id, ok: true, result }));
    }
  });

  const proxy = await connect(url, {
    type: FRAME.HELLO, protocol: PROTOCOL_VERSION, token: TOKEN,
    ext: { version: "mcp-proxy", ua: "web-toolbox-mcp" },
  });
  ok("代理握手 → ready 且 role=proxy", proxy.first.type === FRAME.READY && proxy.first.bridge.role === "proxy", proxy.first);
  ok("代理 READY 带 extensionOnline", proxy.first.bridge.extensionOnline === true, proxy.first.bridge);

  const got = await new Promise((resolve, reject) => {
    proxy.ws.on("message", (raw) => {
      const f = JSON.parse(raw.toString());
      if (f.type === FRAME.RES && f.id === "q1") resolve(f);
    });
    proxy.ws.send(JSON.stringify({ type: FRAME.QUERY, id: "q1", method: "net.list", params: {} }));
    setTimeout(() => reject(new Error("proxy relay timeout")), 4000);
  });
  ok("代理 QUERY 被转到扩展并按原 id 回包", got.ok === true && got.result[0].id === "a1", got);

  // 未鉴权的连接不许发 query
  const rogue = await new Promise((resolve) => {
    const ws = new WebSocket(url);
    ws.on("open", () => ws.send(JSON.stringify({ type: FRAME.QUERY, id: "z", method: "net.list" })));
    ws.on("message", (raw) => resolve(JSON.parse(raw.toString())));
  });
  ok("未鉴权 query → unauthorized", rogue.code === ERR.UNAUTHORIZED, rogue);

  // 扩展断线 → 代理收到 ext.status online:false
  const status = new Promise((resolve) => {
    proxy.ws.on("message", (raw) => {
      const f = JSON.parse(raw.toString());
      if (f.type === FRAME.EVENT && f.event === "ext.status" && f.data.online === false) resolve(f);
    });
  });
  ext.ws.close();
  // hub 广播 ext.status 是断线即推(事件驱动), 正常 <100ms 就 resolve。
  // 兜底上限**只影响失败路径** —— 正常情况根本等不满, 所以放宽到 2500ms 毫无性能代价;
  // 反过来把它收到 600ms(曾以为能"省时间")只会削掉并发时的抗抖余量, 换来假红。
  const st = await Promise.race([status, sleep(2500).then(() => null)]);
  ok("扩展断线 → 代理收到 ext.status(online:false)", st && st.data.online === false, st);
  proxy.ws.close();
  await hub.stop();
}

// ============================================================ archive
{
  console.log("\n[archive] 落盘语义");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wt_archive_"));
  const a = new Archive(path.join(dir, "nested"));
  ok("init 建目录成功", await a.init(), a.enabled);
  if (process.platform === "win32") {
    ok("归档目录权限 — Windows 不适用(ACL 继承)", true, "n/a");
  } else {
    const dmode = fs.statSync(path.join(dir, "nested")).mode & 0o777;
    ok("归档目录权限 0700", (dmode & 0o077) === 0, "0o" + dmode.toString(8));
  }
  const n = a.append([{ id: "e1", url: "https://a.test/x" }, { id: "e2", url: "https://a.test/y" }], { batchId: "b1" });
  ok("append 返回写入条数", n === 2, n);
  a.close();
  // createWriteStream 是异步落盘: close() 只发起 end(), 要等 finish 才保证文件已建
  await new Promise((r) => setTimeout(r, 200));
  const dirFiles = () => fs.readdirSync(path.join(dir, "nested")).filter((f) => f.startsWith("harvest-"));
  for (let i = 0; i < 20 && dirFiles().length === 0; i++) await sleep(100);
  const files = dirFiles();
  ok("按天生成 harvest-YYYY-MM-DD.jsonl", files.length === 1 && /^harvest-\d{4}-\d{2}-\d{2}\.jsonl$/.test(files[0]), files);
  const lines = files.length
    ? fs.readFileSync(path.join(dir, "nested", files[0]), "utf8").trim().split("\n").map((l) => JSON.parse(l))
    : [];
  ok("每行含 batchId/archivedAt/entry", lines.length === 2 && lines[0].batchId === "b1"
    && typeof lines[0].archivedAt === "string" && lines[0].entry.id === "e1", lines[0]);
  // 归档是明文流量, 只给本人读(POSIX 0600); Windows 由用户目录 ACL 继承, 不适用
  if (process.platform === "win32") {
    ok("归档文件权限 — Windows 不适用(ACL 继承)", true, "n/a");
  } else {
    const mode = fs.statSync(path.join(dir, "nested", files[0])).mode & 0o777;
    ok("归档文件权限 0600", (mode & 0o077) === 0, "0o" + mode.toString(8));
  }

  ok("append 非数组 → 0(不抛)", a.append("oops") === 0, "n/a");
  ok("append 空数组 → 0", a.append([]) === 0, "n/a");
  ok("close 幂等", (() => { a.close(); a.close(); return true; })(), "n/a");

  const bad = new Archive(path.join(dir, "not-a-dir"));
  fs.writeFileSync(path.join(dir, "not-a-dir"), "x");
  ok("目录不可建 → init 返回 false 且 enabled=false(不抛)", (await bad.init()) === false && bad.enabled === false, bad.enabled);
  ok("未启用时 append → 0(不抛)", bad.append([{ id: "x" }]) === 0, "n/a");
  fs.rmSync(dir, { recursive: true, force: true });
}

// ============================================================ archive 保留期清理
{
  console.log("\n[archive] 按天清理(keepDays)");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wt_prune_"));
  const day = (offset) => new Date(Date.now() - offset * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const write = (name, body = "{}\n") => fs.writeFileSync(path.join(dir, name), body);
  write(`harvest-${day(0)}.jsonl`);
  write(`harvest-${day(10)}.jsonl`);
  write(`harvest-${day(40)}.jsonl`);
  write(`harvest-${day(400)}.jsonl`);
  write("notes.txt", "keep me");
  write("harvest-bad-name.jsonl");

  const a30 = new Archive(dir, { keepDays: 30 });
  await a30.init();
  const left = fs.readdirSync(dir).sort();
  ok("超过 30 天的日归档被删(40/400 天)", !left.includes(`harvest-${day(40)}.jsonl`) && !left.includes(`harvest-${day(400)}.jsonl`), left);
  ok("保留期内不动(今天/10 天前)", left.includes(`harvest-${day(0)}.jsonl`) && left.includes(`harvest-${day(10)}.jsonl`), left);
  ok("非归档文件与非法命名不碰", left.includes("notes.txt") && left.includes("harvest-bad-name.jsonl"), left);
  ok("prune 报告删除清单", a30.pruned.removed.length === 2 && a30.pruned.kept === 2, a30.pruned);
  // dry-run: 只报不删(doctor 用它展示"本次启动会删哪些")
  write(`harvest-${day(40)}.jsonl`);
  const plan = a30.prune(30, { dryRun: true });
  ok("dryRun 只报不删", plan.removed.length === 1 && fs.existsSync(path.join(dir, `harvest-${day(40)}.jsonl`)), plan);

  // keepDays 0 = 不清理(默认): 即使有很老的归档也保留
  // 注意: dryRun 那步又写回来一个 40 天前的文件, 这里要取"当前"快照而不是更早的 left.length
  const before0 = fs.readdirSync(dir).length;
  const a0 = new Archive(dir, { keepDays: 0 });
  await a0.init();
  ok("keepDays=0 不清理", fs.readdirSync(dir).length === before0 && !a0.pruned, { before: before0, after: fs.readdirSync(dir).length });
  fs.rmSync(dir, { recursive: true, force: true });
}


// ---- tabId 解析语义(v1.1.72) ----
// 此前 typeof !== "number" 一律回落活动标签页 —— MCP 客户端传字符串 "5" 时, 用户以为在录
// tab 5, 实际录的是活动标签页(静默错目标)。现在: 缺失才回落, 非法值必报错。
{
  const bc = fs.readFileSync(new URL("../bridge-client.js", import.meta.url), "utf8");
  ok(
    "bridgeResolveTabId: 缺失才回落, 非法值报错(不静默改目标)",
    /tabId === undefined \|\| tabId === null/.test(bc) && /Number\.isInteger\(n\)/.test(bc) && /tabId 必须是正整数/.test(bc),
  );
  ok(
    "rec.start 复用同一解析(无自己的回退分支)",
    /case "rec\.start"[\s\S]{0,240}bridgeResolveTabId\(params\.tabId\)/.test(bc),
  );
}


// ---- ref 安全性(v1.1.73) ----
// ref 是外部输入(MCP 客户端给)。旧实现把 ref 拼进属性选择器字符串, 引号/方括号会被当语法;
// 目前靠 4 个调用方各自校验兜着 —— 新增 ref 工具漏写校验就是注入面。
// 现在: ①8 处页面内查找全部改为属性遍历(零解析); ②bridgeSettleRect 统一校验。
{
  const bc = fs.readFileSync(new URL("../bridge-client.js", import.meta.url), "utf8");
  ok(
    "外部 ref 不再拼进选择器(全部走属性遍历)",
    (bc.match(/data-ai-ref="' \+/g) || []).length === 0,
  );
  ok(
    "bridgeSettleRect 统一校验 ref(不依赖调用方)",
    /async function bridgeSettleRect\(tabId, ref\) \{[\s\S]{0,200}\^e\\d\+\$/.test(bc),
  );
}


// ---- archive 可观测性 + 只写不读口径(v1.1.79) ----
// 缺口: 开了 --archive-dir 无从判断归档是否在工作(用户只能翻目录); 且归档侧注释曾承诺
// "AI 能回看更长历史", 而工具面根本没有读取入口 —— 承诺与实现必须一致(这里钉"只写不读")。
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wt-arch-"));
  const a = new Archive(dir, { keepDays: 0 });
  await a.init();
  const empty = a.stats();
  ok("stats: 已启用", empty.enabled === true)
  ok("stats: 空目录 → 0/0/null", empty.files === 0 && empty.lines === 0 && empty.latest === null)
  a.append([{ id: "x1", method: "GET", url: "https://a.test/x" }, { id: "x2", method: "GET", url: "https://a.test/y" }]);
  await new Promise((r) => setTimeout(r, 60));
  a.close();
  const filled = a.stats();
  ok(`stats: 写 2 条 → 1 文件 2 行(实得 ${filled.files}/${filled.lines})`, filled.files === 1 && filled.lines === 2);
  ok("stats: bytes 与 latest 日期", filled.bytes > 0 && /^\d{4}-\d{2}-\d{2}$/.test(filled.latest))
  fs.rmSync(dir, { recursive: true, force: true });

  // 只写不读: 工具面不暴露任何 archive 读方法
  const toolsSrc = fs.readFileSync(new URL("./src/tools.js", import.meta.url), "utf8");
  const idxSrc = fs.readFileSync(new URL("./src/index.js", import.meta.url), "utf8");
  const hook = idxSrc.slice(idxSrc.indexOf("registerTools(server, hub,"));
  ok("index 传给 tools 的是真 archive(不是写死 stub)", !/archive: \{ append: \(\) => 0/.test(hook))
  ok("工具面没有归档读取入口(只写不读, 与注释口径一致)", !/archive\.(read|query|list|scan|load)\b/.test(toolsSrc))
  ok("bridge_status 暴露 archive 状态", /archive: typeof ctx\.archive\?\.stats/.test(toolsSrc))
}


// ---- 请求 id 唯一性(v1.1.86) ----
// id 是 hub/index 两处 pending 表的 key —— 碰撞会 set() 覆盖前一个 promise, 那个请求永远
// 等不到结果(静默挂起, 比报错更难查)。所以 makeId 必须单调不重复, 不只是"概率很低"。
{
  const p2 = (await import("../bridge-protocol.js")).default;
  const seen = new Set();
  for (let i = 0; i < 50000; i++) seen.add(p2.makeId("q"));
  ok("makeId 生成 5 万个不重复(单进程内绝对唯一)", seen.size === 50000, seen.size);
  const ids = [];
  for (let i = 0; i < 5; i++) ids.push(p2.makeId("q"));
  ok("makeId 形如 q<时间戳>-<自增序><随机>", ids.every((x) => /^q[a-z0-9]+-[a-z0-9]+$/.test(x)), ids);
}

console.log(`\n=== bridge unit: ${pass} PASS / ${fail} FAIL ===`);
process.exit(fail ? 1 : 0);
