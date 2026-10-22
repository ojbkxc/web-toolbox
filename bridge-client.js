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
    case "page.hover": {
      const tabId = await bridgeResolveTabId(params.tabId);
      return await bridgeHoverRef(tabId, params.ref);
    }
    case "page.select": {
      const tabId = await bridgeResolveTabId(params.tabId);
      return await bridgeSelectRef(tabId, params.ref, params.value);
    }
    case "page.scroll": {
      const tabId = await bridgeResolveTabId(params.tabId);
      return await bridgeScroll(tabId, params);
    }
    case "page.wait": {
      const tabId = await bridgeResolveTabId(params.tabId);
      return await bridgeWait(tabId, params);
    }
    case "tab.activate": {
      const tabId = await bridgeResolveTabId(params.tabId);
      await chrome.tabs.update(tabId, { active: true });
      try { await chrome.windows.update((await chrome.tabs.get(tabId)).windowId, { focused: true }); } catch { /* */ }
      return { ok: true, tabId };
    }
    case "tab.close": {
      const tabId = await bridgeResolveTabId(params.tabId);
      await chrome.tabs.remove(tabId);
      return { ok: true, closed: tabId };
    }
    // ---- 回归能力(v1.1.1): 此前 MCP 只能抓包, 不能跑回归 ----
    // 实现一律复用扩展侧已有函数(runChain 来自 replay.js), 不重写。
    case "chain.replay": {
      const tabId = await bridgeResolveTabId(params.tabId);
      const entries = await bridgePickEntries(params.ids);
      if (!entries.length) throw new Error("没有可重放的条目");
      // runChain 依赖 chrome.scripting 在页面上下文执行, 只能在扩展侧跑
      const { runChain } = globalThis.__toolboxReplay || {};
      if (typeof runChain !== "function") throw new Error("replay.js 未加载, 无法重放");
      const run = runChain(entries, tabId, { singleTimeoutMs: params.timeoutMs });
      const results = await run.run();
      // 只回传判定与关键字段 —— entry/live 可能含完整响应体, 全量回传会让
      // MCP 响应膨胀到数 MB(一次 30 条链轻松超 10MB), 客户端也读不动。
      return results.map((r) => ({
        id: r.entry && r.entry.id,
        method: r.entry && r.entry.method,
        path: r.entry && r.entry.path,
        verdict: r.verdict,
        msg: r.msg,
        recordedStatus: r.entry && r.entry.status,
        liveStatus: r.live && r.live.status,
      }));
    }
    case "console.read": {
      const limit = Math.min(Math.max(Number(params.limit) || 200, 1), 500);
      const all = (globalThis.__toolboxConsole && globalThis.__toolboxConsole.read) ? globalThis.__toolboxConsole.read() : [];
      const lv = params.level ? String(params.level) : "";
      const filtered = lv ? all.filter((e) => e.level === lv) : all;
      return { total: all.length, filtered: filtered.length, entries: filtered.slice(-limit) };
    }
    case "console.clear": {
      if (globalThis.__toolboxConsole && globalThis.__toolboxConsole.clear) globalThis.__toolboxConsole.clear();
      return { ok: true };
    }
    case "page.screenshot": {
      const tabId = await bridgeResolveTabId(params.tabId);
      // 优先 CDP 截图: chrome.tabs.captureVisibleTab 需要 <all_urls> 或 activeTab 生效,
      // 而企业站点通常只授权了自己的域名 —— 会报 "Either <all_urls> or activeTab permission
      // is required"。chmod 走 debugger 则只需要用户已授权该 tab 的调试。
      const target = { tabId };
      const attached = await bridgeEnsureDebugger(tabId);
      try {
        const shot = await chrome.debugger.sendCommand(target, "Page.captureScreenshot", {
          format: "png", captureBeyondViewport: false,
        });
        return { dataUrl: "data:image/png;base64," + shot.data };
      } finally {
        if (attached) await bridgeReleaseDebugger(tabId);
      }
    }
    case "page.eval": {
      const tabId = await bridgeResolveTabId(params.tabId);
      // ⚠ func 会被序列化后在页面 MAIN world 执行, 访问不到 service worker 的任何函数
      // (bridgeSafeValue 在外层作用域 —— 放进来会 ReferenceError)。序列化在页面内完成。
      // frameId: 企业后台常在 iframe 里渲染业务页。不传就在主框架执行。
      // chrome.scripting 支持 allFrames / frameIds, 这里用 allFrames 收集主框架结果。
      const allFrames = !!params.allFrames;
      const results = await chrome.scripting.executeScript({
        target: { tabId, ...(allFrames ? { allFrames: true } : {}) },
        world: "MAIN",
        func: (code) => {
          try {
            // eslint-disable-next-line no-eval
            const v = eval(code);
            if (v === undefined) return { ok: true, value: null };
            try { JSON.stringify(v); return { ok: true, value: v }; }
            catch { return { ok: true, value: String(v) }; }
          } catch (e) {
            return { ok: false, error: String(e) };
          }
        },
        args: [params.script],
      });
      if (!allFrames) return results[0].result;
      // allFrames: 每个 frame 一条结果。只返回有内容/有错误的, 减少噪音。
      const items = results
        .filter((x) => x && x.result !== undefined)
        .map((x) => ({ frameId: x.frameId, ...x.result }));
      return { frames: items.length, results: items };
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

// 等页面加载完成。SPA(hash 路由)的 status 可能一直是 complete, 事件永远不来 ——
// 所以策略是: 先看当前是否已经 complete, 是就直接返回; 否则最多等 15s。
// 不能无条件等事件, 否则每次导航都白等 15 秒。
function bridgeWaitLoad(tabId) {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      try { chrome.tabs.onUpdated.removeListener(onUpdated); } catch { /* */ }
      clearTimeout(timer);
      resolve();
    };
    function onUpdated(id, info) {
      if (id === tabId && info.status === "complete") done();
    }
    try { chrome.tabs.onUpdated.addListener(onUpdated); } catch { done(); return; }
    // 已经加载完(含 SPA 内的 hash 跳转)就直接返回
    chrome.tabs.get(tabId)
      .then((t) => { if (t && t.status === "complete") setTimeout(done, 300); })
      .catch(() => {});
    const timer = setTimeout(done, 15000);
  });
}

// ---------------------------------------------------------------- 页面快照 / 交互
//
// ref 方案: 注入脚本给可交互元素打 data-ai-ref="eN", 返回精简的可访问性文本。
// 为什么用 ref 不用坐标: 坐标对 LLM 是灾难(截图像素与 CSS 像素不一致、滚动失效),
// 元素引用是模型真正擅长的表达方式(Playwright MCP 同款设计)。

const BRIDGE_SNAPSHOT_FN = function (maxChars) {
  // 选择器覆盖: 原生可交互元素 + ARIA 角色 + 常见菜单/树/列表项。
  // 后三类是企业后台(SAP/Oracle 风格 UI 库)的菜单常见形态 —— 它们的菜单项往往是
  // li/div + role=menuitem/treeitem, 只选 a/button 会漏掉整个左侧导航。
  const SEL = [
    "a", "button", "input", "textarea", "select", "summary",
    "[role=button]", "[role=link]", "[role=tab]", "[role=checkbox]", "[role=radio]",
    "[role=menuitem]", "[role=treeitem]", "[role=option]", "[role=switch]",
    "[contenteditable=true]",
    "li", "tr",
  ].join(",");

  // 递归收集: 普通 DOM + 开放 shadow root。企业后台大量使用 Web Components,
  // 元素藏在 shadow DOM 里时只查 document 会"看起来页面是空的"。
  const found = [];
  function collect(root) {
    let els;
    try { els = [...root.querySelectorAll(SEL)]; } catch { return; }
    for (const el of els) found.push(el);
    // 子树里的 shadow root(host 本身不一定在 SEL 里)
    try {
      for (const el of root.querySelectorAll("*")) {
        if (el.shadowRoot) collect(el.shadowRoot);
      }
    } catch { /* 某些 root 不支持 */ }
  }
  collect(document);

  // 清掉上一次的标记, 避免 ref 在多次快照之间串味
  for (const old of document.querySelectorAll("[data-ai-ref]")) old.removeAttribute("data-ai-ref");

  // 同源 iframe: 递归进去收集(跨域 iframe 返回 null, 单独统计告知调用方)
  const frameInfo = [];
  function walkFrames(doc, prefix, depth) {
    if (depth > 3) return;
    let frames = [];
    try { frames = [...doc.querySelectorAll("iframe,frame")]; } catch { return; }
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i];
      let sub = null;
      try { sub = f.contentDocument; } catch { sub = null; }
      if (!sub) {
        let src = "";
        try { src = f.src || ""; } catch { /* */ }
        frameInfo.push({ index: i, src: src.slice(0, 120), crossOrigin: true });
        continue;
      }
      frameInfo.push({ index: i, src: String(f.src || "").slice(0, 120), crossOrigin: false });
      // 子文档里同样要递归 shadow root
      collect(sub);
      walkFrames(sub, prefix + "f" + i + ":", depth + 1);
    }
  }
  walkFrames(document, "", 0);

  const lines = [];
  let n = 0;
  for (const el of found) {
    // 容器类元素(li/tr)只在没有可交互子元素时才算一个"可点项",
    // 否则一个菜单组会把里面所有链接重复列一遍。
    const tag0 = el.tagName.toLowerCase();
    if (tag0 === "li" || tag0 === "tr") {
      if (el.querySelector("a,button,input,select,textarea,[role=button],[role=link]")) continue;
    }
    let rect;
    try { rect = el.getBoundingClientRect(); } catch { continue; }
    // 宽或高任一为 0 都不可点。折叠菜单/隐藏面板的 rect 常常是 h=0 或 w=0,
    // 只判"两者都 0"会让折叠状态的菜单项混进快照 —— AI 点击时坐标落在无效位置。
    if (rect.width <= 0 || rect.height <= 0) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none") continue;
    const label = (el.getAttribute("aria-label") || el.getAttribute("placeholder")
      || el.getAttribute("title") || el.innerText || el.value || "").trim().replace(/\s+/g, " ").slice(0, 80);
    if (!label) continue;                                      // 无文本的元素对 AI 无意义
    n++;
    const ref = "e" + n;
    el.setAttribute("data-ai-ref", ref);
    const tag = el.tagName.toLowerCase();
    const type = el.type ? `[${el.type}]` : "";
    const name = el.name ? ` name=${el.name}` : "";
    lines.push(`${ref} ${tag}${type}${name} "${label}"`);
    if (lines.join("\n").length > maxChars) { lines.push("…(快照已截断, 调大 maxChars)"); break; }
  }

  const crossFrames = frameInfo.filter((f) => f.crossOrigin);
  return {
    url: location.href,
    title: document.title,
    count: n,
    iframes: frameInfo.length,
    crossOriginIframes: crossFrames.length,
    frameDetail: frameInfo.length ? frameInfo.slice(0, 5) : undefined,
    text: lines.join("\n") || (
      crossFrames.length
        ? "(同源上下文里没有可交互元素; 有 " + crossFrames.length + " 个跨域 iframe 读不到内容: "
          + crossFrames.map((f) => f.src).join(", ") + ")"
        : "(页面上没有找到可交互元素)"
    ),
  };
};

async function bridgeSnapshot(tabId, maxChars) {
  const [r] = await chrome.scripting.executeScript({
    target: { tabId }, world: "MAIN", func: BRIDGE_SNAPSHOT_FN, args: [maxChars],
  });
  return r.result;
}

// 页面内: 按 ref 找元素。可穿透开放 shadow root(与快照的 collect 对齐)。
// 注意 func 会被序列化到页面执行, 不能引用 service worker 里的任何东西。
const BRIDGE_FIND_FN = function (ref) {
  function findIn(root) {
    let hit = null;
    try { hit = root.querySelector('[data-ai-ref="' + ref + '"]'); } catch { hit = null; }
    if (hit) return hit;
    try {
      for (const el of root.querySelectorAll("*")) {
        if (el.shadowRoot) {
          const r = findIn(el.shadowRoot);
          if (r) return r;
        }
      }
    } catch { /* */ }
    return null;
  }
  return findIn(document);
};

// 取 ref 元素中心坐标(滚动进视口后再算, 避免坐标落在视口外)
const BRIDGE_RECT_FN = function (ref) {
  function findIn(root) {
    let hit = null;
    try { hit = root.querySelector('[data-ai-ref="' + ref + '"]'); } catch { hit = null; }
    if (hit) return hit;
    try {
      for (const el of root.querySelectorAll("*")) {
        if (el.shadowRoot) { const r = findIn(el.shadowRoot); if (r) return r; }
      }
    } catch { /* */ }
    return null;
  }
  const el = findIn(document);
  if (!el) return null;
  el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
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
      const rf = r;
      function findIn(root) {
        let hit = null;
        try { hit = root.querySelector('[data-ai-ref="' + rf + '"]'); } catch { hit = null; }
        if (hit) return hit;
        try {
          for (const el of root.querySelectorAll("*")) {
            if (el.shadowRoot) { const r = findIn(el.shadowRoot); if (r) return r; }
          }
        } catch { /* */ }
        return null;
      }
      const el = findIn(document);
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

// 悬停: 菜单常常要点开才出现二级项, 悬停是必要动作(不是可选的)
async function bridgeHoverRef(tabId, ref) {
  if (!/^e\d+$/.test(String(ref))) throw new Error("ref 格式非法, 应为 eN");
  const [r] = await chrome.scripting.executeScript({
    target: { tabId }, world: "MAIN", func: BRIDGE_RECT_FN, args: [ref],
  });
  const box = r.result;
  if (!box) throw new Error(`找不到 ref=${ref}(请重新 page_snapshot)`);
  const target = { tabId };
  const attached = await bridgeEnsureDebugger(tabId);
  try {
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      type: "mouseMoved", x: box.x, y: box.y,
    });
    return { ok: true, ref, x: Math.round(box.x), y: Math.round(box.y) };
  } finally {
    if (attached) await bridgeReleaseDebugger(tabId);
  }
}

// 下拉框选择: 直接设 value + 派发 input/change 是最可靠的(原生 select 也适用)
async function bridgeSelectRef(tabId, ref, value) {
  if (!/^e\d+$/.test(String(ref))) throw new Error("ref 格式非法, 应为 eN");
  const [r] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: (rf, val) => {
      function findIn(root) {
        let hit = null;
        try { hit = root.querySelector('[data-ai-ref="' + rf + '"]'); } catch { hit = null; }
        if (hit) return hit;
        try {
          for (const el of root.querySelectorAll("*")) {
            if (el.shadowRoot) { const r = findIn(el.shadowRoot); if (r) return r; }
          }
        } catch { /* */ }
        return null;
      }
      const el = findIn(document);
      if (!el) return { ok: false, error: "找不到元素" };
      if (el.tagName.toLowerCase() !== "select") {
        return { ok: false, error: "目标不是 <select>, 自定义下拉请用 page_click 展开后点选项" };
      }
      const opt = [...el.options].find((o) => o.value === val || o.textContent.trim() === val);
      if (!opt) return { ok: false, error: "没有匹配的选项: " + val, options: [...el.options].map((o) => o.textContent.trim()) };
      el.value = opt.value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true, value: opt.value, text: opt.textContent.trim() };
    },
    args: [ref, String(value)],
  });
  return r.result;
}

// 滚动: 优先滚到指定 ref, 否则按像素滚页面
async function bridgeScroll(tabId, p) {
  const [r] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: (ref, deltaX, deltaY, toBottom) => {
      const rf = ref;
      function findIn(root) {
        let hit = null;
        try { hit = root.querySelector('[data-ai-ref="' + rf + '"]'); } catch { hit = null; }
        if (hit) return hit;
        try {
          for (const el of root.querySelectorAll("*")) {
            if (el.shadowRoot) { const r = findIn(el.shadowRoot); if (r) return r; }
          }
        } catch { /* */ }
        return null;
      }
      if (ref) {
        const el = findIn(document);
        if (!el) return { ok: false, error: "找不到元素" };
        el.scrollIntoView({ block: "center", behavior: "instant" });
        return { ok: true, scrolledTo: ref };
      }
      if (toBottom) {
        window.scrollTo(0, document.body.scrollHeight);
        return { ok: true, toBottom: true, y: window.scrollY };
      }
      window.scrollBy(deltaX || 0, deltaY || 0);
      return { ok: true, y: window.scrollY, x: window.scrollX };
    },
    args: [p.ref || null, p.deltaX || 0, p.deltaY || 0, !!p.toBottom],
  });
  return r.result;
}

// 等待条件: 元素出现/消失、文本出现、URL 变化、固定毫秒。
// 自动化里"点完等加载"是最大的不确定性来源, 显式等待比 sleep 可靠得多。
async function bridgeWait(tabId, p) {
  if (p.ms && !p.selector && !p.text && !p.urlIncludes) {
    await new Promise((r) => setTimeout(r, Math.min(Number(p.ms) || 0, 30000)));
    return { ok: true, waitedMs: p.ms };
  }
  const timeout = Math.min(Number(p.timeoutMs) || 10000, 60000);
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: (sel, txt, urlInc, untilGone) => {
        if (sel) {
          const found = !!document.querySelector(sel);
          return { hit: untilGone ? !found : found, url: location.href };
        }
        if (txt) {
          const found = (document.body.innerText || "").includes(txt);
          return { hit: untilGone ? !found : found, url: location.href };
        }
        if (urlInc) return { hit: location.href.includes(urlInc), url: location.href };
        return { hit: true, url: location.href };
      },
      args: [p.selector || null, p.text || null, p.urlIncludes || null, !!p.untilGone],
    });
    if (r.result && r.result.hit) {
      return { ok: true, url: r.result.url, waitedMs: timeout - (deadline - Date.now()) };
    }
    await new Promise((res) => setTimeout(res, 250));
  }
  return { ok: false, error: `等待超时(${timeout}ms)`, condition: p };
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

// ⚠ 必须告诉 background.js "这次 detach 是桥接自己发的":
//   它的 chrome.debugger.onDetach 监听会无条件清掉 attach 记录 + pending,
//   桥接点一下就会把录制状态清空(用户看到"录制中"却什么都捕不到)。
//   bridgeOwnDetach 就是这个信号。
const bridgeOwnDetach = new Set();

async function bridgeReleaseDebugger(tabId) {
  bridgeOwnDetach.add(tabId);
  try { await chrome.debugger.detach({ tabId }); } catch { /* 已被别处 detach */ }
  // 给 onDetach 事件留时间跑完, 再摘标记
  setTimeout(() => bridgeOwnDetach.delete(tabId), 1000);
}

// 供 background.js 查询(它不 importScripts 本文件的内部状态, 走 globalThis)
globalThis.toolboxBridgeOwnDetach = bridgeOwnDetach;

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
// dispatch: 侧栏「页面」页签直接调用 —— 复用与 MCP 完全相同的实现(bridgeDispatch),
// 不产生第二套页面操作代码。侧栏不走 WebSocket(那是给外部 MCP 客户端的),
// 而是经 background 消息直接调本函数, 因此不要求 bridge 已连接。
globalThis.toolboxBridge = {
  connect: bridgeConnect,
  disconnect: bridgeDisconnect,
  status: bridgeStatus,
  setConfig: bridgeSetConfig,
  getConfig: bridgeGetConfig,
  dispatch: bridgeDispatch,
};

// 启动
bridgeBoot();
