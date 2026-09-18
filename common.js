// 公共工具: popup/sidepanel/options 共用的存储与授权逻辑。
// MV3 下 content script 不能用 chrome.cookies, 全部走页面级脚本。

const KEY_DOMAINS = "toolbox.domains";
const KEY_LLM = "toolbox.llm";

// 重放/压测/导出统一剔除的"浏览器管理头"(Cookie 由浏览器/CookieManager 接管,
// sec-/UA/accept 由目标服务器环境自己协商)。四处使用: 重放、压测、JMX、PY。
const SKIP_HEADERS = ["cookie", "referer", "origin", "host", "content-length",
  "accept-encoding", "connection", "user-agent", "sec-ch-ua", "sec-ch-ua-mobile",
  "sec-ch-ua-platform", "sec-fetch-dest", "sec-fetch-mode", "sec-fetch-site",
  "sec-fetch-user", "authorization", "accept", "accept-language"];

function isSkipHeader(k) {
  return SKIP_HEADERS.includes(String(k).toLowerCase());
}

// 会话失效特征子串(单源): 生成 PY 脚本的会话过期检测、JMX 失效重登的 JSR223 检测共用。
// sidepanel 按 optAutoRelogin 开关决定是否传(关 = 不挂检测); popup 无条件传(PY 脚本自检
// 登录态是导出即用的基本保障)。改文案只动这里, 三消费方同步。
const SESSION_MARKERS = ["统一认证", "请重新登录", "用户登录"];

// 非业务条目判定(侧栏「清洗」与 JMX/PY 可执行格式导出共用的同一套规则):
//   CORS 预检(OPTIONS) / 静态资源(js/css/图片/字体) / SSE 流。
// 注意后缀表不含 .json —— 内网大量业务接口就是 /xx.json 形态, 误杀不可逆(清洗直接删数据的教训)。
const STATIC_EXT = /\.(js|css|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|eot|map)(\?|$)/i;
function isSkippable(e) {
  if (e.method === "OPTIONS") return true;                     // CORS 预检
  if (STATIC_EXT.test(e.path || "")) return true;              // 静态资源
  // SSE 流。真实条目的 SSE 信号在【响应 mime】(CDP responseReceived 的 response.mimeType,
  // 引擎存进 item.mime)——录制条目的 headers 是请求头表, 从不含响应的 Content-Type,
  // 旧行只查 headers 对引擎产出永远不命中(死分支)。headers 形态保留为兜底:
  // a) 头名大小写不敏感(HTTP 头本应如此, 旧实现的精确 'Content-Type' 查不到小写头);
  //    b) 手造/旧数据集可能把响应头并进 headers。
  const sseHdr = Object.entries(e.headers || {}).some(([k, v]) =>
    k.toLowerCase() === "content-type" && String(v).toLowerCase().includes("text/event-stream"));
  if (sseHdr || String(e.mime || "").toLowerCase().includes("text/event-stream")) return true;
  return false;
}

// 可执行格式(JMX/PY)导出集净化: 预检/静态资源/SSE 对压测与重放脚本没有意义,
// 留在 JMX 里只是污染采样器树、压测时白白打静态服务。JSONL/HAR 是数据格式, 保持全量保真。
// 返回 { entries: 保留集, dropped: 剔除数 }(调用方在状态里透明提示, 不静默改集)。
function filterSkippable(entries) {
  const keep = (entries || []).filter((e) => !isSkippable(e));
  return { entries: keep, dropped: (entries || []).length - keep.length };
}

// 完全相同请求的去重键: method+path+query+body 完全一致才算重复。
// 响应/耗时不同不是去重依据 —— 压测脚本里同一请求发一遍即可, 重复的只是页面轮询噪音
// (录制版 51 次 getByheadAndBodyParam 里 17 次请求完全重复, 响应不同但请求一字不差)。
// headers 不参与: 录制条目的 headers 常因 Cookie/时间戳微变, 参与会把"同请求"拆成"不同",
// 去重失效; 压测脚本的 headers 由 HeaderManager 统一管理, 请求唯一性只看 path/query/body。
function dedupeKey(e) {
  return (e.method || "") + " " + (e.path || "") + "?" + (e.query || "") + "#" + (e.body || "");
}

// 纯去重(保留首条)。cleanVisible 用它 + isSkippable 组合出清洗受害者集。
function dedupeIdentical(entries) {
  const seen = new Set();
  const keep = [];
  for (const e of entries || []) {
    const k = dedupeKey(e);
    if (seen.has(k)) continue;
    seen.add(k);
    keep.push(e);
  }
  return keep;
}

// CSV 数据驱动列收集: 从依赖链(aiChain + corr 合成链)抽 "被 ${var} 引用" 的变量及其录制值。
// 对标 KTKI 手写 SPM_TIKT_UAT.csv 姿势 —— 链变量(单号/ID/参数)在压测时需按行换值,
// 自动收集生成 CSV 模板(表头=var, 首行=录制值), 用户补多行即多数据驱动。
// 只收集链变量: applyCorr 的 timestamp 类已是 ${__time()} 运行时生成, 不进 CSV(每行跑都一样);
// seq/fixed 类由 linkSeqDynamics 合成链承接(origin:"corr"), 因此 csvData 取 chain 即可全覆盖。
// header. 形态(替换进头)不进 CSV —— 压测脚本头由 HeaderManager 统一管理, 单值足够。
function collectCsvData(entries, chain) {
  if (!Array.isArray(chain) || !chain.length) return [];
  const byId = new Map(entries.map((e) => [e.id, e]));
  const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const out = [];
  const seenVar = new Set();
  for (const c of chain) {
    if (seenVar.has(c.var)) continue;
    const to = c.toId != null ? byId.get(c.toId) : (c.to >= 0 && c.to < entries.length ? entries[c.to] : null);
    if (!to) continue;
    const toParam = String(c.toParam || "");
    if (/^header\./i.test(toParam)) continue; // 头参数不进 CSV(HeaderManager 单值语义)
    const leaf = toParam.split(".").pop().replace(/\s/g, "");
    if (!leaf) continue;
    let val = "";
    if (/^url\./i.test(toParam)) {
      let m = new RegExp(`(^|&)${esc(leaf)}=([^&]*)`).exec(to.query || "");
      if (m) val = m[2];
      else {
        m = new RegExp(`/${esc(leaf)}/([^/?]+)`).exec(to.url || "");
        if (m) val = m[1];
      }
    } else {
      // JSON body: "leaf": "value"(链替换端只改 body 叶子, 值与录制同形)
      let m = new RegExp(`"${esc(leaf)}"\\s*:\\s*"([^"]*)"`).exec(to.body || "");
      if (m) val = m[1];
      else {
        m = new RegExp(`(^|&)${esc(leaf)}=([^&]*)`).exec(to.body || "");
        if (m) val = m[2];
      }
    }
    // 防御: 取值若已是 ${var} 形态(调用方误传了 applyAiChainToJmx 替换后的 entries),
    // 说明这是替换产物不是录制值 —— 跳过该列(宁缺毋滥, CSV 列引用占位符无意义)。
    // 正确时序: collectCsvData 在 applyAiChainToJmx 之前调(取录制值), 之后调会拿到占位符。
    if (/^\$\{[^}]*\}$/.test(val)) continue;
    seenVar.add(c.var);
    out.push({ var: c.var, default: val });
  }
  return out;
}

// Node 单测通道(test_regression.js 直 require): 浏览器页面 <script> 加载时此块不执行,
// 页面用顶层 function 全局共享; 只导出纯函数(storage/chrome 依赖的留在页面侧)。
// applyCorr 依赖 correlate.js 的 applyDynamics/applyDynamicsToQuery(页面里同页全局可解析;
// node 里是模块作用域, 须先 require("./correlate.js") 把两函数挂上 —— 与 script 标签同语义)。
if (typeof module !== "undefined" && module.exports) {
  const _corr = require("./correlate.js"); // 幂等: correlate.js 自身也 require 兼容
  applyDynamics = _corr.applyDynamics;
  applyDynamicsToQuery = _corr.applyDynamicsToQuery;
  module.exports = { isSkipHeader, isSkippable, filterSkippable, decodeHarvest, normalizeEntry,
    toJsonl, stamp, harvestToExportRows, harQueryString, buildHar, applyCorr, applyAiChainToJmx,
    dedupeKey, dedupeIdentical, collectCsvData };
}

// 读取已配置域名清单
async function getDomains() {
  return new Promise((resolve) => {
    chrome.storage.local.get([KEY_DOMAINS], (r) => {
      resolve(Array.isArray(r[KEY_DOMAINS]) ? r[KEY_DOMAINS] : []);
    });
  });
}

// ---------- LLM 配置 ----------
// url: OpenAI 兼容端点(完整路径); model: 模型名; api_key: 可空(本地/自建代理不需要)
// 默认: 本地代理 127.0.0.1:8787 + qwen3.7-plus(options 页可换成任意 OpenAI 兼容端点)。
async function getLlmConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get([KEY_LLM], (r) => {
      const c = r[KEY_LLM] || {};
      resolve({
        url: c.url || "http://127.0.0.1:8787/v1/chat/completions",
        model: c.model || "qwen3.7-plus",
        api_key: c.api_key || "", // 可空
      });
    });
  });
}

async function setLlmConfig(cfg) {
  return new Promise((resolve) => {
    chrome.storage.local.set({
      [KEY_LLM]: { url: cfg.url || "", model: cfg.model || "", api_key: cfg.api_key || "" },
    }, () => resolve(true));
  });
}

// 调 LLM(OpenAI chat/completions 兼容协议)。
// 返回 {ok, content} / {ok:false, error}。异常不抛出, 调用方按需展示。
// 注意: 不带 X-User-Id(避免个人账号被某些网关拦截); api_key 为空则不发 Authorization。
// 超时: 默认 120s(思考模型长输出留余量), AbortController —— 网关假活/静默挂起时
// UI 不至于永远停在"分析中…"(qwen-intl 假 token 挂起 60s 看门狗同款教训)。
// opts.urlOverride/apiKey: options「测试连接」用输入框当前值(未保存的配置也测得到),
// 不传时走 storage 已保存配置(侧栏/popup 全部 AI 功能的语义)。
async function callLlm(messages, opts = {}) {
  const cfg = await getLlmConfig();
  const url = opts.urlOverride || cfg.url;
  const apiKey = opts.apiKey !== undefined ? opts.apiKey : cfg.api_key;
  if (!url) return { ok: false, error: "未配置 LLM 地址(options 页)" };
  const body = {
    model: opts.model || cfg.model,
    messages,
    temperature: opts.temperature ?? 0.2,
    stream: false,
  };
  if (opts.max_tokens) body.max_tokens = opts.max_tokens;
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = "Bearer " + apiKey;
  const timeoutMs = opts.timeoutMs ?? 120000;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    clearTimeout(timer);
    const j = await r.json();
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}: ${JSON.stringify(j).slice(0, 300)}` };
    const content = (j.choices || [{}])[0].message?.content
      ?? (j.choices || [{}])[0].message?.text ?? "";
    if (!content) return { ok: false, error: "LLM 返回空内容(模型名或端点不对?)" };
    return { ok: true, content };
  } catch (e) {
    clearTimeout(timer);
    // 超时单独给话(网关假活/思考模型卡死时用户最需要知道"等了多久、还能怎么办")
    if (e && (e.name === "AbortError" || /aborted/i.test(String(e)))) {
      return { ok: false, error: `LLM ${Math.round(timeoutMs / 1000)}s 无响应已中止(网关挂起或模型卡死? 可重试; 长流量可先过滤缩小集)` };
    }
    // Failed to fetch 有两大根因, 不区分会让用户瞎猜:
    //   a) 扩展未授权该主机(optional_host_permissions 默认全无, 只在 options「保存」时 request)
    //   b) 服务没启动 / 端口路径不对(本地代理常见)
    // 失败后补查一次授权状态, 给出可区分的提示。
    let host = "";
    try { host = new URL(url).hostname; } catch { /* 上面已保证合法, 此处兜底 */ }
    const granted = await containsOrigin(`http://${host}/*`).catch(() => false)
      .then(async (h) => h || await containsOrigin(`https://${host}/*`));
    if (!granted) {
      return { ok: false, error: `调用失败: 未授权主机 ${host} —— 扩展无权访问它。请到配置页「保存」一次以授权(本地代理同理); 或检查 LLM 地址是否填错。` };
    }
    const local = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|::1)$/i.test(host);
    const hint = local
      ? `本地服务(${host || "localhost"})没启动, 或端口/路径不对`
      : `连接 ${host || "LLM"} 失败(服务在运行吗? 端点 URL 对不对?)`;
    return { ok: false, error: "调用失败: " + hint + " —— " + String(e) };
  }
}

// 保存域名清单
async function setDomains(domains) {
  const list = domains
    .map((d) => String(d).trim().toLowerCase())
    .filter((d) => d.length > 0);
  return new Promise((resolve) => {
    chrome.storage.local.set({ [KEY_DOMAINS]: list }, () => resolve(list));
  });
}

// 把 "example.com" / "https://sub.example.com" 等输入归一化为 origin 通配符
// "example.com" -> "https://*.example.com/*" + "http://*.example.com/*"
// "sub.example.com" -> "https://sub.example.com/*" + "http://sub.example.com/*"
// "localhost" -> "https://localhost/*" + "http://localhost/*"(无点单段: *.host 不匹配裸主机, 必须精确)
function domainToOrigins(input) {
  const host = String(input).trim().toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^(\*\.)?/, "")
    .replace(/\/.*$/, "");
  if (!host) return [];
  // 无点单段主机(localhost 等): 通配符 *.host 匹配不了裸 host, 精确授权
  if (!host.includes(".")) return [`https://${host}/*`, `http://${host}/*`];
  // 顶级域/多级域都按 *.host 授权, 覆盖所有子域; 单主机则精确授权
  if (host.split(".").length <= 2) {
    return [`https://*.${host}/*`, `http://*.${host}/*`];
  }
  return [`https://${host}/*`, `http://${host}/*`];
}

// 申请一组 origin 的 host 权限(须由用户手势触发, 即按钮点击事件内调用)
async function requestOrigins(origins) {
  return new Promise((resolve) => {
    chrome.permissions.request({ origins }, (granted) => {
      resolve(!!granted);
    });
  });
}

async function containsOrigin(origin) {
  return new Promise((resolve) => {
    chrome.permissions.contains({ origins: [origin] }, (has) => resolve(!!has));
  });
}

// 撤销一组 origin 授权
async function removeOrigins(origins) {
  return new Promise((resolve) => {
    chrome.permissions.remove({ origins }, (removed) => resolve(!!removed));
  });
}

// 下载文本文件(扩展页面通用)
function downloadText(filename, text, mime = "application/json") {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 1000);
}

// JSONL 数组 -> 文本
function toJsonl(arr) {
  return arr.map((x) => JSON.stringify(x)).join("\n") + "\n";
}

// ---------- 录制数据的共享读取/导出辅助(popup 快速导出与 sidepanel 导出页共用) ----------
// 注意: background.js 是独立 realm, 有自己的 decodeHarvest, 与此无关。

// 数据信封(v0.3.6+): { v: 1, entries: [...] }; 旧版裸数组自动兼容;
// 结构损坏 → 返回 null 显式报错不静默丢(deepseek-pp storage-codec 模式)。
function decodeHarvest(raw) {
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "object" && Array.isArray(raw.entries) && typeof raw.v === "number") return raw.entries;
  return null;
}

// 兼容旧数据: 某版本曾把 CDP 的 postData 对象({text,params})直接存进 body ——
// 所有下游(replay/JMX/PY/AI/correlate)都假设字符串, 读取时归一化。
function normalizeEntry(e) {
  if (e && e.body != null && typeof e.body === "object") {
    if (typeof e.body.text === "string") e.body = e.body.text;
    else if (Array.isArray(e.body.params)) e.body = e.body.params.map((p) => `${p.name}=${p.value ?? ""}`).join("&");
    else e.body = "";
  }
  return e;
}

// 读取全部录制条目(信封解码 + body 归一化); 损坏返回 [](快速通道不展示损坏详情, 侧栏有专属提示)
async function loadHarvestEntries() {
  const r = await chrome.storage.local.get(["toolbox.harvest"]);
  const decoded = decodeHarvest(r["toolbox.harvest"]);
  return decoded === null ? [] : decoded.map(normalizeEntry);
}

// 导出文件名时间戳: 20260917T153000 形态(无冒号, Windows 文件名安全)
function stamp() {
  return new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
}

// 录制条目 -> iserver harvest 同构的 JSONL 行
// mime/ts/durationMs 是保真字段(v1.0.57 补): check_export_fields 的差异表一直声称 JSONL
// 消费这三字段, 但行里没有 —— AI 工具链/人工分析拿不到耗时与时间戳, "哪个接口慢"要回侧栏看。
// 新增键向后兼容(消费方按键取值, 多键无感); id 不导(行内不稳定标识, 工具链不需要)。
// response 不截断(v1.0.70): 同为"保真格式"与 HAR 的 content.text 同口径(入库已在引擎侧
// 截 200KB, 这里再截 4000 是 v0.x 遗留 —— 200KB 大响应在 JSONL 里只剩前 4000 字符,
// 与 HAR 产物对不上, AI 工具链分析大响应时后段静默丢失)。
function harvestToExportRows(arr) {
  return arr.map((e) => ({
    t: "req", method: e.method, url: e.url,
    headers: e.headers || {}, post: e.body || "",
    status: e.status, response: e.response || "",
    mime: e.mime || "", ts: e.ts || "", durationMs: e.durationMs || 0,
  }));
}

// query 串 → HAR queryString 数组(URLSearchParams 解析, 空串返回 [])
function harQueryString(q) {
  if (!q) return [];
  return [...new URLSearchParams(q)].map(([name, value]) => ({ name, value }));
}

// 录制条目 -> HAR 1.2
// required 字段按 spec 补齐(cookies/headersSize/redirectURL/httpVersion); durationMs 是
// 已录数据, 填进 entries.time 与 timings.wait(HAR 语义: -1 = N/A, 未知字段不猜)。
// startedDateTime: ts 缺失(旧数据/极端)时给空串而非 undefined —— undefined 经 JSON.stringify
// 会整键消失, HAR 校验器按"缺 required"拒收。
function buildHar(entries) {
  return {
    log: {
      version: "1.2",
      creator: { name: "web-toolbox", version: "1.0" },
      entries: entries.map((e) => {
        const dur = (typeof e.durationMs === "number" && e.durationMs >= 0) ? e.durationMs : -1;
        return {
          startedDateTime: e.ts || "",
          time: dur,
          request: {
            method: e.method, url: e.url, httpVersion: "HTTP/1.1",
            headers: Object.entries(e.headers || {}).map(([name, value]) => ({ name, value })),
            queryString: harQueryString(e.query),
            cookies: [],
            postData: e.body ? { mimeType: (e.headers || {})["Content-Type"] || "application/json", text: e.body } : undefined,
            headersSize: -1,
            bodySize: -1,
          },
          response: {
            status: e.status, statusText: "",
            httpVersion: "HTTP/1.1",
            headers: [],
            cookies: [],
            content: { text: e.response || "", mimeType: e.mime || "" },
            redirectURL: "",
            headersSize: -1,
            bodySize: -1,
          },
          cache: {},
          timings: { send: -1, wait: dur, receive: -1 },
        };
      }),
    },
  };
}

// 自动关联结果应用到条目(JMX 导出前参数化): corrResult 显式传入(popup/sidepanel 各自持有)
function applyCorr(entries, corrResult) {
  if (!corrResult || !corrResult.groups || !corrResult.groups.length) return entries;
  return entries.map((e) => {
    const g = corrResult.groups.find((x) => x.method === e.method && x.path === e.path);
    if (!g) return e;
    return { ...e,
      body: applyDynamics(e.body || "", g.dynamics),
      query: applyDynamicsToQuery(e.query || "", g.dynamics) };
  });
}

// AI 依赖链应用到 JMX 导出集:
//   1. from 采样器挂 JSONPath 提取器(_extractor → JSONPostProcessor, jmx.js 已支持)
//   2. to 采样器的 body/query 对应参数替换成 ${var} —— JMeter 循环内取 live 值, 与重放注入同语义
// corrResult(时间戳参数化)先跑, aiChain 后跑 —— 前者纯文本替换, 后者带提取器, 顺序无冲突。
function applyAiChainToJmx(entries, chain) {
  if (!Array.isArray(chain) || !chain.length) return entries;
  const out = entries.map((e) => ({ ...e }));
  const byId = new Map(out.map((e, i) => [e.id, i]));
  const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const c of chain) {
    // 定位: 优先 id(建链快照), 下标兜底旧数据; 源不在集/顺序倒了 → 该链跳过(JMeter 里乱挂必错)
    let fi = c.fromId != null ? byId.get(c.fromId) : (c.from >= 0 && c.from < out.length ? c.from : -1);
    let ti = c.toId != null ? byId.get(c.toId) : (c.to >= 0 && c.to < out.length ? c.to : -1);
    if (fi == null || fi < 0 || ti == null || ti < 0 || fi >= ti) continue;
    const from = out[fi], to = out[ti];
    // 1) from 挂提取器: fromJsonPath a.b.0.c → $.a.b[0].c(JMeter JSONPath 语法)。
    //    同一 from 可能被多条链引用(不同字段) → 收集成数组, jmx.js 逐个生成 JSONPostProcessor。
    const jp = "$" + c.fromJsonPath.split(".").filter(Boolean).map((s) => (/^\d+$/.test(s) ? `[${s}]` : `.${s}`)).join("");
    from._extractors = (from._extractors || []).concat([{ var: c.var, expr: jp, default: "NOT_FOUND" }]);
    // 2) to 的参数替换成 ${var}: 与 applyAiChain.inject 的三种 toParam 形态对齐
    const target = c.toParam || "";
    if (/^header\./i.test(target)) {
      const k = target.slice(7);
      if (k) to.headers = { ...(to.headers || {}), [k]: "${" + c.var + "}" };
    } else if (/^url\./i.test(target)) {
      const k = target.slice(4);
      const re = new RegExp(`(^|&)${esc(k)}=[^&]*`);
      if (to.query && re.test(to.query)) {
        to.query = to.query.replace(re, (_m, p1) => `${p1}${k}=\${${c.var}}`);
      } else {
        const segRe = new RegExp(`/${esc(k)}/[^/?]+`);
        if (segRe.test(to.url || "")) to.url = to.url.replace(segRe, `/${k}/\${${c.var}}`);
        else if (to.url && to.url.includes(k + "=")) to.url = to.url.replace(new RegExp(`(^|&|\\?)${esc(k)}=[^&]*`), (_m, p1) => `${p1}${k}=\${${c.var}}`);
      }
    } else {
      const leaf = target.split(".").pop().replace(/\s/g, "");
      if (leaf) {
        const le = esc(leaf);
        // JSON body: "leaf": "..." / 裸值 → ${var}(带引号, JMeter 函数返回字符串)
        let hit = false;
        to.body = (to.body || "").replace(new RegExp(`"${le}"\\s*:\\s*"[^"]*"`), () => { hit = true; return `"${leaf}": "\${${c.var}}"`; });
        if (!hit) to.body = to.body.replace(new RegExp(`"${le}"\\s*:\\s*[0-9A-Za-z_.-]+`), () => { hit = true; return `"${leaf}": "\${${c.var}}"`; });
        // 表单体 k=v / query 参数: 用函数式替换防 $& 展开
        if (!hit) to.body = to.body.replace(new RegExp(`(^|&)${le}=[^&]*`), (_m, p1) => { hit = true; return `${p1}${leaf}=\${${c.var}}`; });
        else {
          const qRe = new RegExp(`(^|&)${le}=[^&]*`);
          if (qRe.test(to.query || "")) to.query = to.query.replace(qRe, (_m, p1) => `${p1}${leaf}=\${${c.var}}`);
        }
      }
    }
  }
  return out;
}
