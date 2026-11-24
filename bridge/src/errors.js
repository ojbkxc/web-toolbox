// errors.js —— 桥接错误语义的单一真相: 码 → 文案 + "下一步"。
//
// 为什么集中: tools.js 里散着 fail("缺少 id") 这种一句话错误 —— AI 客户端拿到「错误: 缺少 id」
// 只知道失败, 不知道该补什么参数、该不该重试、还是该去启动 daemon。参考 chrome-devtools-mcp 的
// 做法(ToolHandler 的 buildDisabledMessage 等): 每条错误都写清"为什么 + 怎么办"。
//
// 两类码:
//   · 线协议码(来自 bridge-protocol.js 的 ERR.*) —— Hub 抛出的错误自带 code;
//   · 业务码(LOCAL.*) —— 工具层自己判出来的失败(入参不合法/没有数据/返回形态异常)。
// 每条都必须有 hint; 没有 hint 的错误等于让调用方瞎猜。
//
// 输出形态(稳定, 客户端可正则以错误码分流):
//   错误[no_entries]: 过滤后没有条目
//   下一步: 去掉过滤条件再试, 或先调 net_list 看当前抓到了什么

import protocol from "../../bridge-protocol.js";

const { ERR } = protocol;

// 线协议码的文案与下一步。键必须覆盖 bridge-protocol 的 ERR 全集(由 test/check_bridge_errors.js 钉住)。
export const ERROR_HINTS = {
  [ERR.NOT_CONNECTED]: {
    text: "Chrome 扩展未连接",
    hint: "在 Chrome 打开扩展配置页「AI 桥接」点「立即连接」; 仍然连不上先跑 node bridge/src/doctor.js",
  },
  [ERR.FORBIDDEN]: {
    text: "该操作需要管理权限",
    hint: "用 --allow-control 重启 bridge(控制类工具: 点击/输入/导航/录制/重放)",
  },
  [ERR.TIMEOUT]: {
    text: "等待扩展响应超时",
    hint: "确认 Chrome 标签页没有卡住; 页面级操作可先 page_wait 等加载完再试",
  },
  [ERR.UNKNOWN_METHOD]: {
    text: "bridge 不认识这个方法",
    hint: "扩展与 bridge 版本不一致: 调 bridge_status 对比 extension.version 与 bridge.version,"
      + " 更新两者到同一版本(扩展: 重新加载本目录; bridge: git pull 后重启进程)",
  },
  [ERR.UNAUTHORIZED]: {
    text: "令牌校验失败",
    hint: "核对扩展配置页的令牌与 ~/.web-toolbox/bridge-token 一致(或 WEB_TOOLBOX_TOKEN)",
  },
  [ERR.PROTOCOL_MISMATCH]: {
    text: "协议版本不一致",
    hint: "扩展与 bridge 的协议版本不同: 调 bridge_status 看 extension.protocol 与 bridge.protocol,"
      + " 两者必须相同; 不同则扩展在 chrome://extensions 重新加载、bridge 重启",
  },
  [ERR.EEXT]: {
    text: "扩展侧执行失败",
    hint: "看错误详情里的原因; 若是页面已关闭/换了 tab, 先 page_snapshot 确认元素还在;"
      + " 跨域 iframe 内的元素需先切到该 frame(桥接只处理主 frame 与同源子 frame)",
  },
  [ERR.BAD_FRAME]: {
    text: "收到无法解析的协议帧",
    hint: "通常是版本错位或端口被别的程序占用, 先跑 node bridge/src/doctor.js",
  },
};

// 业务码(工具层自判)
export const LOCAL = {
  BAD_ARGS: "bad_args",       // 入参缺失/形态不对
  NO_ENTRIES: "no_entries",   // 抓包为空或过滤后为空
  BAD_PAYLOAD: "bad_payload", // 扩展返回形态异常(版本错位等)
  BAD_STATE: "bad_state",     // 前置状态不满足(例如没有可重放条目)
};

export const LOCAL_HINTS = {
  [LOCAL.BAD_ARGS]: "按工具 schema 补参数; 不认识的参数名以 tools/list 里的 inputSchema 为准",
  [LOCAL.NO_ENTRIES]: "先用 net_list 看当前抓到什么; 空的话确认已开始录制且域名已授权",
  [LOCAL.BAD_PAYLOAD]:
    "扩展返回的数据形态与预期不符: 调 bridge_status 对比 extension.version/protocol 与"
    + " bridge.version/protocol, 两者应相同; 不同则扩展在 chrome://extensions 重新加载、bridge 重启。"
    + " 若两者一致, 说明是字段漂移, 把这条错误连同工具名反馈",
  // 这类码的本意是"当前状态不允许这次调用" —— 错误消息里会给出具体动作(缩小过滤范围 /
  // 先开录制 等), hint 只做兜底指向: 说清"照消息做"+ 两个最常见的前置动作, 而不是
  // 硬套某一种场景(旧文案只写"先录制再重放", 与真正的用途"产物过大"完全不符)。
  [LOCAL.BAD_STATE]:
    "按错误消息里的具体动作执行(常见前置: 先 rec_start 开始录制 / 缩小导出范围后重试);"
    + " 见 tools/list 里对应工具的 schema 与参数说明",
};

const FALLBACK = {
  text: "未知错误",
  hint: "把这条错误与 node bridge/src/doctor.js 的输出一起反馈",
};

function meta(code) {
  return ERROR_HINTS[code] || LOCAL_HINTS[code] || FALLBACK;
}

/**
 * 渲染一条错误文本: 码 + 文案 + 下一步。
 * @param {string} code
 * @param {string} [message] 具体原因(省略则用码的通用文案)
 * @param {string} [hint] 覆盖默认下一步(工具能给出更具体的动作时用)
 */
export function describeError(code, message, hint) {
  const m = meta(code);
  const head = message ? message : m.text;
  return `错误[${code}]: ${head}\n下一步: ${hint || m.hint}`;
}

/**
 * 生成 MCP 工具错误结果(isError=true), 供 tools.js 的 fail() 使用。
 * @returns {{content: Array<{type:"text", text:string}>, isError: true}}
 */
export function toolFail(code, message, hint) {
  return { content: [{ type: "text", text: describeError(code, message, hint) }], isError: true };
}

/**
 * 把异常转成工具错误结果: 带 code 的异常按码查表(并保留原始 message 作为具体原因),
 * 裸异常退化为 unknown(仍给下一步)。
 */
export function fromException(e) {
  const code = (e && e.code) || "error";
  const message = e && e.message ? e.message : String(e);
  return toolFail(code, message);
}

/** 该码是否已登记(测试用)。 */
export function knownCodes() {
  return [...Object.keys(ERROR_HINTS), ...Object.keys(LOCAL_HINTS)];
}
