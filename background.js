// Web 工具箱 - service worker
// 职责: 域名授权消息中转 + 【录制引擎(chrome.debugger 后台捕获, 全程免 DevTools)】。
//
// 录制机制: chrome.debugger.attach 到用户所在 tab, 启用 Network domain,
// 每个请求事件带 request/response/请求体 —— 这是 BlazeMeter 扩展同款机制,
// 用户全程不需要 DevTools。代价: Chrome 顶部显示"正在调试"黄条(安全设计, 不可去除)。
//
// ⚠ MV3 生命周期(v0.2 "一个接口都录不上"的根因): service worker 空闲约 30s 被
// Chrome 杀掉, 被事件唤醒后**模块变量全部归零**。点开始后用户在页面填表单 30s+
// (期间零请求) → worker 被杀 → 提交请求唤醒 worker → domainsCache 已是 [] →
// 域名过滤把所有请求静默丢弃。修复:
//   1. 域名/状态在 worker 每次唤醒时(top-level)从 storage 重载;
//   2. 事件处理器全程同步判断(禁止 await 之后再过滤, 冷启动竞态会丢请求),
//      冷启动瞬间到达的请求先进缓冲, 加载完补处理;
//   3. harvest 写入串行化(并发读-改-写会互相覆盖丢条目);
//   4. 录不上时把原因(没配域名/请求走了别的域)通过 getRecInfo 暴露给 popup。
//
// 状态存储: chrome.storage.local
//   toolbox.recording : "idle" | "recording" | "paused"(状态机, 与 popup/面板共享)
//   toolbox.harvest   : { v: HARVEST_V, entries: [{...}] 录制数据(最新 3000 条, 多次录制累计)
//                       —— v0.3.6 起包一层带版本信封: 损坏显式报错、未来 schema 变更可迁移;
//                       旧版数据(裸数组)读时自动升级, 写出永远是信封格式
//   toolbox.debugTabs  : [tabId, ...] 当前 attach 着的 tab(停止时全部 detach)

const KEY_DOMAINS = "toolbox.domains";
const KEY_REC = "toolbox.recording";
const KEY_HARVEST = "toolbox.harvest";
const KEY_TABS = "toolbox.debugTabs";
const MAX_ENTRIES = 3000;
const KEEPALIVE_ALARM = "toolbox.recKeepalive";
const HARVEST_V = 1;          // 信封 schema 版本; 未来改条目结构时 +1 并写迁移
const HARVEST_BUDGET_RATIO = 0.75; // harvest 占 storage 配额的预算(留 25% 给其他 key)

// ---- 域名授权: chrome.permissions.request 必须由用户手势触发, 且不能在 service worker 里调 ----
// 所以授权动作由 popup/options 发起, worker 只做存储与查询。

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get([KEY_DOMAINS], (r) => {
    if (!Array.isArray(r[KEY_DOMAINS])) {
      chrome.storage.local.set({ [KEY_DOMAINS]: [] });
    }
  });
});

// ---- 域名匹配(录制过滤) ----
async function getDomains() {
  return new Promise((resolve) => {
    chrome.storage.local.get([KEY_DOMAINS], (r) => {
      resolve(Array.isArray(r[KEY_DOMAINS]) ? r[KEY_DOMAINS] : []);
    });
  });
}

function matchDomain(host, domains) {
  if (!domains || !domains.length) return false;
  return domains.some((d) => host === d || host.endsWith("." + d));
}

// ---- 录制引擎运行时状态(常驻模块变量, worker 唤醒时重载) ----
let domainsCache = null; // null = 还没从 storage 加载完(冷启动窗口)
let recState = "idle";   // "idle" | "recording" | "paused"
const earlyBuffer = [];  // 冷启动窗口到达的请求, 状态加载完补处理
const unmatchedHosts = new Map(); // 被域名过滤掉的主机 → 次数("为什么录不上"的诊断线索)

async function loadRuntimeState() {
  domainsCache = await getDomains();
  const r = await chrome.storage.local.get([KEY_REC]);
  recState = r[KEY_REC] || "idle";
}

// worker 每次启动(含被事件唤醒)都跑一遍 —— 这是"录不上"修复的核心
const stateReady = (async () => {
  try {
    await loadRuntimeState();
    const buf = earlyBuffer.splice(0);
    for (const p of buf) handleRequestWillBeSent(p);
    // worker 被杀过又醒来(或浏览器重启后扩展自动激活): 恢复图标角标,
    // 让"还在录/暂停"在图标上一眼可见(recospec restoreActiveSession 同款)
    if (recState !== "idle") setBadge(recState);
  } catch { /* storage 异常时保持空配置, 诊断通道会暴露 */ }
})();

// 本 worker 存活期间, 域名/状态被其他页面(popup/options)修改时即时跟进
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[KEY_DOMAINS]) {
    const v = changes[KEY_DOMAINS].newValue;
    domainsCache = Array.isArray(v) ? v : [];
  }
  if (changes[KEY_REC]) {
    const v = changes[KEY_REC].newValue;
    recState = (v === "recording" || v === "paused") ? v : "idle";
  }
});

// ---- keepalive + 图标角标(recospec 同款工程实践) ----
// MV3 worker 约 30s 无活动就被杀。chrome.debugger 事件能唤醒 worker, 但唤醒后
// 已是"冷启动"——依赖 stateReady 补救。更稳的做法是录制期间用周期 alarm
// (最小粒度 0.4min)持续重置 idle 计时器, worker 全程不被杀, 事件零丢失。
chrome.alarms.onAlarm.addListener(() => { /* 命中即续命, 无需做事 */ });
function startKeepalive() {
  chrome.alarms.clear(KEEPALIVE_ALARM).catch(() => {});
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.4 }).catch(() => {});
}
function stopKeepalive() {
  chrome.alarms.clear(KEEPALIVE_ALARM).catch(() => {});
}

// 扩展图标角标: popup 关掉后, 用户看图标就知道在录/暂停(不用点开确认)
async function setBadge(state) {
  try {
    if (state === "recording") {
      await chrome.action.setBadgeText({ text: "REC" });
      await chrome.action.setBadgeBackgroundColor({ color: "#d93025" });
    } else if (state === "paused") {
      await chrome.action.setBadgeText({ text: "‖" });
      await chrome.action.setBadgeBackgroundColor({ color: "#b06000" });
    } else {
      await chrome.action.setBadgeText({ text: "" });
    }
  } catch { /* action API 不可用时静默 */ }
}

// attach 一个 tab 并启用 Network 监听
async function attachTab(tabId) {
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
    diag("info", "attach", `attach tab ${tabId} 成功`);
  } catch (e) {
    // 已附加容错必须是大小写不敏感: 真实 Chrome 对已附加的 tab 抛的是
    // "Another debugger is already attached to the target with given id"(小写 already),
    // 老版本是 "Already attached to the target with given id"(大写)—— 此前只认大写,
    // 「暂停→继续」(同 tab 二次 attach, pause 不 detach 是设计: 在途请求要照常落库)
    // 在真实 Chrome 必炸"继续录制失败"(vm stub 永远成功掩盖了此路径, #178 实锤)。
    if (!/already attached/i.test(String(e))) {
      diag("error", "attach", `attach tab ${tabId} 失败: ${String(e).slice(0, 200)}`);
      throw e; // 已附加(自己暂停后继续/其他调试工具)则复用
    }
    diag("info", "attach", `tab ${tabId} 已附加(暂停后继续或被其他工具附加), 复用`);
  }
  await chrome.debugger.sendCommand({ tabId }, "Network.enable");
  const r = await chrome.storage.local.get([KEY_TABS]);
  const tabs = Array.isArray(r[KEY_TABS]) ? r[KEY_TABS] : [];
  if (!tabs.includes(tabId)) {
    tabs.push(tabId);
    chrome.storage.local.set({ [KEY_TABS]: tabs });
  }
}

async function detachTab(tabId) {
  try { await chrome.debugger.detach({ tabId }); } catch { /* 已断开 */ }
  const r = await chrome.storage.local.get([KEY_TABS]);
  const tabs = Array.isArray(r[KEY_TABS]) ? r[KEY_TABS] : [];
  const i = tabs.indexOf(tabId);
  if (i >= 0) {
    tabs.splice(i, 1);
    chrome.storage.local.set({ [KEY_TABS]: tabs });
  }
}

async function detachAll() {
  const r = await chrome.storage.local.get([KEY_TABS]);
  for (const t of (Array.isArray(r[KEY_TABS]) ? r[KEY_TABS] : [])) {
    try { await chrome.debugger.detach({ tabId: t }); } catch { /* 忽略 */ }
  }
  try { await chrome.storage.local.set({ [KEY_TABS]: [] }); } catch { /* stopRecording 的 try/catch 接住 */ }
}

// 用户点了黄条上的"取消" / 其他扩展抢走调试器: attach 记录要同步清掉,
// 否则 popup 显示"录制中"却永远捕不到(静默失败)。
chrome.debugger.onDetach.addListener((src) => {
  if (src && src.tabId !== undefined) {
    diag("warn", "attach", `tab ${src.tabId} 调试器已分离(用户点了黄条"取消"? 或被其他工具抢走)`);
    detachTab(src.tabId);
  }
});

// ---- 请求事件 → 条目(全程同步判断, 无 await 竞态) ----
// requestWillBeSent 带 url/method/headers/postData; 响应体等 loadingFinished 后异步补。
const pending = new Map(); // requestId -> item(等响应)

function handleRequestWillBeSent(params) {
  if (recState !== "recording") return;
  const r = params.request;
  let u;
  try { u = new URL(r.url); } catch { return; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return;
  if (!matchDomain(u.hostname, domainsCache)) {
    // 诊断: 记下被过滤的主机, popup 显示"捕到了但全被域名过滤"(典型: API 走了网关域)
    if (u.hostname) {
      unmatchedHosts.set(u.hostname, (unmatchedHosts.get(u.hostname) || 0) + 1);
      // 超上限淘汰【次数最少】的而非最老的: 高频多域名页面(20+ 统计/广告域)里,
      // 请求最多的网关域是"为什么录不上"最有价值的线索, 不能因插入序早被低频域挤掉;
      // 次数并列(全 1)时遍历序=插入序, 自然退化为 FIFO —— 两语义都保住。
      while (unmatchedHosts.size > 8) {
        let minK = null, minC = Infinity;
        for (const [k, c] of unmatchedHosts) if (c < minC) { minK = k; minC = c; }
        unmatchedHosts.delete(minK);
      }
    }
    return;
  }
  // body 归一化为字符串: CDP 的 request.postData 是对象({text, params...}), 直接存对象
  // 会让所有下游(replay fetch / JMX xmlEsc / PY pyStr / AI scrubLong / correlate diff)
  // 拿到 [object Object] 或直接炸(applyDynamics text.replace) —— 必须在录制入口取 .text。
  let body = null;
  if (r.postData) {
    if (typeof r.postData === "string") body = r.postData;
    else if (typeof r.postData.text === "string") body = r.postData.text;
    else if (Array.isArray(r.postData.params)) body = r.postData.params.map((p) => `${p.name}=${p.value ?? ""}`).join("&");
  }
  const item = {
    id: "r" + Date.now() + Math.random().toString(36).slice(2, 6),
    method: r.method,
    url: r.url,
    path: u.pathname,
    query: u.search.replace(/^\?/, ""),
    headers: r.headers || {},
    body,
    status: 0,
    mime: "",
    response: null,
    ts: new Date().toISOString(),
    startTs: params.timestamp || 0, // CDP MonotonicTime, 单位【秒】(小数), 见 loadingFinished 处换算
    durationMs: 0,
  };
  pending.set(params.requestId, item);
}

chrome.debugger.onEvent.addListener((src, method, params) => {
  // 只认 attach 过的 tab(Resume 换 tab 后旧 tab 可能仍 attach 着 → 双 tab 混录)。
  // 单 tab 录制模型: KEY_TABS 里只有当前目标。
  if (!src || typeof src.tabId !== "number") return;
  chrome.storage.local.get([KEY_TABS], (r) => {
    const tabs = Array.isArray(r[KEY_TABS]) ? r[KEY_TABS] : [];
    if (!tabs.includes(src.tabId)) return;
    dispatchNetworkEvent(src, method, params);
  });
  return; // 异步分流, 不阻塞事件循环
});

function dispatchNetworkEvent(src, method, params) {
  if (method === "Network.requestWillBeSent") {
    // 冷启动窗口(域名清单还没从 storage 加载完): 缓冲, stateReady 完成后补处理
    if (domainsCache === null) { earlyBuffer.push(params); return; }
    handleRequestWillBeSent(params);
    return;
  }
  if (method === "Network.responseReceived") {
    const item = pending.get(params.requestId);
    if (!item) return;
    item.status = params.response.status;
    item.mime = params.response.mimeType || "";
    return;
  }
  if (method === "Network.loadingFinished") {
    const item = pending.get(params.requestId);
    if (!item) return;
    pending.delete(params.requestId);
    // 耗时: CDP MonotonicTime 差(单调时钟, 不受系统时钟调整影响)。
    // ⚠ 单位是【秒】(小数), 不是毫秒 —— DevTools 前端同源(har 导出也是 *1000)。
    // 字段缺失(旧 Chrome/mock)时保持 0, 列表/详情对 0 不展示。
    if (params && params.timestamp && item.startTs) {
      item.durationMs = Math.max(0, Math.round((params.timestamp - item.startTs) * 1000));
    }
    // 响应体(base64/文本)只能异步取; 取到后入列
    (async () => {
      try {
        const body = await chrome.debugger.sendCommand(src, "Network.getResponseBody", { requestId: params.requestId });
        item.response = body && body.base64Encoded ? "(binary/base64 略)" : ((body && body.body) || "").slice(0, 200000);
      } catch {
        item.response = ""; // 无 body(如 204)或已被浏览器丢弃
      }
      pushEntry(item);
    })();
    return;
  }
  if (method === "Network.loadingFailed") {
    pending.delete(params.requestId); // 失败请求(取消/断网)不录, 避免半截数据
  }
}

// ---------- 诊断环形缓冲(deepseek-pp log-buffer 模式) ----------
// 有界内存日志: 记 attach/detach/写入失败/配额裁剪等关键事件, 不落盘、不含
// payload/凭据、worker 重启即清。用户反馈"录不上"时可导出 JSON 快照, 不再靠嘴描述。
const MAX_DIAG_ENTRIES = 1000;
const MAX_DIAG_BYTES = 512 * 1024;
const diagEntries = [];
let diagBytes = 0;

function diag(level, source, message) {
  try {
    const e = { ts: Date.now(), level, source, message: String(message).slice(0, 500) };
    diagEntries.push(e);
    diagBytes += JSON.stringify(e).length;
    while (diagEntries.length && (diagEntries.length > MAX_DIAG_ENTRIES || diagBytes > MAX_DIAG_BYTES)) {
      diagBytes -= JSON.stringify(diagEntries.shift()).length;
    }
  } catch { /* 诊断自身永不影响主流程 */ }
}

// ---------- 录制数据信封编解码(deepseek-pp storage-codec 模式) ----------

// 解码存储值 → 条目数组。损坏/未知版本返回 null(调用方决定怎么呈现错误)。
function decodeHarvest(raw) {
  if (raw == null) return [];                       // 空 key = 正常空数据
  if (Array.isArray(raw)) return raw;               // v0 裸数组(旧版数据) → 原样读出, 写时升级为信封
  if (typeof raw === "object" && Array.isArray(raw.entries)) {
    if (raw.v === HARVEST_V) return raw.entries;    // 当前版本
    if (typeof raw.v === "number" && raw.v < HARVEST_V) {
      return raw.entries;                            // 旧版本 → 原样读(未来有 v2+ 时在这里做逐版迁移)
    }
    return null;                                    // 未来版本(降级场景): 不静默丢
  }
  return null;                                       // 结构损坏
}

// 条目数组 → 信封(写前先过一遍编码, encode/decode 对称校验)
function encodeHarvest(arr) {
  return { v: HARVEST_V, entries: arr };
}

// ---------- 配额预算裁剪(deepseek-pp trimToFit 模式, issue #297 教训) ----------
// chrome.storage.local 配额 10MB; 单条响应体最多 200KB, 3000 条理论上限 600MB ——
// 只限条数不限字节必然超配额, 超了之后每次 set 都抛 QUOTA_BYTES, 录制全坏。
// 策略: 序列化后超预算就逐条丢最旧的(最新一条永远保留 —— 当前这次操作不丢)。
function harvestBudgetBytes() {
  // chrome.storage.local.QUOTA_BYTES 一般 10MB(10485760); 不可用时回退该常量
  const quota = (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local.QUOTA_BYTES) || 10485760;
  return Math.floor(quota * HARVEST_BUDGET_RATIO);
}

function trimToFit(arr, budgetBytes) {
  // 先按单条均重估起点再逐条微调: 3000 条大库逐条 stringify 是 O(n²) 字节拷贝,
  // 一次估算把循环从"最多几千次全量序列化"降到"个位数"。
  const total = JSON.stringify(arr).length;
  if (total <= budgetBytes || arr.length <= 1) return arr;
  const avg = Math.max(1, Math.ceil(total / arr.length));
  let keep = Math.max(1, Math.min(arr.length, Math.floor(budgetBytes / avg) + 1));
  let candidate = arr.slice(arr.length - keep);
  while (candidate.length > 1 && JSON.stringify(candidate).length > budgetBytes) {
    candidate = candidate.slice(1); // 头部最旧, 丢头部保尾部(最新一条永远保留)
  }
  return candidate;
}

// ---------- 写入合帧(deepseek-pp coalescing-mutation-queue 模式) ----------
// 旧实现每条请求一次完整 get→push→set: 页面一次加载几十请求时, 3000 条大数组
// 被反复全量序列化(且每次都读一遍 storage)。合帧: 同一 tick 内到达的条目攒一批,
// 一次读-改-写; 首个 await 前封批 —— 异步边界之后来的进下一批, 批内 FIFO 保序,
// 批间由串行队列衔接, 不丢不重。
let pendingEntries = null;   // 当前未 flush 的攒批
let harvestQueue = Promise.resolve();

function flushEntries(items) {
  harvestQueue = harvestQueue.then(async () => {
    const r = await chrome.storage.local.get([KEY_HARVEST]);
    const decoded = decodeHarvest(r[KEY_HARVEST]);
    // 损坏数据: 不静默覆盖 —— 把旧值备份到独立 key 再重建, 用户可救回
    let arr;
    if (decoded === null) {
      diag("error", "harvest", `录制数据损坏(结构非法), 本批 ${items.length} 条先入新库; 原损坏数据已备份到 toolbox.harvest.corrupt`);
      try { await chrome.storage.local.set({ "toolbox.harvest.corrupt": r[KEY_HARVEST] }); } catch { /* 备份失败只能尽力 */ }
      arr = [];
    } else {
      arr = decoded;
    }
    for (const it of items) arr.push(it);
    // 入列序 = 响应完成序(loadingFinished 异步取回 body 后才 push), 慢快接口并发时
    // 与请求时间序错乱 —— 列表时间线、链路重放/JMX 采样器顺序都会乱。
    // ts 是 requestWillBeSent 到达时刻(ISO 串, 到达序=CDP 发序=请求发出序),
    // 每次写入前整体按 ts 稳定排序(同 ms 的并发保持入列相对序, 旧数据无 ts 排最后)。
    arr.sort((a, b) => (a.ts || "").localeCompare(b.ts || ""));
    while (arr.length > MAX_ENTRIES) arr.shift();
    // trimToFit 首行对全库 stringify, 库达 V8 单串上限(~512MB)会 RangeError —— 按不变式
    // (本函数每批裁到 ≤7.5MB)不可达, 但防御成本一屏: 不 catch 的话 rejection 沿
    // harvestQueue 链传播无人接 → **链断, 后续所有录制写入永久哑掉**(比单批丢严重得多)。
    // catch 后不裁硬写, 由下面的 storage catch 把 QUOTA 错误记进诊断。
    let trimmed = arr;
    try {
      trimmed = trimToFit(arr, harvestBudgetBytes());
    } catch (te) {
      diag("error", "harvest", "trimToFit 异常(降级为不裁硬写): " + String(te).slice(0, 200));
    }
    const dropped = arr.length - trimmed.length;
    if (dropped > 0) diag("warn", "harvest", `超存储配额预算, 丢弃最旧 ${dropped} 条(保留最新 ${trimmed.length} 条)`);
    try {
      await chrome.storage.local.set({ [KEY_HARVEST]: encodeHarvest(trimmed) });
    } catch (e) {
      diag("error", "harvest", "storage 写入失败: " + String(e).slice(0, 200));
    }
  });
  return harvestQueue;
}

function pushEntry(item) {
  if (!pendingEntries) {
    const batch = [item];
    pendingEntries = batch;
    // 微任务边界封批: 本次事件循环内后续到达的条目进同一批
    Promise.resolve().then(() => {
      pendingEntries = null;
      flushEntries(batch);
    });
  } else {
    pendingEntries.push(item);
  }
}

// tab 被关时清理。⚠ 只有被关的是录制目标 tab 才清 pending ——
// 录制 tab=A 时用户顺手关掉无关 tab B, 若无差别 pending.clear() 会把 A 的
// 在途请求(已发未完)作废, 它们的 loadingFinished 从此查不到 → 响应体静默丢失。
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.local.get([KEY_TABS], (r) => {
    const tabs = Array.isArray(r[KEY_TABS]) ? r[KEY_TABS] : [];
    if (tabs.includes(tabId)) pending.clear();
    detachTab(tabId);
  });
});
// 录制中用户切到别的 tab? 不自动跟 —— 只录开始时所在的 tab(明确可预期)。

// ---- 状态机控制(popup/面板发消息) ----
// startRecording {tabId}: attach 指定 tab 并进入 recording
//   顺序: 先 attach 成功才置状态 —— attach 失败不留"幽灵录制中"。
// stopRecording: detach 全部 + 状态回 idle(数据保留, 清空走 clearHarvest/丢弃按钮)
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "getDomains") {
    chrome.storage.local.get([KEY_DOMAINS], (r) => {
      sendResponse({ domains: Array.isArray(r[KEY_DOMAINS]) ? r[KEY_DOMAINS] : [] });
    });
    return true; // async
  }
  if (msg && msg.type === "setDomains" && Array.isArray(msg.domains)) {
    const domains = msg.domains
      .map((d) => String(d).trim().toLowerCase())
      .filter((d) => d.length > 0);
    chrome.storage.local.set({ [KEY_DOMAINS]: domains }, () => sendResponse({ ok: true }));
    return true; // async
  }
  // hostPermissions 查询(判断当前 tab 域是否已授权)
  if (msg && msg.type === "containsPermission" && msg.origin) {
    chrome.permissions.contains({ origins: [msg.origin] }, (has) => sendResponse({ has }));
    return true;
  }

  // ---- 录制控制 ----
  if (msg && msg.type === "startRecording" && typeof msg.tabId === "number") {
    (async () => {
      try {
        await stateReady;             // 等 worker 冷启动状态加载完(通常 0ms)
        await loadRuntimeState();     // 域名清单拿最新(用户可能刚在 options 改过)
        const isResume = (recState === "paused"); // 暂停→继续: 同一次录制的延续, 非新会话
        // 换 tab 开录(含 Resume 到新 tab): 先 detach 旧 tab ——
        // 否则旧 tab 仍在监听, 两边同时录, 数据互相掺杂。
        const r = await chrome.storage.local.get([KEY_TABS]);
        const oldTabs = Array.isArray(r[KEY_TABS]) ? r[KEY_TABS] : [];
        const sameTab = oldTabs.length === 1 && oldTabs[0] === msg.tabId;
        for (const t of oldTabs) {
          if (t !== msg.tabId) await detachTab(t);
        }
        // 在途请求的作废边界(#178 修复): 仅【换目标 tab】才作废 —— 同 tab 的"暂停→继续"
        // 是同一次录制的延续, 暂停语义承诺"点暂停的瞬间之前的流量不丢"(在途照常落库),
        // 继续若作废在途就与该承诺矛盾: 用户暂停几秒点继续, 恰好横跨暂停窗口的慢接口
        // 静默丢失(loadingFinished 从此查不到 pending, 半截数据蒸发)。vm 实测复现过:
        // pause 前发的 inflight 请求, 点继续后 loadingFinished 到达时 pending 已被清。
        // 换 tab 时必须清: 旧 tab 已 detach, 其 loadingFinished 永不再来, 留着是死条目。
        if (!sameTab) pending.clear();
        await attachTab(msg.tabId);   // 先 attach, 失败不进"幽灵录制中"(已附加容错见 attachTab)
        // 诊断线索同样只在真换会话时清: "暂停→继续"的 unmatched 线索属于同一次录制
        // ("刚才漏了什么域"的排查连续性), 用户没换会话就不该丢线索。
        if (!isResume || !sameTab) unmatchedHosts.clear();
        recState = "recording";
        await chrome.storage.local.set({ [KEY_REC]: "recording" });
        startKeepalive();             // 录制期间 worker 不休眠, 事件零丢失
        setBadge("recording");
        sendResponse({ ok: true });
      } catch (e) {
        // attach 失败常见于目标 tab 正被其他调试工具占用。
        // recospec content-injector 的做法是重试一次 —— 这里 attach 已带
        // "already attached" 容错(大小写不敏感), 其余失败(权限/页面类型)重试也无意义, 直接上报。
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true;
  }
  if (msg && msg.type === "pauseRecording") {
    // 与 startRecording 同语义的 try/catch(v1.0.64, #157 方向④): storage.set 抛错
    // (配额满等)时, 之前是 unhandled rejection + 调用方端口关闭错误 —— 指令已生效
    // (内存态改了)但错误被吞。对称补上: 失败也走 sendResponse({ok:false})。
    (async () => {
      try {
        recState = "paused";
        await chrome.storage.local.set({ [KEY_REC]: "paused" });
        setBadge("paused");
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true;
  }
  if (msg && msg.type === "stopRecording") {
    (async () => {
      try {
        await detachAll();
        recState = "idle";
        await chrome.storage.local.set({ [KEY_REC]: "idle" });
        stopKeepalive();               // 停止后允许 worker 休眠(不再需要保活)
        setBadge("idle");
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true;
  }
  if (msg && msg.type === "clearHarvest") {
    // 数据清空时派生结果一并失效(corrResult/aiChain/aiAsserts 都锚定旧条目下标或 id,
    // 残留会被新数据错位应用 —— aiChain 的 from/to 是下标, 清空后必错)。
    // pickIds(v1.0.78 补): #173 起勾选集持久化, 锚定条目 id —— 清单不跟上则 storage
    // 残留死勾选(发起面板的 persistPickIds 写回只兜自己, 其他面板/重开前它一直躺着)。
    chrome.storage.local.set({ [KEY_HARVEST]: encodeHarvest([]) }, () => {
      chrome.storage.local.remove(["toolbox.corrResult", "toolbox.aiChain", "toolbox.aiAsserts", "toolbox.manualPrelude", "toolbox.pickIds"], () => sendResponse({ ok: true }));
    });
    return true;
  }
  // popup/面板查询: 引擎侧条数 + "为什么录不上"诊断
  // 字段消费对账(v1.0.58, 增删字段先更新此表):
  //   count         popup(条数+按钮态) + sidepanel(tabRecN/expCount) + e2e_full_user
  //   recState      popup + sidepanel(徽章/空态分支)
  //   harvestCorrupt popup(损坏明示) + sidepanel(损坏空态)
  //   attachedTabs  sidepanel(空态"引擎未附加"分支)
  //   domains       sidepanel(空态"未配置域名/等待域"分支)
  //   unmatched     sidepanel(空态"来自未配置的域"分支) + e2e_full_user(跨域滤除断言)
  //   pending       无 UI 消费方, 是引擎内部 Map 的测试观测出口
  //                 (check_engine_edge 断言"关录制 tab 后死条目不残留") —— 删它=测试失明。
  if (msg && msg.type === "getRecInfo") {
    (async () => {
      await stateReady;
      const r = await chrome.storage.local.get([KEY_HARVEST]);
      const decoded = decodeHarvest(r[KEY_HARVEST]);
      const arr = decoded === null ? [] : decoded;
      const tabs = (await chrome.storage.local.get([KEY_TABS]))[KEY_TABS] || [];
      sendResponse({
        count: arr.length,
        pending: pending.size,
        recState,
        attachedTabs: (Array.isArray(tabs) ? tabs : []).length,
        domains: domainsCache || [],
        unmatched: [...unmatchedHosts.entries()].map(([h, c]) => `${h}×${c}`),
        harvestCorrupt: decoded === null, // 录制数据损坏(信封结构不对)→ 面板明示
      });
    })();
    return true;
  }
  // 导出诊断日志(环形缓冲快照, JSON 下载; 不含请求 payload/凭据)
  if (msg && msg.type === "getDiagLog") {
    sendResponse({ log: [...diagEntries].slice(-500) });
    return true; // async 保持一致(实际同步返回)
  }
  if (msg && msg.type === "refreshDomainCache") {
    // 兼容保留; onChanged 监听已实时跟进, 显式刷新也无害
    loadRuntimeState().then(() => sendResponse({ ok: true }));
    return true;
  }
});
