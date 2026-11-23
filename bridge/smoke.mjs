// bridge/smoke.mjs —— 端到端自检: 模拟扩展连上来, 跑一遍握手/请求/事件/错误分支。
// 用法: node smoke.mjs   (会临时起一个 bridge, 结束后自动关闭)

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import protocol from "../bridge-protocol.js";

const { FRAME, ERR, PROTOCOL_VERSION } = protocol;
const PORT = 9399;
const TOKEN = "smoke-token-abc";
const BASE = `ws://127.0.0.1:${PORT}${protocol.WS_PATH}`;
// 入口必须用绝对路径: 早先写 "./src/index.js" 按 cwd 解析, 在仓库根跑
// `node bridge/smoke.mjs`(README 的写法)时子进程 ENOENT 立刻退出, 外部只看到
// ECONNREFUSED 9399 —— 像是 bridge 起不来, 其实是路径问题(2026-11 走查修复)。
const ENTRY = fileURLToPath(new URL("./src/index.js", import.meta.url));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  OK " + m); } else { fail++; console.log("  ✗ FAIL " + m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 端口就绪探测(代替固定 700ms): bridge spawn 后 WS listen 实测 <400ms;
// TCP 连上即返回, 省一半等待且不受机器慢的影响。
const net = await import("node:net");
function waitPort(port, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tryOnce = () => {
      const sock = net.connect({ host: "127.0.0.1", port });
      const done = (v) => { sock.destroy(); if (v || Date.now() - t0 > timeoutMs) resolve(v); else setTimeout(tryOnce, 60); };
      sock.on("connect", () => done(true));
      sock.on("error", () => done(false));
    };
    tryOnce();
  });
}

function startBridge(extraArgs = []) {
  const p = spawn(process.execPath, [ENTRY, "--port", String(PORT), "--quiet", ...extraArgs], {
    env: { ...process.env, WEB_TOOLBOX_TOKEN: TOKEN },
    stdio: ["pipe", "pipe", "pipe"],
  });
  p.stderr.on("data", () => {});   // 静默, 失败信息由断言体现
  return p;
}

// 端口释放有延迟(上一个 bridge 刚 kill), 连接要重试而不是一次就放弃
async function connectRetry(token = TOKEN, protoVersion = PROTOCOL_VERSION, tries = 20, base = BASE) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await connect(token, protoVersion, base);
    } catch (e) {
      lastErr = e;
      await sleep(150);
    }
  }
  throw lastErr;
}

function connect(token = TOKEN, protoVersion = PROTOCOL_VERSION, base = BASE) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(base);
    const frames = [];
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: FRAME.HELLO, protocol: protoVersion, token, ext: { version: "test" } }));
    });
    ws.on("message", (raw) => {
      const f = JSON.parse(raw.toString());
      frames.push(f);
      if (f.type === FRAME.READY || f.type === FRAME.ERROR) resolve({ ws, frames, first: f });
    });
    ws.on("error", reject);
    setTimeout(() => reject(new Error("connect timeout")), 4000);
  });
}

// 注册一个"假扩展": 收到 REQ 就按 handler 回 RES
function serveExt(ws, handler) {
  ws.on("message", (raw) => {
    const f = JSON.parse(raw.toString());
    if (f.type !== FRAME.REQ) return;
    let out;
    try { out = handler(f.method, f.params); }
    catch (e) { out = { __err: e.message }; }
    if (out && out.__err) {
      ws.send(JSON.stringify({ type: FRAME.RES, id: f.id, ok: false, error: out.__err }));
    } else {
      ws.send(JSON.stringify({ type: FRAME.RES, id: f.id, ok: true, result: out }));
    }
  });
}

// 用 MCP stdio 驱动 bridge 的工具, 验证工具层端到端。
// 注意: initialize 只能发一次(MCP 握手是一次性的), 之后复用同一条 stdio 连接。
function makeMcpClient(proc) {
  let buf = "";
  const waiters = new Map();   // id -> resolve
  proc.stdout.on("data", (d) => {
    buf += d.toString();
    const lines = buf.split("\n");
    buf = lines.pop();          // 最后一段可能不完整, 留到下次
    for (const line of lines) {
      if (!line.trim()) continue;
      let j;
      try { j = JSON.parse(line); } catch { continue; }
      const w = waiters.get(j.id);
      if (w) { waiters.delete(j.id); w(j); }
    }
  });

  let nextId = 1;
  function send(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiters.delete(id); reject(new Error("mcp timeout " + method)); }, 8000);
      waiters.set(id, (j) => { clearTimeout(timer); resolve(j); });
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  return {
    async init() {
      await send("initialize", {
        protocolVersion: "2024-11-05", capabilities: {},
        clientInfo: { name: "smoke", version: "1" },
      });
      // 标准 MCP 握手收尾(通知, 无 id)
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    },
    send,
    async callTool(name, args) {
      const j = await send("tools/call", { name, arguments: args || {} });
      return j.result || j.error;
    },
  };
}

(async () => {
  // ============ 1. 鉴权分支 ============
  {
    console.log("\n[1] 鉴权");
    const proc = startBridge(["--allow-control"]);
    await waitPort(PORT);
    let r = await connectRetry("wrong-token");
    ok(r.first.type === FRAME.ERROR && r.first.code === ERR.UNAUTHORIZED, "错误令牌被拒");
    r.ws.close();

    r = await connectRetry(TOKEN);
    ok(r.first.type === FRAME.READY && r.first.protocol === PROTOCOL_VERSION, "正确令牌握手成功");
    ok(r.first.bridge && r.first.bridge.allowControl === true, "READY 带能力开关");
    r.ws.close();

    r = await connectRetry(TOKEN, 99);
    ok(r.first.type === FRAME.ERROR && r.first.code === ERR.PROTOCOL_MISMATCH, "协议版本不符被拒");

    proc.kill();
    await sleep(200);
  }

  // ============ 2. 请求/响应 + 事件 ============
  {
    console.log("\n[2] 请求响应与事件");
    const proc = startBridge(["--allow-control"]);
    await waitPort(PORT);

    const { ws } = await connectRetry(TOKEN);
    serveExt(ws, (method, params) => {
      if (method === "net.list") return [{ id: "r1", method: "GET", url: "https://a.com/x", path: "/x", status: 200, body: "你好", response: "世界" }];
      if (method === "net.get") {
        if (params.id === "rbig") return { id: "rbig", url: "https://a.com/big", path: "/big", response: "y".repeat(5000), mime: "text/plain" };
        return { id: params.id, url: "https://a.com/x", response: "hello" };
      }
      if (method === "rec.status") return { recState: "recording", count: 1 };
      if (method === "tab.list") return [{ id: 1, title: "t", url: "https://a.com", active: true }];
      if (method === "net.hosts") return [{ host: "a.com", count: 2 }, { host: "b.com", count: 1 }];
      if (method === "page.eval") return { ok: true, value: "v" + params.script };
      if (method === "chain.replay") return [
        { verdict: "OK", method: "GET", path: "/x", recordedStatus: 200, liveStatus: 200, msg: "" },
      ];
      // 控制类直通: 每个方法回一个可断言的最小结果(证明工具→协议→扩展三段都通)
      if (method === "rec.start") return { ok: true, recState: "recording", tabId: params.tabId || 1 };
      if (method === "rec.stop") return { ok: true, recState: "idle" };
      if (method === "tab.navigate") return { ok: true, url: params.url };
      if (method === "tab.activate") return { ok: true, tabId: params.tabId || 1 };
      if (method === "tab.close") return { ok: true, closed: params.tabId || 1 };
      if (method === "page.snapshot") return { ok: true, text: 'e1 button "登录"', refs: 1 };
      if (method === "page.type") return { ok: true, typed: params.text, submit: !!params.submit, keyByKey: !!params.keyByKey };
      if (method === "page.press") return { ok: true, key: params.key };
      if (method === "page.hover") return { ok: true, ref: params.ref };
      if (method === "page.select") return { ok: true, ref: params.ref, value: params.value };
      if (method === "page.scroll") return { ok: true, ref: params.ref || null, deltaY: params.deltaY || 0 };
      if (method === "page.wait") return { ok: true, condition: params.selector || params.text || params.ms || "" };
      if (method === "page.screenshot") return { ok: true, dataUrl: "data:image/png;base64,AAAA" };
      if (method === "page.eval") return { ok: true, value: "v" + params.script };
      return { __err: "unknown " + method };
    });

    const mcp = makeMcpClient(proc);
    await mcp.init();
    await sleep(300);
    let res = await mcp.callTool("bridge_status", {});
    const st = JSON.parse(res.content[0].text);
    ok(st.connected === true, "bridge_status 显示已连接");
    ok(st.recording && st.recording.recState === "recording", "bridge_status 透传录制状态");
    // 控制开关要能分辨"谁开的": 本地 ctx.allowControl 与 daemon 侧 bridge.allowControl
    ok(st.allowControl === true, "bridge_status 报本地控制开关(true)");
    ok(st.daemonAllowControl === true || st.daemonAllowControl === null,
      "bridge_status 报 daemon 控制开关(单进程为 null)", st.daemonAllowControl);
    ok(st.controlMismatch === false || st.controlMismatch === undefined,
      "两开关一致时 controlMismatch 不为 true", st.controlMismatch);

    res = await mcp.callTool("net_list", { limit: 10 });
    if (res.isError) {
      ok(false, "net_list 不应报错: " + res.content[0].text);
    } else {
      const list = JSON.parse(res.content[0].text);
      ok(list.total === 1 && list.entries[0].id === "r1", "net_list 返回条目");
      ok(!("response" in list.entries[0]), "net_list 不返回响应正文(瘦身)");
      // 结构化返回(v1.1.9): 客户端可直接取字段, 不必再 parse 文本
      const sc = res.structuredContent;
      ok(sc && sc.total === 1 && sc.returned === 1 && sc.entries[0].id === "r1",
        "net_list 带 structuredContent(total/returned/entries)");
      ok(sc && typeof sc.limit === "number" && typeof sc.offset === "number",
        "structuredContent 含分页字段");
      // 字节口径: "你好"/"世界" 各 2 字符 6 字节 —— .length 会给 2, 断言 6 才能区分新旧实现
      ok(sc && sc.entries[0].reqBytes === 6 && sc.entries[0].respBytes === 6,
        "reqBytes/respBytes 是 UTF-8 字节数(中文 2 字符 → 6 字节)", sc && sc.entries[0]);
    }

    // 分页/夹取边界: limit 超上限夹到 500; offset 越界 returned 0 但 total 仍报
    res = await mcp.callTool("net_list", { limit: 5000 });
    const clamped = JSON.parse(res.content[0].text);
    ok(clamped.limit === 500 && clamped.returned === 1 && clamped.total === 1,
      "limit 超上限 → 夹到 500(且仍按实际条数返回)", { limit: clamped.limit, returned: clamped.returned });
    res = await mcp.callTool("net_list", { offset: 999 });
    const beyond = JSON.parse(res.content[0].text);
    ok(beyond.returned === 0 && beyond.total === 1 && beyond.offset === 999,
      "offset 越界 → returned 0 / total 仍报原始条数", beyond);
    res = await mcp.callTool("net_list", { status: 500 });
    const none = JSON.parse(res.content[0].text);
    ok(none.returned === 0 && none.filtered === 0 && none.total === 1,
      "过滤无命中 → 不报错, 用 filtered/returned = 0 表达", none);

    // correlate 结构化返回: 同接口两条录制 + 动态值 → groups/summary 直接可取
    res = await mcp.callTool("correlate", { pathIncludes: "/x" });
    if (res.isError) {
      ok(false, "correlate 不应报错: " + res.content[0].text);
    } else {
      const cs = res.structuredContent;
      ok(cs && typeof cs.summary === "number" && Array.isArray(cs.groups),
        "correlate 带 structuredContent(summary/groups)");
    }

    res = await mcp.callTool("net_get", { id: "r1" });
    const one = JSON.parse(res.content[0].text);
    ok(one.response === "hello", "net_get 返回正文");
    ok(res.structuredContent && res.structuredContent.truncated === false
      && res.structuredContent.originalChars === 5, "net_get 结构化: 未截断时 truncated=false + originalChars",
      res.structuredContent && { truncated: res.structuredContent.truncated, originalChars: res.structuredContent.originalChars });

    // 正文截断: 5000 字符 + maxBody 100 → 前 100 字符原样, 其后紧跟"已截断"说明
    res = await mcp.callTool("net_get", { id: "rbig", maxBody: 100 });
    const big = JSON.parse(res.content[0].text);
    ok(big.response.startsWith("y".repeat(100)) && big.response[100] !== "y",
      "maxBody 生效(第 101 个字符起被截断)", big.response.slice(95, 105));
    ok(/已截断/.test(big.response) && /原文 5000 字符/.test(big.response), "截断处明示原文长度", big.response.slice(-80));
    ok(res.structuredContent && res.structuredContent.truncated === true
      && res.structuredContent.originalChars === 5000 && res.structuredContent.maxBody === 100,
      "net_get 结构化: truncated/originalChars/maxBody 可直接判断",
      res.structuredContent && { t: res.structuredContent.truncated, o: res.structuredContent.originalChars, m: res.structuredContent.maxBody });
    // 下限夹取: maxBody 给 1 也应至少给 100(避免"要一个字符"把 JSON 撑坏)
    res = await mcp.callTool("net_get", { id: "rbig", maxBody: 1 });
    const tiny = JSON.parse(res.content[0].text);
    ok(tiny.response.startsWith("y".repeat(100)) && tiny.response[100] !== "y",
      "maxBody 低于下限 → 夹到 100", tiny.response.slice(95, 105));

    // tab_list 结构化: {total, tabs}(数组同 net_hosts 的包裹法)
    res = await mcp.callTool("tab_list", {});
    const tl = res.structuredContent;
    ok(tl && tl.total === 1 && tl.tabs[0].id === 1 && tl.tabs[0].active === true,
      "tab_list 带 structuredContent(total/tabs)", tl);

    // chain_replay 结构化: verdicts 机读(客户端免 parse 文本), failed/summary 保持人读。
    // 假扩展要能接 chain.replay —— serveExt 已把未知方法回 __err, 上面那个 unknown 就是它,
    // 所以这里给 handler 补 chain.replay 分支(返回两条结果)。
    const cr = await mcp.callTool("chain_replay", { ids: ["r1"] });
    if (cr.isError) {
      ok(false, "chain_replay 不应报错: " + cr.content[0].text);
    } else {
      const cs = cr.structuredContent;
      ok(cs && cs.total === 1 && Array.isArray(cs.verdicts) && Array.isArray(cs.results),
        "chain_replay 带 structuredContent(total/verdicts/results)", cs && Object.keys(cs));
      ok(cs && cs.results.length === 1 && typeof cs.results[0].verdict === "string",
        "每条结果都带 verdict", cs && cs.results);
    }

    // net_hosts 结构化(根必须是对象, 所以用 {total, hosts} 包裹而非直接给数组)
    res = await mcp.callTool("net_hosts", {});
    const hs = res.structuredContent;
    ok(hs && hs.total === 3 && hs.hosts.length === 2 && hs.hosts[0].host === "a.com",
      "net_hosts 带 structuredContent(total/hosts)", hs);

    // 事件: 扩展主动推 harvest, bridge 应归档并通知
    ws.send(JSON.stringify({ type: FRAME.EVENT, event: "harvest", data: { entries: [{ id: "r9" }] } }));
    await sleep(150);
    ok(true, "事件帧被接受(不报错)");

    // 迟到/未知 id 的响应不应崩
    ws.send(JSON.stringify({ type: FRAME.RES, id: "nonexistent", ok: true, result: 1 }));
    await sleep(100);

    ws.close();
    proc.kill();
    await sleep(200);
  }

  // ============ 3. 控制开关 ============
  {
    console.log("\n[3] 控制类开关");
    const proc = startBridge([]);   // 不带 --allow-control
await waitPort(PORT);
    const { ws } = await connectRetry(TOKEN);
    serveExt(ws, (m) => (Array.isArray(m) ? m : []));   // 返回合法空数组: net.list 必须是数组

    const mcp = makeMcpClient(proc);
    await mcp.init();
    await sleep(300);
    const res = await mcp.callTool("page_click", { ref: "e1" });
    ok(res.isError === true, "未启用时 page_click 被拒");
    ok(/allow-control/.test(res.content[0].text), "错误信息提示开启方式");

    const res2 = await mcp.callTool("net_list", {});
    ok(!res2.isError, "只读工具不受影响");

    ws.close();
    proc.kill();
    await sleep(200);
  }

  // ============ 4. 扩展离线(daemon 在跑, 但扩展没连) ============
  {
    console.log("\n[4] 扩展离线");
    const proc = startBridge([]);
    await waitPort(PORT); // 等它自己拉起 daemon(探测即走)
    const mcp = makeMcpClient(proc);
    await mcp.init();
    await sleep(500);
    const res = await mcp.callTool("bridge_status", {});
    const st = JSON.parse(res.content[0].text);
    ok(st.connected === false, "daemon 在但扩展离线时, connected 必须为 false");
    ok(!!st.hint, "给出连接指引");
    proc.kill();
    await sleep(200);
  }

  // ============ 5. 工具注解(协议层可见性) ============
  // 注解写进源码只是"声明"; 这里问 MCP 自己要 tools/list, 证明它真的到得了客户端。
  {
    console.log("\n[5] 工具注解");
    const proc = startBridge([]);
    await waitPort(PORT);
    const mcp = makeMcpClient(proc);
    await mcp.init();
    const j = await mcp.send("tools/list", {});
    const tools = (j.result && j.result.tools) || [];
    ok(tools.length >= 20, "tools/list 返回工具清单(" + tools.length + " 个)");
    const noAnn = tools.filter((t) => !t.annotations || typeof t.annotations.readOnlyHint !== "boolean");
    ok(noAnn.length === 0, "每个工具带 readOnlyHint 布尔注解" + (noAnn.length ? ": " + noAnn.map((t) => t.name).join(",") : ""));
    const byName = Object.fromEntries(tools.map((t) => [t.name, t.annotations || {}]));
    ok(byName.net_list && byName.net_list.readOnlyHint === true, "net_list 协议层标只读");
    ok(byName.page_click && byName.page_click.readOnlyHint === false && byName.page_click.destructiveHint === true,
      "page_click 协议层标破坏性");
    ok(byName.page_screenshot && byName.page_screenshot.readOnlyHint === true, "page_screenshot 标只读(已复核例外)");
    const withOutput = tools.filter((t) => t.outputSchema);
    ok(["net_list", "bridge_status", "correlate", "net_hosts", "net_get", "chain_replay", "tab_list"].every((n) => withOutput.some((t) => t.name === n)),
      "七个机读工具都带 outputSchema(" + withOutput.map((t) => t.name).join(",") + ")");
    const bad = tools.filter((t) => t.annotations && t.annotations.readOnlyHint === true && t.annotations.destructiveHint === true);
    ok(bad.length === 0, "没有工具同时标只读+破坏性" + (bad.length ? ": " + bad.map((t) => t.name).join(",") : ""));
    proc.kill();
    await sleep(200);
  }

  // ============ 8. 控制类工具全覆盖(工具→协议→扩展 三段打通 + 参数透传) ============
  // 这 13 个工具此前"零测试提及"(只有 check_bridge_annotations 的静态标注断言)。
  // 这里逐个真调 MCP 工具, 断言: ①不报错 ②结果里能看到我们传的参数(参数没被工具层吞掉)。
  {
    console.log("\n[8] 控制类工具全覆盖");
    const proc = startBridge(["--allow-control"]);
    await waitPort(PORT);
    const { ws } = await connectRetry(TOKEN);
    serveExt(ws, (m, params) => {
      if (m === "rec.status") return { recState: "idle", count: 0 };
      if (m === "console.read") return { ok: true, total: 1, entries: [{ level: "error", text: "boom" }] };
      if (m === "console.clear") return { ok: true, cleared: 1 };
      if (m === "rec.start") return { ok: true, recState: "recording", tabId: params.tabId || 1 };
      if (m === "rec.stop") return { ok: true, recState: "idle" };
      if (m === "tab.navigate") return { ok: true, url: params.url };
      if (m === "tab.activate") return { ok: true, tabId: params.tabId || 1 };
      if (m === "tab.close") return { ok: true, closed: params.tabId || 1 };
      if (m === "page.snapshot") return { ok: true, text: 'e1 button "登录"', refs: 1 };
      if (m === "page.type") return { ok: true, typed: params.text, submit: !!params.submit, keyByKey: !!params.keyByKey };
      if (m === "page.press") return { ok: true, key: params.key };
      if (m === "page.hover") return { ok: true, ref: params.ref };
      if (m === "page.select") return { ok: true, ref: params.ref, value: params.value };
      if (m === "page.scroll") return { ok: true, ref: params.ref || null, deltaY: params.deltaY || 0 };
      if (m === "page.wait") return { ok: true, condition: params.selector || params.text || params.ms || "" };
      if (m === "page.screenshot") return { ok: true, dataUrl: "data:image/png;base64,AAAA" };
      if (m === "page.eval") return { ok: true, value: "v" + params.script };
      return { __err: "unknown " + m };
    });
    const mcp = makeMcpClient(proc);
    await mcp.init();
    const call = (name, args) => mcp.callTool(name, args || {});
    const J = async (name, args) => {
      const r = await call(name, args);
      if (r.isError) return { __err: r.content[0].text };
      try { return JSON.parse(r.content[0].text); } catch { return r.content[0].text; }
    };

    const recS = await J("rec_start", { tabId: 42 });
    ok(recS && recS.tabId === 42, "rec_start 透传 tabId");
    ok((await J("rec_stop", {})).recState === "idle", "rec_stop 回到 idle");
    const nav = await J("tab_navigate", { url: "https://a.com/x" });
    ok(nav && nav.url === "https://a.com/x", "tab_navigate 透传 url");
    ok((await J("tab_activate", { tabId: 7 })).tabId === 7, "tab_activate 透传 tabId");
    ok((await J("tab_close", { tabId: 7 })).closed === 7, "tab_close 透传 tabId");
    const snap = await J("page_snapshot", { maxChars: 5000 });
    ok(snap && snap.refs === 1 && /button/.test(String(snap.text)), "page_snapshot 返回 refs 结构");
    const typed = await J("page_type", { ref: "e1", text: "alice", submit: true, keyByKey: true });
    ok(typed && typed.typed === "alice" && typed.submit === true && typed.keyByKey === true, "page_type 透传 text/submit/keyByKey");
    ok((await J("page_press", { key: "Enter" })).key === "Enter", "page_press 透传 key");
    ok((await J("page_hover", { ref: "e2" })).ref === "e2", "page_hover 透传 ref");
    const sel = await J("page_select", { ref: "e3", value: "B" });
    ok(sel && sel.ref === "e3" && sel.value === "B", "page_select 透传 ref/value");
    ok((await J("page_scroll", { deltaY: -300 })).deltaY === -300, "page_scroll 透传 deltaY");
    ok((await J("page_wait", { selector: "#done" })).condition === "#done", "page_wait 透传 selector");
    // page_screenshot 返回 image content(不走 JSON), 单独断言 content 类型
    const shot = await call("page_screenshot", {});
    ok(shot && shot.content && shot.content[0] && shot.content[0].type === "image", "page_screenshot 返回 image content");
    ok((await J("page_eval", { script: "document.title" })).value === "vdocument.title", "page_eval 透传 script");
    const crd = await J("console_read", { level: "error" });
    ok(crd && crd.total === 1 && crd.entries[0].level === "error", "console_read 透传 level 且返回条目");
    ok((await J("console_clear", {})).cleared === 1, "console_clear 清空并回执");

    ws.close();
    proc.kill();
    await sleep(200);
  }

  // ============ 5b. 导出产物体积守卫 ============
  // 脚本类产物截断即废文件(HAR 半截不是 HAR, JMX 半截打不开) —— 超限必须明确失败并给下一步,
  // 而不是"看起来成功"。这里用 maxChars=1000 触发, 断言码/文案/建议三件事。
  {
    console.log("\n[5b] 导出体积守卫");
    const proc = startBridge(["--allow-control"]);
    await waitPort(PORT);
    const { ws } = await connectRetry(TOKEN);
    serveExt(ws, (m) => {
      if (m === "net.list") {
        return Array.from({ length: 40 }, (_, i) => ({
          id: "b" + i, method: "POST", url: "https://a.com/api/item/" + i, path: "/api/item/" + i,
          query: "page=" + i, headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ a: i, b: "x".repeat(80) }), status: 200,
          response: JSON.stringify({ ok: true, data: "y".repeat(120) }), mime: "application/json", ts: "", durationMs: 10,
        }));
      }
      return { __err: "unknown " + m };
    });
    const mcp = makeMcpClient(proc);
    await mcp.init();

    const r = await mcp.callTool("export_jmx", { maxChars: 1000 });
    const t = (r.content && r.content[0] && r.content[0].text) || "";
    ok(r.isError === true, "超限 → isError(不返回半截脚本)");
    ok(/^错误\[bad_state\]: /.test(t), "超限 → 机读码 bad_state", t.slice(0, 60));
    ok(/export_jmx 产物过大/.test(t) && /超过上限 1000/.test(t), "文案点名工具与上限", t.slice(0, 120));
    ok(/下一步: /.test(t) && /maxChars=/.test(t), "下一步给出可执行方法(调高 maxChars)", t.slice(-160));
    ok(/hostIncludes|pathIncludes|statusMin/.test(t), "下一步给出缩小范围的具体参数", t.slice(-160));

    const rNoLimit = await mcp.callTool("export_python", {});
    ok(rNoLimit.isError !== true, "默认上限下 40 条正常导出", rNoLimit.isError);

    ws.close();
    proc.kill();
    await sleep(200);
  }

  // ============ 6. 错误语义(协议层可见) ============
  // 断言客户端实际收到的错误文本: 机读码 + 下一步。这条比读源码更硬 —— 它验证 errors.js
  // 的表、tools.js 的 fail/fromException、MCP 结果封装三段串起来没断。
  {
    console.log("\n[6] 错误语义");
    const proc = startBridge([]);   // 故意不开 --allow-control
await waitPort(PORT);
    // 假扩展: net.list → 空集, net.get → null(模拟条目已被挤出缓冲)。
    // 注意不能靠"缺必填参数"验 bad_args —— MCP SDK 会先按 inputSchema 拒掉, 到不了工具层。
    const { ws } = await connectRetry(TOKEN);
    serveExt(ws, (m) => {
      if (m === "net.list") return [];
      if (m === "net.get") return null;
      return { __err: "unknown " + m };
    });
    const mcp = makeMcpClient(proc);
    await mcp.init();

    const r1 = await mcp.callTool("net_get", { id: "gone" });
    const t1 = (r1.content && r1.content[0] && r1.content[0].text) || "";
    ok(r1.isError === true, "条目不存在 → isError");
    ok(/^错误\[bad_args\]: /.test(t1), "条目不存在 → 机读码 bad_args");
    ok(/\n下一步: /.test(t1), "条目不存在 → 带下一步");

    const rEmpty = await mcp.callTool("export_har", {});
    const tEmpty = (rEmpty.content && rEmpty.content[0] && rEmpty.content[0].text) || "";
    ok(/^错误\[no_entries\]: /.test(tEmpty), "空抓包 → 机读码 no_entries");
    ok(/\n下一步: /.test(tEmpty), "no_entries → 带下一步");

    const r2 = await mcp.callTool("page_click", { ref: "e1" });
    const t2 = (r2.content && r2.content[0] && r2.content[0].text) || "";
    ok(r2.isError === true, "控制类未开 → isError");
    ok(/^错误\[forbidden\]: /.test(t2), "控制类未开 → 机读码 forbidden");
    ok(/--allow-control/.test(t2), "forbidden 给出开启方式");

    ws.close();
    proc.kill();
    await sleep(200);
  }

  // ============ 7. 控制开关不一致(daemon 未开 / MCP 开了) ============
  // 真实故障面: 用户按 README 起了 daemon(--daemon 不加 --allow-control), 又给 MCP 进程加了
  // --allow-control。本地闸门放行, 真正的闸门在 daemon —— 断言: bridge_status 标出 mismatch,
  // 控制类错误文案指名 daemon。
  // 稳定性: 端口随机(固定端口会撞上一次没退干净的 daemon), 就绪靠轮询握手而不是固定 sleep。
  {
    console.log("\n[7] 控制开关不一致");
    const DPORT = 9500 + Math.floor(Math.random() * 400);
    const daemonUrl = `ws://127.0.0.1:${DPORT}${protocol.WS_PATH}`;
    const daemon = spawn(process.execPath, [ENTRY, "--daemon", "--port", String(DPORT), "--quiet"], {
      env: { ...process.env, WEB_TOOLBOX_TOKEN: TOKEN }, stdio: ["ignore", "ignore", "ignore"], windowsHide: true,
    });
    let up = false;
    for (let i = 0; i < 30 && !up; i++) {
      await sleep(200);
      try { const probe = await connect(TOKEN, PROTOCOL_VERSION, daemonUrl); probe.ws.close(); up = true; } catch { /* 还没起 */ }
    }
    if (!up) {
      ok(false, "独立 daemon 就绪(6s 内未监听端口 " + DPORT + ")");
      try { daemon.kill(); } catch { /* ignore */ }
    } else {
      const mcpProc = spawn(process.execPath, [ENTRY, "--port", String(DPORT), "--quiet", "--allow-control"], {
        env: { ...process.env, WEB_TOOLBOX_TOKEN: TOKEN }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
      });
      mcpProc.stderr.on("data", () => {});
      try {
        // 假扩展连到独立 daemon: bridge_status 只在"扩展在线"时才报开关字段
        const ext = await connect(TOKEN, PROTOCOL_VERSION, daemonUrl);
        serveExt(ext.ws, (m) => (m === "rec.status" ? { recState: "idle", count: 0 } : { ok: true }));
        const mcp = makeMcpClient(mcpProc);
        await mcp.init();
        const st = JSON.parse((await mcp.callTool("bridge_status", {})).content[0].text);
        ok(st.controlMismatch === true, "bridge_status 标出开关不一致", { local: st.allowControl, daemon: st.daemonAllowControl });
        ok(!!st.hint && /daemon/.test(st.hint), "不一致时给出该重启谁", st.hint);
        const r = await mcp.callTool("page_click", { ref: "e1" });
        ok(r.isError === true && /daemon/.test(r.content[0].text) && /forbidden/.test(r.content[0].text),
          "控制类被 daemon 拒绝且文案指名 daemon", r.content[0].text);
        ext.ws.close();
      } finally {
        mcpProc.kill();
        daemon.kill();
        await sleep(300);
      }
    }
  }
  console.log(`\n=== smoke: ${pass} PASS / ${fail} FAIL ===`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("smoke 异常:", e); process.exit(1); });
