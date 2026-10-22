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

const { isControlMethod } = protocol;

// ---- 结果整形 helper ----
function text(s) {
  return { content: [{ type: "text", text: typeof s === "string" ? s : JSON.stringify(s, null, 2) }] };
}
function fail(msg) {
  return { content: [{ type: "text", text: "错误: " + msg }], isError: true };
}

// 条目瘦身: 列表场景不返回 response(可能 200KB), 只给摘要; 需要正文走 net_get。
function slim(e) {
  return {
    id: e.id, ts: e.ts, method: e.method, url: e.url, path: e.path,
    status: e.status, durationMs: e.durationMs || 0, mime: e.mime || "",
    reqBytes: e.body ? String(e.body).length : 0,
    respBytes: e.response ? String(e.response).length : 0,
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
export function registerTools(server, hub, ctx) {
  // 控制类工具统一走这个守卫: 未启用则返回明确的错误而不是静默失败
  const controlGuard = (name) => {
    if (!ctx.allowControl) {
      throw new Error(`控制类工具 ${name} 未启用: 启动 bridge 时加 --allow-control`);
    }
    if (!isControlMethod(name)) throw new Error(`内部错误: ${name} 不在控制方法白名单`);
  };

  // 统一收口: 把 hub 层的异常转成 MCP 错误内容, 不向外抛(避免 client 端看到裸异常)
  const run = async (fn) => {
    try {
      return await fn();
    } catch (e) {
      return fail(e && e.message ? e.message : String(e));
    }
  };

  // ================= 会话状态 =================

  server.registerTool("bridge_status", {
    title: "桥接状态",
    description: "检查 Chrome 扩展是否已连接到 bridge, 返回扩展版本、录制状态与能力开关。任何操作前先调这个。",
    inputSchema: {},
  }, async () => run(async () => {
    if (!hub.connected) {
      return text({ connected: false, hint: "请在 Chrome 打开扩展配置页, 填入 bridge 地址与令牌后点击「连接」" });
    }
    const st = await hub.request("rec.status").catch((e) => ({ error: e.message }));
    return text({ connected: true, extension: hub.extInfo, allowControl: ctx.allowControl, recording: st });
  }));

  // ================= 抓包(只读) =================

  server.registerTool("net_list", {
    title: "列出抓到的请求",
    description:
      "列出扩展当前抓到的请求(按请求时间序)。只返回摘要, 不含响应正文; 需要正文用 net_get。"
      + "可用 method/status/pathIncludes/hostIncludes/limit 过滤。",
    inputSchema: {
      ...filterShape,
      limit: z.number().optional().describe("最多返回条数, 默认 50, 上限 500"),
      offset: z.number().optional().describe("跳过前 N 条(分页)"),
    },
  }, async (args) => run(async () => {
    const raw = await hub.request("net.list");
    // 扩展只可能返回数组。非数组说明协议对端异常 —— 明确报错, 不静默返回空集
    // (静默会让 AI 误以为"没抓到包", 而真实原因是扩展侧出错)。
    if (!Array.isArray(raw)) throw new Error("扩展返回的 net.list 不是条目数组, 请检查扩展版本");
    const all = raw;
    const filtered = applyFilter(all, args || {});
    const limit = Math.min(Math.max(Number(args?.limit) || 50, 1), 500);
    const offset = Math.max(Number(args?.offset) || 0, 0);
    const page = filtered.slice(offset, offset + limit);
    return text({
      total: all.length, filtered: filtered.length,
      offset, limit, returned: page.length,
      entries: page.map(slim),
    });
  }));

  server.registerTool("net_get", {
    title: "获取请求详情",
    description: "按 id 获取一条请求的完整内容(请求头、请求体、响应头、响应正文)。正文超长会截断并标注。",
    inputSchema: {
      id: z.string().describe("net_list 返回的条目 id"),
      maxBody: z.number().optional().describe("响应正文最多返回字符数, 默认 20000"),
    },
  }, async (args) => run(async () => {
    if (!args || !args.id) return fail("缺少 id");
    const e = await hub.request("net.get", { id: args.id });
    if (!e) return fail(`找不到条目 ${args.id}(可能已被新抓包挤出缓冲)`);
    const maxBody = Math.max(Number(args.maxBody) || 20000, 100);
    const resp = String(e.response || "");
    return text({
      ...e,
      response: resp.length > maxBody
        ? resp.slice(0, maxBody) + `\n…(已截断, 原文 ${resp.length} 字符; 调大 maxBody 可看更多)`
        : resp,
    });
  }));

  server.registerTool("net_hosts", {
    title: "抓包域名分布",
    description: "统计当前抓包覆盖的域名与条数, 用于判断录制配置是否漏了网关域(常见漏录原因)。",
    inputSchema: {},
  }, async () => run(async () => text(await hub.request("net.hosts"))));

  // ================= 导出(复用扩展里已验证的导出器) =================

  server.registerTool("export_har", {
    title: "导出 HAR",
    description: "把当前抓包导出为 HAR 1.2(浏览器/Postman/DevTools 通用)。返回 JSON 文本, 大流量建议先过滤。",
    inputSchema: { ...filterShape },
  }, async (args) => run(async () => {
    const all = await hub.request("net.list");
    const filtered = applyFilter(all, args || {});
    if (!filtered.length) return fail("过滤后没有条目");
    return text(exporters.buildHarText(filtered));
  }));

  server.registerTool("export_jmx", {
    title: "导出 JMeter 脚本",
    description:
      "把当前抓包导出为 JMeter .jmx 脚本(自动挂断言/登录前置/动态值关联, 与扩展侧导出同源)。"
      + "返回脚本文本。大流量请先过滤。",
    inputSchema: {
      ...filterShape,
      threads: z.number().optional().describe("线程数, 默认 1(巡检安全口径)"),
    },
  }, async (args) => run(async () => {
    const all = await hub.request("net.list");
    const filtered = applyFilter(all, args || {});
    if (!filtered.length) return fail("过滤后没有条目");
    return text(exporters.buildJmxText(filtered, { threads: args?.threads }));
  }));

  server.registerTool("export_python", {
    title: "导出 Python 重放脚本",
    description: "把当前抓包导出为 requests 重放脚本(含参数链内联)。",
    inputSchema: { ...filterShape },
  }, async (args) => run(async () => {
    const all = await hub.request("net.list");
    const filtered = applyFilter(all, args || {});
    if (!filtered.length) return fail("过滤后没有条目");
    return text(exporters.buildPyText(filtered));
  }));

  server.registerTool("correlate", {
    title: "自动关联动态值",
    description:
      "对当前抓包做参数关联分析(同一接口多次录制的动态值 diff), 返回可参数化的字段列表。"
      + "同一接口至少录两遍才有结果。",
    inputSchema: {
      pathIncludes: z.string().optional(),
    },
  }, async (args) => run(async () => {
    const all = await hub.request("net.list");
    const filtered = applyFilter(all, args || {});
    if (!filtered.length) return fail("过滤后没有条目");
    return text(exporters.correlateText(filtered));
  }));

  // ================= 录制控制 =================

  server.registerTool("rec_start", {
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

  server.registerTool("rec_stop", {
    title: "停止录制",
    description: "停止抓包并 detach 调试器。数据保留。",
    inputSchema: {},
  }, async () => run(async () => {
    controlGuard("rec.stop");
    return text(await hub.request("rec.stop"));
  }));

  // ================= 浏览器控制(需 --allow-control) =================

  server.registerTool("tab_list", {
    title: "列出标签页",
    description: "列出当前 Chrome 的标签页(id/标题/URL/是否活动)。",
    inputSchema: {},
  }, async () => run(async () => text(await hub.request("tab.list"))));

  server.registerTool("tab_navigate", {
    title: "打开网址",
    description: "让指定标签页(省略则活动页)导航到 url, 并等待加载完成。",
    inputSchema: {
      url: z.string().describe("完整 URL"),
      tabId: z.number().optional(),
    },
  }, async (args) => run(async () => {
    controlGuard("tab.navigate");
    if (!args?.url) return fail("缺少 url");
    return text(await hub.request("tab.navigate", { url: args.url, tabId: args.tabId }));
  }));

  server.registerTool("page_snapshot", {
    title: "读取页面结构",
    description:
      "返回当前页面的可访问性快照, 每个可交互元素带 ref 编号。"
      + "后续 click/type 用 ref 定位(比坐标可靠)。快照比完整 HTML 小得多。",
    inputSchema: {
      tabId: z.number().optional(),
      maxChars: z.number().optional().describe("快照最多返回字符数, 默认 20000"),
    },
  }, async (args) => run(async () => {
    controlGuard("page.snapshot");
    return text(await hub.request("page.snapshot", {
      tabId: args?.tabId,
      maxChars: Math.max(Number(args?.maxChars) || 20000, 1000),
    }));
  }));

  server.registerTool("page_click", {
    title: "点击元素",
    description: "按 page_snapshot 返回的 ref 点击元素(真实鼠标事件, 非合成 click)。",
    inputSchema: {
      ref: z.string().describe("page_snapshot 里的 ref, 如 e12"),
      tabId: z.number().optional(),
    },
  }, async (args) => run(async () => {
    controlGuard("page.click");
    if (!args?.ref) return fail("缺少 ref");
    return text(await hub.request("page.click", { ref: args.ref, tabId: args.tabId }));
  }));

  server.registerTool("page_type", {
    title: "输入文本",
    description: "按 ref 定位输入框并输入文本(先聚焦、再逐字输入, 会触发真实的 input 事件)。",
    inputSchema: {
      ref: z.string(),
      text: z.string(),
      submit: z.boolean().optional().describe("输入后是否回车提交"),
      tabId: z.number().optional(),
    },
  }, async (args) => run(async () => {
    controlGuard("page.type");
    if (!args?.ref || typeof args?.text !== "string") return fail("需要 ref 与 text");
    return text(await hub.request("page.type", {
      ref: args.ref, text: args.text, submit: !!args.submit, tabId: args.tabId,
    }));
  }));

  server.registerTool("page_press", {
    title: "按键",
    description: "在焦点元素上按键, 如 Enter / Tab / Escape。",
    inputSchema: {
      key: z.string().describe("键名, 如 Enter"),
      tabId: z.number().optional(),
    },
  }, async (args) => run(async () => {
    controlGuard("page.press");
    if (!args?.key) return fail("缺少 key");
    return text(await hub.request("page.press", { key: args.key, tabId: args.tabId }));
  }));

  server.registerTool("page_screenshot", {
    title: "截图",
    description: "截取当前可视区域, 返回 base64 PNG。",
    inputSchema: {
      tabId: z.number().optional(),
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

  server.registerTool("page_eval", {
    title: "在页面执行 JS",
    description:
      "在页面上下文执行一段 JS 表达式并返回结果(MAIN world, 可访问页面自己的变量)。"
      + "仅用于读取/调试; 返回值必须是可序列化的。这个工具只能读到数据, 不要用它做破坏性操作。",
    inputSchema: {
      script: z.string().describe("JS 表达式, 如 document.title"),
      tabId: z.number().optional(),
    },
  }, async (args) => run(async () => {
    controlGuard("page.eval");
    if (!args?.script) return fail("缺少 script");
    return text(await hub.request("page.eval", { script: args.script, tabId: args.tabId }));
  }));
}
