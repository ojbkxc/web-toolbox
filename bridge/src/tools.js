// tools.js —— MCP 工具定义: 纯转发层, 不含业务逻辑。
//
// 铁律: 这里的每个工具都只做三件事 —— 校验参数、调 hub.request、把结果整理成 MCP 内容。
// 业务判定(什么算静态资源、怎么清洗、怎么关联、怎么生成 JMX)一律留在扩展里,
// 复用已经被 40 项走查覆盖过的 correlate.js / jmx.js / pyscript.js。
//
// 这样做的理由: bridge 可替换(将来换传输/换语言), 而业务逻辑只有一份。

import { z } from "zod";
import protocol from "../../bridge-protocol.js";
import * as exporters from "./exporters.js";
import { ERROR_HINTS, LOCAL, toolFail, fromException } from "./errors.js";
import fsx from "node:fs";

// 两端版本常量: 供 bridge_status 并列返回(版本错位是"连上了但方法不认"的最高频根因,
// errors.js 的 UNKNOWN_METHOD/PROTOCOL_MISMATCH hint 直接指向这两个字段)。
const PROTOCOL_VERSION = protocol.PROTOCOL_VERSION;
const BRIDGE_VERSION = (() => {
  try {
    const pkg = JSON.parse(fsx.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return pkg.version || "unknown";
  } catch { return "unknown"; }
})();

const { isControlMethod } = protocol;

// ---- 结果整形 helper ----
function text(s) {
  return { content: [{ type: "text", text: typeof s === "string" ? s : JSON.stringify(s, null, 2) }] };
}
// 错误一律走 errors.js: 码 + 文案 + 下一步(AI 客户端据此决定补参数/重试/去启动 daemon)。
function fail(code, msg, hint) {
  return toolFail(code, msg, hint);
}

// 导出产物体积守卫: 3000 条满量时 JMX≈6.7MB / HAR≈5.3MB(实测 500 条 1139KB/912KB 线性外推)。
// 脚本类产物(HAR/JMX/PY)**截断后就是废文件** —— 半截 JSON 不是 HAR, 半截 JMX 打不开,
// 所以这里宁可明确失败并给出路, 也不返回"看起来成功"的破产物(与 errors.js 的失败口径一致)。
const EXPORT_MAX_CHARS = 2_000_000;   // 默认 2M 字符(UTF-8 约 2-4MB), 覆盖真实客户端的响应上限
const EXPORT_MAX_CHARS_CAP = 20_000_000;

function exportLimitFrom(args) {
  const n = Number(args && args.maxChars);
  if (!n || !Number.isFinite(n)) return EXPORT_MAX_CHARS;
  return Math.min(Math.max(n, 1000), EXPORT_MAX_CHARS_CAP);
}

// 超限时给"可执行的下一步": 指出当前规模 + 三条缩小路 + 调高上限的方法。
function guardExportSize(text, toolName, filtered, limit) {
  const size = text.length;
  if (size <= limit) return null;
  const hosts = [...new Set(filtered.map((e) => {
    try { return new URL(e.url).hostname; } catch { return ""; }
  }).filter(Boolean))].slice(0, 5);
  const hints = [];
  if (hosts.length > 1) hints.push(`按域名分开导(hostIncludes): ${hosts.join(" / ")}`);
  const prefixes = [...new Set(filtered.map((e) => String(e.path || "").split("/").slice(0, 3).join("/")))].filter(Boolean).slice(0, 3);
  if (prefixes.length > 1) hints.push(`按路径前缀收紧(pathIncludes): ${prefixes.join(" / ")}`);
  hints.push("用 method / statusMin 只导关键接口(如只看失败: statusMin=400)");
  hints.push(`确实要全量就调大上限: maxChars=${Math.min(Math.ceil(size * 1.1), EXPORT_MAX_CHARS_CAP)}`);
  return fail(
    LOCAL.BAD_STATE,
    `${toolName} 产物过大: 当前 ${filtered.length} 条会生成 ${size} 字符(约 ${(size / 1024 / 1024).toFixed(1)}MB), 超过上限 ${limit}。`
      + "脚本类产物截断后无法使用, 所以不返回半截结果。",
    hints.join("; "),
  );
}
// 带结构化返回: content 仍给人类可读 JSON, structuredContent 给客户端直接取字段
// (SDK 会拿 outputSchema 校验它; 字段多一个少一个都会被拒, 所以 shape 与返回值必须同源)。
function structured(obj) {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }], structuredContent: obj };
}

// 字节口径: reqBytes/respBytes 是 **UTF-8 字节数**, 不是 JS 字符串长度(UTF-16 码元)。
// 中文/emoji 每字符 3-4 字节, 用 .length 会低报 2-3 倍 —— 客户端按这个数算上下文预算会漏。
// TextEncoder 在 Node 与浏览器两界都有; 退化到 Buffer 只为极端老环境兜底。
const utf8Bytes = (s) => (typeof TextEncoder !== "undefined"
  ? new TextEncoder().encode(s).length
  : Buffer.byteLength(s, "utf8"));

// 条目瘦身: 列表场景不返回 response(可能 200KB), 只给摘要; 需要正文走 net_get。
function slim(e) {
  return {
    id: e.id, ts: e.ts, method: e.method, url: e.url, path: e.path,
    status: e.status, durationMs: e.durationMs || 0, mime: e.mime || "",
    reqBytes: e.body ? utf8Bytes(String(e.body)) : 0,
    respBytes: e.response ? utf8Bytes(String(e.response)) : 0,
  };
}

// 简单过滤: 方法 / 状态码 / 路径包含 / 域名包含。与扩展侧"过滤只影响显示"的语义一致。
// 入口先做数组守卫: 扩展返回非数组(老版本/异常)时应给出空集而不是让 .slice 抛错。
function applyFilter(entries, f = {}) {
  let out = Array.isArray(entries) ? entries : [];
  if (f.method) {
    const m = String(f.method).toUpperCase();
    out = out.filter((e) => String(e.method || "").toUpperCase() === m);
  }
  if (typeof f.status === "number") out = out.filter((e) => e.status === f.status);
  if (typeof f.statusMin === "number") out = out.filter((e) => (e.status || 0) >= f.statusMin);
  if (typeof f.statusMax === "number") out = out.filter((e) => (e.status || 0) <= f.statusMax);
  if (f.pathIncludes) out = out.filter((e) => String(e.path || e.url || "").includes(f.pathIncludes));
  if (f.hostIncludes) out = out.filter((e) => String(e.url || "").includes(f.hostIncludes));
  return out;
}

const filterShape = {
  method: z.string().optional().describe("HTTP 方法过滤, 如 POST"),
  status: z.number().optional().describe("精确状态码, 如 500"),
  statusMin: z.number().optional().describe("状态码下界, 如 400 只看失败"),
  statusMax: z.number().optional().describe("状态码上界"),
  pathIncludes: z.string().optional().describe("路径子串, 如 /order"),
  hostIncludes: z.string().optional().describe("URL 子串, 如 api.example.com"),
};

/**
 * 注册全部工具。
 * @param {import("@modelcontextprotocol/sdk/server/mcp.js").McpServer} server
 * @param {import("./hub.js").Hub} hub
 * @param {{archive: import("./archive.js").Archive, allowControl: boolean}} ctx
 */
// ================= 工具注解(单一真相) =================
// MCP 的 annotations 是**协议层**的副作用声明: 客户端据此决定"只读工具免确认、破坏性工具
// 必须二次确认", 不必靠读 description 猜。此前 27 个工具全裸奔 —— 打开 --allow-control 后
// 客户端把「读控制台」和「点提交按钮」一样对待。
//
// 三条纪律(由 test/check_bridge_annotations.js 钉住):
//  1. 表里必须覆盖每个注册的工具(漏一个 = 客户端无法判断, 直接红);
//  2. readOnlyHint=true 只能给"不改变环境"的工具 —— 走控制方法白名单的读工具
//     (page.snapshot / page.screenshot / page.wait)是**已复核的例外**, 它们读 DOM/画面
//     但需要 debugger attach, 所以仍在 --allow-control 之后;
//  3. destructiveHint=true 的工具必须同时 readOnlyHint=false(语义自洽)。
const ANNOTATIONS = {
  // —— 只读: 抓包/导出/关联/状态 ——
  bridge_status: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  net_list: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  net_get: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  net_hosts: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  export_har: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  export_jmx: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  export_python: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  correlate: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  console_read: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  tab_list: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  // —— 录制控制: 改浏览器状态但不动页面内容 ——
  rec_start: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  rec_stop: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  // —— 页面读: 不改环境, 但要 debugger attach(控制闸门另算) ——
  page_snapshot: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  page_screenshot: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  page_wait: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  // —— 页面写: 会改页面/提交表单, 客户端应二次确认 ——
  page_click: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  page_type: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  page_press: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  page_hover: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  page_select: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  page_scroll: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  page_eval: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  // —— 标签页 ——
  tab_navigate: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  tab_activate: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  tab_close: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  // —— 回归/清理: 重放会真的打后端(有副作用), 清空控制台丢缓冲 ——
  chain_replay: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  console_clear: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
};

// 注册包装: 注解从表里取, 漏声明即抛 —— 不给"忘了写注解"留静默通道。
// server 来自 registerTools 的参数, 模块作用域拿不到 → 工厂注入。
function makeRegister(server) {
  return function register(name, def, handler) {
    const annotations = ANNOTATIONS[name];
    if (!annotations) throw new Error(`工具 ${name} 缺少 annotations 声明`);
    // structuredContent 自校验: SDK 也会校验 outputSchema, 但它失败时抛的是协议层错误,
    // 客户端只看到一句难读的 message。这里先自己验一遍, 把"哪个工具哪个字段不符"翻成
    // 我们的 `错误[bad_payload]` + 下一步, 顺带在开发期就暴露"schema 与返回值漂移"。
    const wrapped = def.outputSchema
      ? async (...args) => {
        const r = await handler(...args);
        if (r && r.isError !== true && r.structuredContent) {
          const parsed = z.object(def.outputSchema).safeParse(r.structuredContent);
          if (!parsed.success) {
            const detail = parsed.error.issues
              .map((it) => (it.path.length ? it.path.join(".") : "<root>") + ": " + it.message)
              .join("; ");
            return toolFail(LOCAL.BAD_PAYLOAD, `工具 ${name} 的 structuredContent 与 outputSchema 不符: ${detail}`,
              "这是 bridge 自身的字段漂移, 把工具名与这条详情反馈即可");
          }
        }
        return r;
      }
      : handler;
    return server.registerTool(name, { ...def, annotations }, wrapped);
  };
}

// 导出给单测用(伪造 server 验证 self-check 行为); 业务代码只用 registerTools。
export { makeRegister };

export function registerTools(server, hub, ctx) {
  const register = makeRegister(server);

  // 控制类工具统一走这个守卫: 未启用则返回明确的错误而不是静默失败
  const controlGuard = (name) => {
    if (!ctx.allowControl) {
      throw Object.assign(
        new Error(`控制类工具 ${name} 未启用: 启动 bridge 时加 --allow-control`),
        { code: protocol.ERR.FORBIDDEN },
      );
    }
    // 本地开了但 daemon 没开: 真正的闸门在 daemon, 直接指出来, 免得用户以为工具坏了。
    if (hub.daemonAllowControl === false && typeof hub.daemonAllowControl === "boolean") {
      throw Object.assign(
        new Error(`控制类工具 ${name} 被 daemon 拒绝: daemon 启动时没加 --allow-control`),
        { code: protocol.ERR.FORBIDDEN },
      );
    }
    if (!isControlMethod(name)) {
      throw Object.assign(new Error(`内部错误: ${name} 不在控制方法白名单`), { code: protocol.ERR.UNKNOWN_METHOD });
    }
  };

  // 统一收口: 把 hub 层的异常转成 MCP 错误内容, 不向外抛(避免 client 端看到裸异常)
  const run = async (fn) => {
    try {
      return await fn();
    } catch (e) {
      return fromException(e);
    }
  };

  // ================= 会话状态 =================

  register("bridge_status", {
    title: "桥接状态",
    description: "检查 Chrome 扩展是否已连接到 bridge, 返回扩展版本、录制状态与能力开关。任何操作前先调这个。",
    inputSchema: {},
    outputSchema: {
      connected: z.boolean(),
      bridge: z.record(z.string(), z.any()).optional(),
      archive: z.record(z.string(), z.any()).optional(),
      extension: z.record(z.string(), z.any()).optional(),
      allowControl: z.boolean().optional(),
      daemonAllowControl: z.boolean().nullable().optional(),
      controlMismatch: z.boolean().optional(),
      recording: z.any().optional(),
      hint: z.string().optional(),
    },
  }, async () => run(async () => {
    if (!hub.connected) {
      return structured({ connected: false, hint: ERROR_HINTS.not_connected.hint });
    }
    const st = await hub.request("rec.status").catch((e) => ({ error: e.message }));
    const daemonAllow = hub.daemonAllowControl;   // 单进程模式为 undefined
    // 两个开关不一致时, 控制类调用会在 daemon 那侧被拒 —— 提前告诉客户端, 别让它猜。
    const mismatch = typeof daemonAllow === "boolean" && daemonAllow !== ctx.allowControl;
    return structured({
      connected: true,
      // 两端版本并列返回: 版本错位是最高频的"连上了但方法不认"根因, 不给对比入口用户只能猜
      // (errors.js 的 UNKNOWN_METHOD / PROTOCOL_MISMATCH hint 直接指向这两个字段)。
      bridge: { version: BRIDGE_VERSION, protocol: PROTOCOL_VERSION },
      // 归档现状: 开了 --archive-dir 却无从判断是否在工作(用户只能翻目录)。
      // 口径: 归档**只写不读** —— 这里只报"有没有/写了多少", 不提供查询(工具面不暴露读)。
      archive: typeof ctx.archive?.stats === "function" ? ctx.archive.stats() : undefined,
      extension: hub.extInfo || undefined,
      allowControl: ctx.allowControl,
      daemonAllowControl: typeof daemonAllow === "boolean" ? daemonAllow : null,
      controlMismatch: mismatch,
      recording: st,
      ...(mismatch ? {
        hint: daemonAllow
          ? "本地未传 --allow-control 但 daemon 已启用: 本进程仍会拒绝控制类工具, 需要时给本进程也加 --allow-control"
          : "daemon 未启用控制类工具: 用 --allow-control 重启 daemon, 否则所有控制类调用都会 forbidden",
      } : {}),
    });
  }));

  // ================= 抓包(只读) =================

  register("net_list", {
    title: "列出抓到的请求",
    description:
      "列出扩展当前抓到的请求(按请求时间序)。只返回摘要, 不含响应正文; 需要正文用 net_get。"
      + "可用 method/status/pathIncludes/hostIncludes/limit 过滤。",
    inputSchema: {
      ...filterShape,
      limit: z.number().optional().describe("最多返回条数, 默认 50, 上限 500"),
      offset: z.number().optional().describe("跳过前 N 条(分页)"),
    },
    outputSchema: {
      total: z.number(),
      filtered: z.number(),
      offset: z.number(),
      limit: z.number(),
      returned: z.number(),
      entries: z.array(z.object({
        id: z.string(),
        ts: z.any().optional(),
        method: z.string().optional(),
        url: z.string().optional(),
        path: z.string().optional(),
        status: z.number().optional(),
        durationMs: z.number().optional(),
        mime: z.string().optional(),
        reqBytes: z.number().optional(),
        respBytes: z.number().optional(),
      })),
    },
  }, async (args) => run(async () => {
    const raw = await hub.request("net.list");
    // 扩展只可能返回数组。非数组说明协议对端异常 —— 明确报错, 不静默返回空集
    // (静默会让 AI 误以为"没抓到包", 而真实原因是扩展侧出错)。
    if (!Array.isArray(raw)) throw Object.assign(new Error("扩展返回的 net.list 不是条目数组, 请检查扩展版本"), { code: LOCAL.BAD_PAYLOAD });
    const all = raw;
    const filtered = applyFilter(all, args || {});
    const limit = Math.min(Math.max(Number(args?.limit) || 50, 1), 500);
    const offset = Math.max(Number(args?.offset) || 0, 0);
    const page = filtered.slice(offset, offset + limit);
    return structured({
      total: all.length, filtered: filtered.length,
      offset, limit, returned: page.length,
      entries: page.map(slim),
    });
  }));

  register("net_get", {
    title: "获取请求详情",
    description: "按 id 获取一条请求的完整内容(请求头、请求体、响应头、响应正文)。正文超长会截断并标注。"
      + "注意单位: maxBody 按**字符**截断(中文 1 字符=1); 而 net_list 的 reqBytes/respBytes 是 **UTF-8 字节数**,"
      + "中文 1 字符=3 字节, 两个数不要直接比大小。",
    inputSchema: {
      id: z.string().describe("net_list 返回的条目 id"),
      maxBody: z.number().optional().describe("响应正文最多返回字符数(不是字节), 默认 20000"),
    },
    // 机读输出: 客户端以前只能靠正则在文本尾巴里找"已截断", 现在直接看 truncated/originalChars。
    // 字段只声明常用面(headers 按表保留原样); 未声明的扩展字段仍留在 content 文本里, 不丢信息。
    outputSchema: {
      id: z.string(),
      method: z.string().optional(),
      url: z.string().optional(),
      path: z.string().optional(),
      query: z.string().optional(),
      status: z.number().optional(),
      mime: z.string().optional(),
      headers: z.record(z.string(), z.any()).optional(),
      body: z.string().optional(),
      response: z.string().optional(),
      truncated: z.boolean(),
      originalChars: z.number(),
      maxBody: z.number(),
    },
  }, async (args) => run(async () => {
    if (!args || !args.id) return fail(LOCAL.BAD_ARGS, "缺少 id");
    const e = await hub.request("net.get", { id: args.id });
    if (!e) return fail(LOCAL.BAD_ARGS, `找不到条目 ${args.id}(可能已被新抓包挤出缓冲)`);
    const maxBody = Math.max(Number(args.maxBody) || 20000, 100);
    const resp = String(e.response || "");
    const truncated = resp.length > maxBody;
    return structured({
      ...e,
      response: truncated
        ? resp.slice(0, maxBody) + `\n…(已截断, 原文 ${resp.length} 字符; 调大 maxBody 可看更多)`
        : resp,
      truncated,
      originalChars: resp.length,
      maxBody,
    });
  }));

  register("net_hosts", {
    title: "抓包域名分布",
    description: "统计当前抓包覆盖的域名与条数, 用于判断录制配置是否漏了网关域(常见漏录原因)。",
    inputSchema: {},
    outputSchema: {
      total: z.number().describe("各域名条数之和"),
      hosts: z.array(z.object({ host: z.string(), count: z.number() })),
    },
  }, async () => run(async () => {
    const r = await hub.request("net.hosts");
    if (!Array.isArray(r)) {
      throw Object.assign(new Error("扩展返回的 net.hosts 不是数组"), { code: LOCAL.BAD_PAYLOAD });
    }
    // content 保持原数组形态(兼容既有调用方), structuredContent 才是机读对象:
    // MCP 的 outputSchema 根必须是对象, 数组塞不进 structuredContent。
    return {
      content: [{ type: "text", text: JSON.stringify(r, null, 2) }],
      structuredContent: { total: r.reduce((n, x) => n + (Number(x && x.count) || 0), 0), hosts: r },
    };
  }));

  // ================= 导出(复用扩展里已验证的导出器) =================

  register("export_har", {
    title: "导出 HAR",
    description: "把当前抓包导出为 HAR 1.2(浏览器/Postman/DevTools 通用)。返回 JSON 文本。"
      + "产物过大时会明确报错并给出缩小范围/调高上限的办法(不返回半截 HAR)。",
    inputSchema: { ...filterShape, maxChars: z.number().optional().describe("产物字符上限, 默认 2000000; 超限报错而非截断") },
  }, async (args) => run(async () => {
    const all = await hub.request("net.list");
    const filtered = applyFilter(all, args || {});
    if (!filtered.length) return fail(LOCAL.NO_ENTRIES, "过滤后没有条目");
    const out = exporters.buildHarText(filtered);
    return guardExportSize(out, "export_har", filtered, exportLimitFrom(args)) || text(out);
  }));

  register("export_jmx", {
    title: "导出 JMeter 脚本",
    description:
      "把当前抓包导出为 JMeter .jmx 脚本(自动挂断言/登录前置/动态值关联, 与扩展侧导出同源)。"
      + "返回脚本文本。大流量请先过滤。",
    inputSchema: {
      ...filterShape,
      threads: z.number().optional().describe("线程数, 默认 1(巡检安全口径)"),
      maxChars: z.number().optional().describe("产物字符上限, 默认 2000000; 超限报错而非截断"),
    },
  }, async (args) => run(async () => {
    const all = await hub.request("net.list");
    const filtered = applyFilter(all, args || {});
    if (!filtered.length) return fail(LOCAL.NO_ENTRIES, "过滤后没有条目");
    const out = exporters.buildJmxText(filtered, { threads: args?.threads });
    return guardExportSize(out, "export_jmx", filtered, exportLimitFrom(args)) || text(out);
  }));

  register("export_python", {
    title: "导出 Python 重放脚本",
    description: "把当前抓包导出为 requests 重放脚本(含参数链内联)。产物过大时明确报错(不返回半截脚本)。",
    inputSchema: { ...filterShape, maxChars: z.number().optional().describe("产物字符上限, 默认 2000000; 超限报错而非截断") },
  }, async (args) => run(async () => {
    const all = await hub.request("net.list");
    const filtered = applyFilter(all, args || {});
    if (!filtered.length) return fail(LOCAL.NO_ENTRIES, "过滤后没有条目");
    const out = exporters.buildPyText(filtered);
    return guardExportSize(out, "export_python", filtered, exportLimitFrom(args)) || text(out);
  }));

  register("correlate", {
    title: "自动关联动态值",
    description:
      "对当前抓包做参数关联分析(同一接口多次录制的动态值 diff), 返回可参数化的字段列表。"
      + "同一接口至少录两遍才有结果。",
    inputSchema: {
      pathIncludes: z.string().optional().describe("只看路径包含这段的接口, 如 /order"),
    },
    outputSchema: {
      summary: z.number(),
      groups: z.array(z.object({
        method: z.string().optional(),
        path: z.string().optional(),
        count: z.number().optional(),
        dynamics: z.array(z.object({
          path: z.string(),
          values: z.array(z.any()).optional(),
          var: z.string().optional(),
          replace: z.string().nullable().optional(),
          classify: z.any().optional(),
        })).optional(),
      })),
    },
  }, async (args) => run(async () => {
    const all = await hub.request("net.list");
    const filtered = applyFilter(all, args || {});
    if (!filtered.length) return fail(LOCAL.NO_ENTRIES, "过滤后没有条目");
    return structured(exporters.correlateText(filtered));
  }));

  // ================= 录制控制 =================

  register("rec_start", {
    title: "开始录制",
    description:
      "在指定标签页开始抓包(需要管理权限: --allow-control)。不传 tabId 则用当前活动标签页。"
      + "会显示 Chrome 的「正在调试此浏览器」黄条, 属正常现象。",
    inputSchema: {
      tabId: z.number().optional().describe("目标标签页 id, 省略则用活动标签页"),
    },
  }, async (args) => run(async () => {
    controlGuard("rec.start");
    const params = {};
    if (typeof args?.tabId === "number") params.tabId = args.tabId;
    return text(await hub.request("rec.start", params));
  }));

  register("rec_stop", {
    title: "停止录制",
    description: "停止抓包并 detach 调试器。数据保留。",
    inputSchema: {},
  }, async () => run(async () => {
    controlGuard("rec.stop");
    return text(await hub.request("rec.stop"));
  }));

  // ================= 浏览器控制(需 --allow-control) =================

  register("tab_list", {
    title: "列出标签页",
    description:
      "列出当前 Chrome 的标签页(id/标题/URL/是否活动)。"
      + "⚠ url 可能缺失: 浏览器只把 url 给已授权站点(域名授权或 activeTab 生效)的标签页,"
      + " 其余标签页只能给 id/标题 —— 拿到空 url 不代表读取失败, 需要目标页 url 时先用 net_hosts"
      + " 或 page_snapshot(它会先解析当前活动页)。",
    inputSchema: {},
    outputSchema: {
      total: z.number(),
      tabs: z.array(z.object({
        id: z.any().optional(),
        title: z.string().optional(),
        url: z.string().optional(),
        active: z.boolean().optional(),
      })),
    },
  }, async () => run(async () => {
    const r = await hub.request("tab.list");
    if (!Array.isArray(r)) {
      throw Object.assign(new Error("扩展返回的 tab.list 不是数组"), { code: LOCAL.BAD_PAYLOAD });
    }
    // 与 net_hosts 同款处理: 数组塞不进 structuredContent 根, 用 {total, tabs} 包裹; content 保原数组
    return {
      content: [{ type: "text", text: JSON.stringify(r, null, 2) }],
      structuredContent: { total: r.length, tabs: r },
    };
  }));

  register("tab_navigate", {
    title: "打开网址",
    description: "让指定标签页(省略则活动页)导航到 url, 并等待加载完成。",
    inputSchema: {
      url: z.string().describe("完整 URL"),
      tabId: z.number().optional().describe("目标标签页 id, 省略用活动标签页"),
    },
  }, async (args) => run(async () => {
    controlGuard("tab.navigate");
    if (!args?.url) return fail(LOCAL.BAD_ARGS, "缺少 url");
    return text(await hub.request("tab.navigate", { url: args.url, tabId: args.tabId }));
  }));

  register("page_snapshot", {
    title: "读取页面结构",
    description:
      "返回当前页面的可访问性快照, 每个可交互元素带 ref 编号。"
      + "后续 click/type 用 ref 定位(比坐标可靠)。快照比完整 HTML 小得多。"
      + "禁用的元素带 [disabled] 标记 —— 点了不会有反应, 别盲点。",
    inputSchema: {
      tabId: z.number().optional().describe("目标标签页 id, 省略用活动标签页"),
      maxChars: z.number().optional().describe("快照最多返回字符数, 默认 20000"),
    },
  }, async (args) => run(async () => {
    controlGuard("page.snapshot");
    return text(await hub.request("page.snapshot", {
      tabId: args?.tabId,
      maxChars: Math.max(Number(args?.maxChars) || 20000, 1000),
    }));
  }));

  register("page_click", {
    title: "点击元素",
    description:
      "按 page_snapshot 返回的 ref 点击元素(真实鼠标事件, 非合成 click)。"
      + "若目标被遮罩/弹窗压住, 返回值会带 covered=true 与 coveredBy(压在它上面的元素)——"
      + "此时鼠标事件被遮罩吃掉, 需先关掉遮罩再点。",
    inputSchema: {
      ref: z.string().describe("page_snapshot 里的 ref, 如 e12"),
      tabId: z.number().optional().describe("目标标签页 id, 省略用活动标签页"),
    },
  }, async (args) => run(async () => {
    controlGuard("page.click");
    if (!args?.ref) return fail(LOCAL.BAD_ARGS, "缺少 ref");
    return text(await hub.request("page.click", { ref: args.ref, tabId: args.tabId }));
  }));

  register("page_type", {
    title: "输入文本",
    description:
      "按 ref 定位输入框, 先聚焦清空再写入。默认用 insertText 整串写入(触发真实的 input 事件, "
      + "对 React 受控组件有效, 一次写完最省事)。若目标监听 keydown(自动完成下拉、输入掩码、"
      + "快捷键、富文本编辑器), 整串写入收不到按键事件、联想与校验不会触发 —— 此时传 keyByKey=true "
      + "逐字符派发真实 keydown/keypress/keyup(中文等非 ASCII 字符仍以文本方式插入; 长文本会明显变慢)。",
    inputSchema: {
      ref: z.string().describe("page_snapshot 里的 ref, 如 e12"),
      text: z.string().describe("要输入的文本(非 ASCII 也按文本插入)"),
      submit: z.boolean().optional().describe("输入后是否回车提交"),
      keyByKey: z.boolean().optional().describe("逐字符派发真实按键(默认 false 走 insertText 整串写入)"),
      tabId: z.number().optional().describe("目标标签页 id, 省略用活动标签页"),
    },
  }, async (args) => run(async () => {
    controlGuard("page.type");
    if (!args?.ref || typeof args?.text !== "string") return fail(LOCAL.BAD_ARGS, "需要 ref 与 text");
    return text(await hub.request("page.type", {
      ref: args.ref, text: args.text, submit: !!args.submit,
      keyByKey: !!args.keyByKey, tabId: args.tabId,
    }));
  }));

  register("page_press", {
    title: "按键",
    description:
      "在焦点元素上按键。支持 Enter / Tab / Escape / Backspace / Delete / Space / "
      + "ArrowUp / ArrowDown / ArrowLeft / ArrowRight / Home / End / PageUp / PageDown, "
      + "以及单个字符(大写字母会自动按住 Shift)。按键带完整 code/keyCode, 与真人按键一致。",
    inputSchema: {
      key: z.string().describe("键名, 如 Enter / Tab / a"),
      tabId: z.number().optional().describe("目标标签页 id, 省略用活动标签页"),
    },
  }, async (args) => run(async () => {
    controlGuard("page.press");
    if (!args?.key) return fail(LOCAL.BAD_ARGS, "缺少 key");
    return text(await hub.request("page.press", { key: args.key, tabId: args.tabId }));
  }));

  register("page_hover", {
    title: "悬停元素",
    description: "鼠标悬停在 ref 元素上。菜单常见: 必须悬停才展开二级菜单。",
    inputSchema: {
      ref: z.string().describe("page_snapshot 里的 ref"),
      tabId: z.number().optional().describe("目标标签页 id, 省略用活动标签页"),
    },
  }, async (args) => run(async () => {
    controlGuard("page.hover");
    if (!args?.ref) return fail(LOCAL.BAD_ARGS, "缺少 ref");
    return text(await hub.request("page.hover", { ref: args.ref, tabId: args.tabId }));
  }));

  register("page_select", {
    title: "下拉框选择",
    description: "在原生 <select> 上按 value 或显示文本选择。自定义下拉请用 page_click 展开后点选项。",
    inputSchema: {
      ref: z.string().describe("page_snapshot 里的 ref"),
      value: z.string().describe("选项的 value 或显示文本"),
      tabId: z.number().optional().describe("目标标签页 id, 省略用活动标签页"),
    },
  }, async (args) => run(async () => {
    controlGuard("page.select");
    if (!args?.ref || typeof args?.value !== "string") return fail(LOCAL.BAD_ARGS, "需要 ref 与 value");
    return text(await hub.request("page.select", { ref: args.ref, value: args.value, tabId: args.tabId }));
  }));

  register("page_scroll", {
    title: "滚动页面",
    description: "滚动到指定 ref 元素, 或按像素滚动, 或滚到底部。懒加载列表需要滚动才能触发后续请求。",
    inputSchema: {
      ref: z.string().optional().describe("滚到该元素(优先于 delta)"),
      deltaY: z.number().optional().describe("向下滚动像素, 负数向上"),
      deltaX: z.number().optional().describe("横向滚动像素, 正数向右"),
      toBottom: z.boolean().optional().describe("滚到页面底部"),
      tabId: z.number().optional().describe("目标标签页 id, 省略用活动标签页"),
    },
  }, async (args) => run(async () => {
    controlGuard("page.scroll");
    return text(await hub.request("page.scroll", {
      ref: args?.ref, deltaY: args?.deltaY, deltaX: args?.deltaX,
      toBottom: args?.toBottom, tabId: args?.tabId,
    }));
  }));

  register("page_wait", {
    title: "等待条件",
    description:
      "等待元素出现/消失、文本出现、URL 包含某串, 或固定毫秒。比固定 sleep 可靠, "
      + "点击后等加载优先用这个。",
    inputSchema: {
      selector: z.string().optional().describe("CSS 选择器, 等它出现"),
      text: z.string().optional().describe("等页面出现这段文字"),
      urlIncludes: z.string().optional().describe("等 URL 包含这段"),
      untilGone: z.boolean().optional().describe("反转为'等到消失'"),
      ms: z.number().optional().describe("固定等待毫秒(无其他条件时使用)"),
      timeoutMs: z.number().optional().describe("超时, 默认 10000"),
      tabId: z.number().optional().describe("目标标签页 id, 省略用活动标签页"),
    },
  }, async (args) => run(async () => {
    controlGuard("page.wait");
    return text(await hub.request("page.wait", { ...(args || {}) }));
  }));

  register("tab_activate", {
    title: "切换标签页",
    description: "把指定标签页切到前台并聚焦窗口。截图前通常需要先激活。",
    inputSchema: {
      tabId: z.number().optional().describe("省略则用当前活动页"),
    },
  }, async (args) => run(async () => {
    controlGuard("tab.activate");
    return text(await hub.request("tab.activate", { tabId: args?.tabId }));
  }));

  register("tab_close", {
    title: "关闭标签页",
    description: "关闭指定标签页。",
    inputSchema: {
      tabId: z.number().optional().describe("要关闭的标签页 id, 省略用活动标签页"),
    },
  }, async (args) => run(async () => {
    controlGuard("tab.close");
    return text(await hub.request("tab.close", { tabId: args?.tabId }));
  }));

  register("page_screenshot", {
    title: "截图",
    description: "截取当前可视区域, 返回 base64 PNG。",
    inputSchema: {
      tabId: z.number().optional().describe("目标标签页 id, 省略用活动标签页"),
    },
  }, async (args) => run(async () => {
    controlGuard("page.screenshot");
    const r = await hub.request("page.screenshot", { tabId: args?.tabId });
    if (r && r.dataUrl) {
      const b64 = String(r.dataUrl).replace(/^data:image\/\w+;base64,/, "");
      return { content: [{ type: "image", data: b64, mimeType: "image/png" }] };
    }
    return text(r);
  }));

  register("page_eval", {
    title: "在页面执行 JS",
    description:
      "在页面上下文执行一段 JS 表达式并返回结果(MAIN world, 可访问页面自己的变量)。"
      + "返回值会自动规约成语义等价的可序列化形态: Map→对象、Set→数组、DOM 节点→'[Node tag#id]'、"
      + "函数→'[Function 名]'、循环引用→'[Circular]'; 超深/超量会截断并置 truncated=true。"
      + "仅用于读取/调试; 这个工具只能读到数据, 不要用它做破坏性操作。",
    inputSchema: {
      script: z.string().describe("JS 表达式, 如 document.title"),
      allFrames: z.boolean().optional().describe("在所有 iframe 里都执行, 返回每个 frame 的结果"),
      tabId: z.number().optional().describe("目标标签页 id, 省略用活动标签页"),
    },
  }, async (args) => run(async () => {
    controlGuard("page.eval");
    if (!args?.script) return fail(LOCAL.BAD_ARGS, "缺少 script");
    return text(await hub.request("page.eval", { script: args.script, allFrames: !!args.allFrames, tabId: args.tabId }));
  }));

  // ================= 回归能力(v1.1.1 新增) =================
  // 此前 MCP 只能抓包, 不能跑回归 —— 链路重放是扩展最核心的验证能力, 不给 AI
  // 客户端等于让它只有一只眼。以下实现全部转发扩展侧同一份 runChain, 不重写逻辑。

  register("chain_replay", {
    title: "链路重放(回归 diff)",
    description:
      "按录制顺序重放当前抓包, 每条响应与录制快照自动 diff(时间戳/长 token 归一化)。"
      + "返回每条 verdict: OK(一致) / DIFF(响应体有差异) / FAIL(状态码变化) / ERR(网络错误)。"
      + "改完代码或参数后用它一键回归整条链。需要管理权限。",
    inputSchema: {
      ...filterShape,
      ids: z.array(z.string()).optional().describe("只重放指定条目 id; 省略则重放全部(遵守过滤词)"),
      timeoutMs: z.number().optional().describe("单条超时毫秒, 默认 30000"),
      tabId: z.number().optional().describe("在哪个标签页重放, 省略用活动页"),
    },
    outputSchema: {
      total: z.number(),
      summary: z.string(),
      verdicts: z.array(z.object({ verdict: z.string(), count: z.number() })),
      failed: z.array(z.object({
        verdict: z.string().optional(),
        method: z.string().optional(),
        path: z.string().optional(),
        msg: z.string().optional(),
        recordedStatus: z.any().optional(),
        liveStatus: z.any().optional(),
      })),
      results: z.array(z.object({
        verdict: z.string(),
        method: z.string().optional(),
        path: z.string().optional(),
        recordedStatus: z.any().optional(),
        liveStatus: z.any().optional(),
      })),
    },
  }, async (args) => run(async () => {
    controlGuard("chain.replay");
    // ids 优先; 未给则按过滤词圈定, 与侧栏「导出可见集」语义一致
    let ids = args?.ids;
    if (!ids || !ids.length) {
      const all = await hub.request("net.list");
      if (!Array.isArray(all)) throw Object.assign(new Error("扩展返回的抓包不是数组"), { code: LOCAL.BAD_PAYLOAD });
      ids = applyFilter(all, args || {}).map((e) => e.id);
    }
    if (!ids.length) return fail(LOCAL.NO_ENTRIES, "没有可重放的条目");
    const results = await hub.request("chain.replay", {
      ids, tabId: args?.tabId, timeoutMs: args?.timeoutMs,
    });
    if (!Array.isArray(results)) return text(results);
    // 汇总 + 逐条: 先给结论(哪些挂了), 再看细节
    const by = results.reduce((m, r) => { m[r.verdict] = (m[r.verdict] || 0) + 1; return m; }, {});
    const bad = results.filter((r) => r.verdict !== "OK");
    const verdicts = ["OK", "DIFF", "FAIL", "ERR"].filter((k) => by[k]).map((k) => ({ verdict: k, count: by[k] }));
    return structured({
      total: results.length,
      summary: verdicts.map((v) => `${v.verdict} ${v.count}`).join(" · ") || "无结果",
      verdicts,
      failed: bad.map((r) => ({ verdict: r.verdict, method: r.method, path: r.path, msg: r.msg, recordedStatus: r.recordedStatus, liveStatus: r.liveStatus })),
      results: results.map((r) => ({ verdict: r.verdict, method: r.method, path: r.path, recordedStatus: r.recordedStatus, liveStatus: r.liveStatus })),
    });
  }));

  register("console_read", {
    title: "读取控制台日志",
    description:
      "读取录制期间页面产生的 console.* 输出与未捕获异常(环形缓冲, 最多 500 条, "
      + "worker 重启后清空)。排障时比只看网络请求更有用 —— 前端报错往往先出现在控制台。",
    inputSchema: {
      level: z.string().optional().describe("只看某个级别: error / warn / log / info / debug"),
      limit: z.number().optional().describe("最多返回条数, 默认 200, 上限 500"),
    },
  }, async (args) => run(async () => text(
    await hub.request("console.read", { level: args?.level, limit: args?.limit }),
  )));

  register("console_clear", {
    title: "清空控制台日志",
    description: "清空扩展侧的控制台日志缓冲(不影响已录制的请求数据)。",
    inputSchema: {},
  }, async () => run(async () => {
    controlGuard("console.clear");
    return text(await hub.request("console.clear"));
  }));
}
