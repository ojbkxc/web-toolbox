// bridge-client.js —— 扩展侧 AI 桥接适配层(service worker 内运行)。
//
// 职责边界: 只负责【传输】(WebSocket 连接/鉴权/心跳/重连)和【命令分发】,
// 不含任何抓包或导出业务逻辑 —— 那些继续留在 background.js / common.js / jmx.js。
// 这样可以保证: 桥接出问题时, 录制引擎完全不受影响。
//
// 协议常量来自 bridge-protocol.js(与 bridge 共用同一份, importScripts 提前加载)。
//
// ⚠ MV3 生命周期: service worker 空闲约 30s 被杀。WebSocket 活动会重置计时器,
// 但断线重连窗口内没有活动 —— 所以重连用 chrome.alarms(最小 30s)而不是 setTimeout,
// 保证 worker 被唤醒后能重新连上。

/* global BRIDGE, chrome, importScripts */

const BRIDGE_KEY_CFG = "toolbox.bridge";       // { url, token, enabled }
const BRIDGE_ALARM = "toolbox.bridgeReconnect";
const BRIDGE_PING_MS = 25000;

const bridgeState = {
  ws: null,
  connected: false,
  lastError: "",
  attempts: 0,
  pingTimer: null,
  manualStop: false,
};

// ---------------------------------------------------------------- 配置

async function bridgeGetConfig() {
  const r = await chrome.storage.local.get([BRIDGE_KEY_CFG]);
  const c = r[BRIDGE_KEY_CFG] || {};
  return {
    url: typeof c.url === "string" && c.url ? c.url : "ws://127.0.0.1:9280/ext",
    token: typeof c.token === "string" ? c.token : "",
    enabled: c.enabled !== false,   // 默认开(但没令牌时不会真连)
  };
}

async function bridgeSetConfig(patch) {
  const cur = await bridgeGetConfig();
  const next = { ...cur, ...patch };
  await chrome.storage.local.set({ [BRIDGE_KEY_CFG]: next });
  return next;
}

// ---------------------------------------------------------------- 连接

function bridgeClearTimers() {
  if (bridgeState.pingTimer) {
    clearInterval(bridgeState.pingTimer);
    bridgeState.pingTimer = null;
  }
}

function bridgeScheduleReconnect() {
  // 用 alarm 而不是 setTimeout: worker 休眠后 setTimeout 不再触发, alarm 会唤醒
  try {
    chrome.alarms.create(BRIDGE_ALARM, { delayInMinutes: 0.5 });  // 最小粒度 0.4min, 取 0.5 稳妥
  } catch { /* alarms 不可用(老的 mock 环境)时静默 */ }
}

async function bridgeConnect(force) {
  const cfg = await bridgeGetConfig();
  if (!cfg.enabled || !cfg.token) {
    return { ok: false, error: "未启用或未填令牌" };
  }
  if (bridgeState.ws && !force) {
    const rs = bridgeState.ws.readyState;
    if (rs === 0 || rs === 1) return { ok: true, already: true };
  }

  bridgeState.manualStop = false;
  bridgeDisconnectSilently();

  return new Promise((resolve) => {
    let ws;
    try {
      ws = new WebSocket(cfg.url);
    } catch (e) {
      bridgeState.lastError = "URL 非法: " + String(e);
      bridgeScheduleReconnect();
      return resolve({ ok: false, error: bridgeState.lastError });
    }
    bridgeState.ws = ws;

    // 连接超时: 端口没起时 WebSocket 会一直 pending, 不给用户"卡住"的错觉
    const connectTimer = setTimeout(() => {
      if (ws.readyState !== 1) {
        bridgeState.lastError = "连接超时(桥接服务没启动?)";
        try { ws.close(); } catch { /* ignore */ }
        resolve({ ok: false, error: bridgeState.lastError });
      }
    }, 5000);

    ws.onopen = () => {
      clearTimeout(connectTimer);
      // 首帧必须是 hello: 令牌 + 协议版本。bridge 校验失败会直接断开。
      ws.send(JSON.stringify({
        type: BRIDGE.FRAME.HELLO,
        protocol: BRIDGE.PROTOCOL_VERSION,
        token: cfg.token,
        ext: { version: chrome.runtime.getManifest().version, ua: "web-toolbox" },
      }));
    };

    ws.onmessage = (ev) => {
      let frame;
      try { frame = JSON.parse(ev.data); } catch { return; }
      if (!BRIDGE.isFrame(frame)) return;

      if (frame.type === BRIDGE.FRAME.READY) {
        bridgeState.connected = true;
        bridgeState.attempts = 0;
        bridgeState.lastError = "";
        try { chrome.alarms.clear(BRIDGE_ALARM); } catch { /* ignore */ }
        bridgeStartPing();
        bridgeFlushQueuedEvents();
        resolve({ ok: true, bridge: frame.bridge });
        return;
      }
      if (frame.type === BRIDGE.FRAME.ERROR) {
        bridgeState.lastError = frame.code === BRIDGE.ERR.UNAUTHORIZED
          ? "令牌不匹配(bridge 与扩展配置不一致)"
          : (frame.message || frame.code);
        if (!bridgeState.connected) resolve({ ok: false, error: bridgeState.lastError });
        return;
      }
      if (frame.type === BRIDGE.FRAME.REQ) {
        bridgeHandleRequest(frame);
        return;
      }
      if (frame.type === BRIDGE.FRAME.PONG) return;
    };

    ws.onerror = () => {
      // 浏览器不暴露具体原因(安全设计), 只能给通用提示 + 让 onclose 走重连
      bridgeState.lastError = "连接失败(检查 bridge 是否启动、端口/令牌是否正确)";
    };

    ws.onclose = () => {
      clearTimeout(connectTimer);
      const wasConnected = bridgeState.connected;
      bridgeState.connected = false;
      bridgeState.ws = null;
      bridgeClearTimers();
      if (!wasConnected) resolve({ ok: false, error: bridgeState.lastError || "连接被关闭" });
      if (!bridgeState.manualStop) bridgeScheduleReconnect();
    };
  });
}

function bridgeStartPing() {
  bridgeClearTimers();
  // Chrome 116+ 里 WebSocket 收发消息本身就会重置 SW 空闲计时器, 心跳是双保险
  bridgeState.pingTimer = setInterval(() => {
    bridgeSend({ type: BRIDGE.FRAME.PING });
  }, BRIDGE_PING_MS);
}

function bridgeSend(obj) {
  const ws = bridgeState.ws;
  if (!ws || ws.readyState !== 1) return false;
  try { ws.send(JSON.stringify(obj)); return true; } catch { return false; }
}

function bridgeDisconnectSilently() {
  bridgeClearTimers();
  if (bridgeState.ws) {
    try { bridgeState.ws.onclose = null; bridgeState.ws.close(); } catch { /* ignore */ }
    bridgeState.ws = null;
  }
  bridgeState.connected = false;
}

async function bridgeDisconnect() {
  bridgeState.manualStop = true;
  try { chrome.alarms.clear(BRIDGE_ALARM); } catch { /* ignore */ }
  bridgeDisconnectSilently();
  return { ok: true };
}

async function bridgeStatus() {
  return {
    connected: bridgeState.connected,
    url: (await bridgeGetConfig()).url,
    hasToken: !!(await bridgeGetConfig()).token,
    lastError: bridgeState.lastError,
  };
}

// ---------------------------------------------------------------- 事件推送

// 扩展侧有两个"值得推给 AI"的时机: 新抓包入库、录制状态变化。
// 推送失败(未连接)时不缓存 —— 数据本来就在 storage 里, AI 用 net_list 拉即可,
// 缓存反而会让 MCP 侧收到重复数据。这里只做"实时提示", 不做投递保证。
let bridgeLastHarvestCount = 0;
function bridgeFlushQueuedEvents() {
  // 连接建立后补推一次当前状态, 让 MCP 侧立刻知道扩展里有什么
  bridgeEmit("harvest", { entries: [], note: "connected" });
}

function bridgeEmit(event, data) {
  if (!bridgeState.connected) return false;
  return bridgeSend({ type: BRIDGE.FRAME.EVENT, event, data });
}

// ---------------------------------------------------------------- 命令处理

async function bridgeHandleRequest(frame) {
  const { id, method, params } = frame;
  let result;
  try {
    result = await bridgeDispatch(method, params || {});
    bridgeSend({ type: BRIDGE.FRAME.RES, id, ok: true, result });
  } catch (e) {
    bridgeSend({
      type: BRIDGE.FRAME.RES, id, ok: false,
      error: (e && e.message) ? e.message : String(e),
    });
  }
}

// 命令分发表。只读命令直接读 storage / tab; 控制命令走 chrome.debugger / chrome.scripting。
// 业务规则(过滤/清洗/关联/导出)一律调用已有函数, 不在这里重写。
async function bridgeDispatch(method, params) {
  switch (method) {
    case "rec.status": {
      const info = await bridgeGetRecInfo();
      return info;
    }

    case "net.list": {
      const arr = await bridgeReadHarvest();
      return arr;
    }

    case "net.get": {
      const arr = await bridgeReadHarvest();
      const e = arr.find((x) => x.id === params.id);
      return e || null;
    }

    case "net.hosts": {
      const arr = await bridgeReadHarvest();
      const m = new Map();
      for (const e of arr) {
        let h = "";
        try { h = new URL(e.url).hostname; } catch { continue; }
        m.set(h, (m.get(h) || 0) + 1);
      }
      return [...m.entries()]
        .map(([host, count]) => ({ host, count }))
        .sort((a, b) => b.count - a.count);
    }

    case "tab.list": {
      const tabs = await chrome.tabs.query({});
      return tabs.map((t) => ({
        id: t.id, title: t.title, url: t.url, active: !!t.active, windowId: t.windowId,
      }));
    }

    // ---- 导出/关联: 不在 service worker 里做 ----
    // 为什么: common.js 与本文件(background.js 全局域)都声明了 KEY_DOMAINS, 同一 SW 里
    // importScripts 会 SyntaxError 把整个扩展带塌。改为由 bridge(Node)直接 require
    // 仓库里同一份 jmx.js/common.js/correlate.js —— 同一份源码, 不是复制, 也不碰扩展全局域。
    case "export.har":
    case "export.jmx":
    case "export.python":
    case "correlate.analyze":
      throw new Error(method + " 由 bridge 侧计算, 不应转发到扩展");

    // ---- 录制控制 ----
    case "rec.start": {
      let tabId = params.tabId;
      if (typeof tabId !== "number") {
        const t = await bridgeActiveTab();
        if (!t) throw new Error("找不到活动标签页");
        tabId = t.id;
      }
      return await bridgeInvokeMessage({ type: "startRecording", tabId });
    }
    case "rec.stop":
      return await bridgeInvokeMessage({ type: "stopRecording" });

    // ---- 页面控制 ----
    case "tab.navigate": {
      const tabId = await bridgeResolveTabId(params.tabId);
      await chrome.tabs.update(tabId, { url: params.url });
      await bridgeWaitLoad(tabId);
      return { ok: true, tabId, url: params.url };
    }
    case "page.snapshot": {
      const tabId = await bridgeResolveTabId(params.tabId);
      return await bridgeSnapshot(tabId, params.maxChars || 20000);
    }
    case "page.click": {
      const tabId = await bridgeResolveTabId(params.tabId);
      return await bridgeClickRef(tabId, params.ref);
    }
    case "page.type": {
      const tabId = await bridgeResolveTabId(params.tabId);
      return await bridgeTypeRef(tabId, params.ref, params.text, params.submit);
    }
    case "page.press": {
      const tabId = await bridgeResolveTabId(params.tabId);
      return await bridgePressKey(tabId, params.key);
    }
    case "page.screenshot": {
      const tabId = await bridgeResolveTabId(params.tabId);
      const tab = await chrome.tabs.get(tabId);
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
      return { dataUrl };
    }
    case "page.eval": {
      const tabId = await bridgeResolveTabId(params.tabId);
      const [r] = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: (code) => {
          try {
            // eslint-disable-next-line no-eval
            const v = eval(code);
            return { ok: true, value: bridgeSafeValue(v) };
          } catch (e) {
            return { ok: false, error: String(e) };
          }
        },
        args: [params.script],
      });
      return r.result;
    }

    default:
      throw new Error("未知方法: " + method);
  }
}

// ---------------------------------------------------------------- 辅助

// 读取 harvest(与 background.js 的 decodeHarvest 同语义, 这里独立实现避免依赖全局加载顺序)
async function bridgeReadHarvest() {
  const r = await chrome.storage.local.get(["toolbox.harvest"]);
  const raw = r["toolbox.harvest"];
  if (raw == null) return [];
  let arr;
  if (Array.isArray(raw)) arr = raw;
  else if (raw && Array.isArray(raw.entries)) arr = raw.entries;
  else return [];
  // body 归一化: 旧版本可能把 CDP 的 postData 对象直接入库
  return arr.map((e) => {
    if (e && e.body != null && typeof e.body === "object") {
      const b = e.body;
      e.body = typeof b.text === "string" ? b.text
        : Array.isArray(b.params) ? b.params.map((p) => `${p.name}=${p.value ?? ""}`).join("&") : "";
    }
    return e;
  });
}

async function bridgeGetRecInfo() {
  const r = await chrome.storage.local.get(["toolbox.recording"]);
  const arr = await bridgeReadHarvest();
  return { recState: r["toolbox.recording"] || "idle", count: arr.length };
}

// 按 id 取子集; ids 为空/缺失 → 全量(与扩展侧"导出集"语义一致: 不传就全导)
async function bridgePickEntries(ids) {
  const all = await bridgeReadHarvest();
  if (!Array.isArray(ids) || !ids.length) return all;
  const set = new Set(ids);
  return all.filter((e) => set.has(e.id));
}

async function bridgeActiveTab() {
  const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return t || null;
}

async function bridgeResolveTabId(tabId) {
  if (typeof tabId === "number") return tabId;
  const t = await bridgeActiveTab();
  if (!t) throw new Error("找不到活动标签页");
  return t.id;
}

// service worker 给自己发 runtime.sendMessage 收不到自己 —— 必须直接调 background 的监听器。
// background.js 已把监听逻辑抽成 toolboxHandleMessage(见该文件的改动说明)。
async function bridgeInvokeMessage(msg) {
  if (typeof toolboxHandleMessage !== "function") {
    throw new Error("background 消息处理器未就绪");
  }
  return await new Promise((resolve, reject) => {
    let done = false;
    const sendResponse = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const ret = toolboxHandleMessage(msg, sendResponse);
      // 监听器返回 true 表示异步; 若既不返回 true 也没同步响应, 给个空结果避免悬挂
      if (ret !== true && !done) resolve(undefined);
    } catch (e) {
      reject(e);
    }
    setTimeout(() => { if (!done) { done = true; reject(new Error("background 响应超时")); } }, 15000);
  });
}

function bridgeSafeValue(v) {
  try {
    if (v === undefined) return null;
    JSON.stringify(v);
    return v;
  } catch {
    return String(v);
  }
}

// 等页面加载完成(load 事件), 超时 15s 不阻塞流程
function bridgeWaitLoad(tabId) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { cleanup(); resolve(); }, 15000);
    function onUpdated(id, info) {
      if (id === tabId && info.status === "complete") { cleanup(); resolve(); }
    }
    function cleanup() {
      clearTimeout(timer);
      try { chrome.tabs.onUpdated.removeListener(onUpdated); } catch { /* ignore */ }
    }
    try { chrome.tabs.onUpdated.addListener(onUpdated); } catch { cleanup(); resolve(); }
  });
}

// ---------------------------------------------------------------- 页面快照 / 交互
//
// ref 方案: 注入脚本给可交互元素打 data-ai-ref="eN", 返回精简的可访问性文本。
// 为什么用 ref 不用坐标: 坐标对 LLM 是灾难(截图像素与 CSS 像素不一致、滚动失效),
// 元素引用是模型真正擅长的表达方式(Playwright MCP 同款设计)。

const BRIDGE_SNAPSHOT_FN = function (maxChars) {
  const SEL = "a,button,input,textarea,select,[role=button],[role=link],[role=tab],[role=checkbox],[role=radio],[contenteditable=true],summary";
  // 清掉上一次的标记, 避免 ref 在多次快照之间串味
  for (const old of document.querySelectorAll("[data-ai-ref]")) old.removeAttribute("data-ai-ref");
  const els = [...document.querySelectorAll(SEL)];
  const lines = [];
  let n = 0;
  for (const el of els) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;       // 不可见
    if (getComputedStyle(el).visibility === "hidden") continue;
    n++;
    const ref = "e" + n;
    el.setAttribute("data-ai-ref", ref);
    const tag = el.tagName.toLowerCase();
    let label = (el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.innerText || el.value || "").trim();
    label = label.replace(/\s+/g, " ").slice(0, 80);
    const type = el.type ? `[${el.type}]` : "";
    const name = el.name ? ` name=${el.name}` : "";
    lines.push(`${ref} ${tag}${type}${name} "${label}"`);
    if (lines.join("\n").length > maxChars) { lines.push("…(快照已截断)"); break; }
  }
  return {
    url: location.href,
    title: document.title,
    count: n,
    text: lines.join("\n") || "(页面上没有找到可交互元素)",
  };
};

async function bridgeSnapshot(tabId, maxChars) {
  const [r] = await chrome.scripting.executeScript({
    target: { tabId }, world: "MAIN", func: BRIDGE_SNAPSHOT_FN, args: [maxChars],
  });
  return r.result;
}

// 取 ref 元素的中心坐标(在页面内解析, 避免把坐标计算逻辑放到 SW)
const BRIDGE_RECT_FN = function (ref) {
  const el = document.querySelector(`[data-ai-ref="${ref}"]`);
  if (!el) return null;
  el.scrollIntoView({ block: "center", inline: "center" });
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
};

async function bridgeClickRef(tabId, ref) {
  if (!/^e\d+$/.test(String(ref))) throw new Error("ref 格式非法, 应为 eN");
  const [r] = await chrome.scripting.executeScript({
    target: { tabId }, world: "MAIN", func: BRIDGE_RECT_FN, args: [ref],
  });
  const box = r.result;
  if (!box) throw new Error(`找不到 ref=${ref}(页面可能已变化, 请重新 page_snapshot)`);

  // 用 CDP 派发真实鼠标事件: 合成 el.click() 对 React 受控组件/跨域 iframe 无效
  const target = { tabId };
  const attached = await bridgeEnsureDebugger(tabId);
  try {
    const base = { x: box.x, y: box.y, button: "left", clickCount: 1 };
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", { type: "mousePressed", ...base });
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", { type: "mouseReleased", ...base });
    return { ok: true, ref, x: Math.round(box.x), y: Math.round(box.y) };
  } finally {
    if (attached) await bridgeReleaseDebugger(tabId);
  }
}

async function bridgeTypeRef(tabId, ref, value, submit) {
  if (!/^e\d+$/.test(String(ref))) throw new Error("ref 格式非法, 应为 eN");
  // 先聚焦并清空
  const [fr] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: (r, v) => {
      const el = document.querySelector(`[data-ai-ref="${r}"]`);
      if (!el) return { ok: false, error: "找不到元素" };
      el.focus();
      if ("value" in el) {
        el.value = "";
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }
      return { ok: true };
    },
    args: [ref, value],
  });
  if (!fr.result || !fr.result.ok) throw new Error(fr.result?.error || "聚焦失败");

  const target = { tabId };
  const attached = await bridgeEnsureDebugger(tabId);
  try {
    // insertText 会触发真实的 beforeinput/input, 受控组件能正确接住
    await chrome.debugger.sendCommand(target, "Input.insertText", { text: value });
    if (submit) {
      await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
        type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
      });
      await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
        type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
      });
    }
    return { ok: true, ref, chars: value.length, submitted: !!submit };
  } finally {
    if (attached) await bridgeReleaseDebugger(tabId);
  }
}

async function bridgePressKey(tabId, key) {
  const target = { tabId };
  const attached = await bridgeEnsureDebugger(tabId);
  try {
    await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", { type: "keyDown", key });
    await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", { type: "keyUp", key });
    return { ok: true, key };
  } finally {
    if (attached) await bridgeReleaseDebugger(tabId);
  }
}

// ---- debugger 会话管理 ----
// 关键约束: 同一 tab 只能有一个 debugger attach。录制引擎可能已经 attach 着它。
// 所以这里用"按需 attach / 用完只在是自己 attach 的情况下 detach"的引用计数方式,
// 绝不把录制引擎的 attach 踢掉。
async function bridgeEnsureDebugger(tabId) {
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
    return true;                  // 本次新 attach, 用完要还
  } catch (e) {
    if (/already attached/i.test(String(e))) return false;   // 录制引擎在用, 直接复用
    throw new Error("无法连接调试器: " + String(e));
  }
}

async function bridgeReleaseDebugger(tabId) {
  try { await chrome.debugger.detach({ tabId }); } catch { /* 已被别处 detach */ }
}

// ---------------------------------------------------------------- 生命周期挂载

// worker 每次唤醒: 若配置启用则尝试连接(重连由 alarm 触发时也会走到这里)
async function bridgeBoot() {
  const cfg = await bridgeGetConfig();
  if (!cfg.enabled || !cfg.token) return;
  await bridgeConnect(false);
}

try {
  chrome.alarms.onAlarm.addListener((a) => {
    if (a && a.name === BRIDGE_ALARM) bridgeConnect(false);
  });
} catch { /* alarms 不可用 */ }

// 配置变更(用户在 options 页保存) → 立即重连
try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[BRIDGE_KEY_CFG]) return;
    const v = changes[BRIDGE_KEY_CFG].newValue || {};
    if (v.enabled === false) { bridgeDisconnect(); return; }
    bridgeConnect(true);
  });
} catch { /* ignore */ }

// 新抓包入库 → 推给 MCP 侧(只推新增, 不推全量, 避免大流量时反复序列化)
try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes["toolbox.harvest"]) return;
    if (!bridgeState.connected) return;
    const nv = changes["toolbox.harvest"].newValue;
    const arr = nv && Array.isArray(nv.entries) ? nv.entries : (Array.isArray(nv) ? nv : []);
    if (arr.length <= bridgeLastHarvestCount) { bridgeLastHarvestCount = arr.length; return; }
    const fresh = arr.slice(bridgeLastHarvestCount);
    bridgeLastHarvestCount = arr.length;
    if (fresh.length) bridgeEmit("harvest", { entries: fresh });
  });
} catch { /* ignore */ }

// 暴露给 background.js 的管理入口(options 页也可以直接发消息)
globalThis.toolboxBridge = {
  connect: bridgeConnect,
  disconnect: bridgeDisconnect,
  status: bridgeStatus,
  setConfig: bridgeSetConfig,
  getConfig: bridgeGetConfig,
};

// 启动
bridgeBoot();
