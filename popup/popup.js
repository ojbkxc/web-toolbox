// popup = 快速操作闭环: 录制控制 + 一键导出(全量) + 打开侧栏。
// 列表过滤/勾选/前置/重放/冒烟/AI 等工作台能力都在侧栏。
// 导出语义: 全量条目(popup 无过滤状态, 不该有半套语义); 需挑条目请开侧栏勾选。

const $ = (id) => document.getElementById(id);

let recState = "idle";
let entryCount = 0;
let siteReady = true; // 当前 tab 域名已配置(默认 true: refresh 判定前不藏按钮, 防闪)
let currentHost = null; // 当前 tab 的 hostname(refresh 判定用, onAddSite 申请与判定同源)

// 域名覆盖判定: 与 background.js 引擎 matchDomain 同语义(host === d || host.endsWith("." + d))
// —— popup realm 加载不到 background.js, 这里同款实现; 引擎认 "midea.com 覆盖 icsuat.midea.com",
// popup 也必须认, 否则会出现"引擎录得上、popup 却藏按钮"的口径分叉。
function hostCoveredBy(host, domains) {
  return (domains || []).some((d) => host === d || host.endsWith("." + d));
}

function setState(st) {
  recState = st;
  const badge = $("stBadge");
  const label = $("stLabel");
  const map = { idle: ["idle", "IDLE"], recording: ["rec", "REC"], paused: ["pause", "PAUSE"] };
  const [cls, txt] = map[st] || map.idle;
  badge.className = "badge " + cls;
  label.textContent = txt;

  // 未配置当前域名时藏"开始"入口(用户心智: 域名没配, 开始录了也全被过滤丢掉);
  // 但停止/暂停/继续永远显示 —— "点了开始就必须永远能点停止"(换 tab 后必须能停,
  // 不能因当前 tab 换到了未配置域而藏掉停止按钮, 否则录制永远停不下来)。
  const recording = (st === "recording" || st === "paused");
  $("btnRecord").style.display = (!recording && siteReady) ? "" : "none";
  $("btnStop").style.display = recording ? "" : "none";
  $("btnPause").style.display = (st === "recording") ? "" : "none";
  $("btnResume").style.display = (st === "paused" && siteReady) ? "" : "none";
  syncExportButtons();
}

// 有数据才可导出(空态禁用而非点了报错 —— 按钮状态即指引);
// 未配置当前域名时整组隐藏(与录制按钮同门槛 —— 域名未配时导出同样无从谈起)。
// 但已有录制数据时导出与域名无关(数据在库里, 换 tab 不影响导出) —— 只有"空库 +
// 域名未配"才藏; 数据已有时保留导出(用户换了 tab 也可能就是来导出的)。
function syncExportButtons() {
  const has = entryCount > 0;
  const show = siteReady || has;
  $("expCount").style.display = show ? "" : "none";
  for (const id of ["btnExpJmx", "btnExpPy", "btnExpJsonl", "btnExpHar", "btnExpAll"]) {
    $(id).style.display = show ? "" : "none";
    if (!show) continue;
    $(id).disabled = !has;
  }
  if (!show) return;
  $("expCount").textContent = entryCount;
  $("expCount").style.color = "";
}

async function refreshSafe() {
  // refresh() 的调用点大多不在可接 promise 的上下文(顶层加载/onChanged 回调/
  // setTimeout 回调), tabs.query 等 API 异常若不在这接住就是 unhandled rejection ——
  // popup 无日志面用户看不到, UI 停在上一次的态。接住后静默降级: 保持当前呈现,
  // 下次用户手势(按钮点开/操作/推送)会再触发重拉, 状态自愈。
  try { await refresh(); } catch { /* 保持当前 UI 态, 下次触发重拉 */ }
}
async function refresh() {
  let st = "idle";
  let count = 0;
  let corrupt = false;
  try {
    const info = await chrome.runtime.sendMessage({ type: "getRecInfo" });
    if (info) {
      st = (info.recState === "recording" || info.recState === "paused") ? info.recState : "idle";
      count = info.count || 0;
      corrupt = !!info.harvestCorrupt;
    }
  } catch {
    const r = await chrome.storage.local.get(["toolbox.recording"]);
    st = (r["toolbox.recording"] === "recording" || r["toolbox.recording"] === "paused") ? r["toolbox.recording"] : "idle";
    // 直读兜底分支不走引擎, 自己 decode 一次以判损坏(主路径 getRecInfo 会带到)
    const all = await chrome.storage.local.get(["toolbox.harvest"]);
    const decoded = decodeHarvest(all["toolbox.harvest"]);
    corrupt = decoded === null;
    count = decoded === null ? 0 : decoded.length;
  }
  if (count !== entryCount) { entryCount = count; syncExportButtons(); }
  setState(st);
  // 损坏信封明示(与侧栏同语义): 数据存在但结构非法(已在引擎侧隔离备份)。
  // 不明示的话 count=0 + 按钮禁用会被误读成"没录上", 用户重录覆盖就真丢数据了。
  if (corrupt && siteReady) {
    $("expCount").textContent = "⚠ 录制数据损坏, 已隔离(开侧栏看详情)";
    $("expCount").style.color = "#b06000";
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const site = $("site");
  let host = null;
  if (tab && tab.url && /^https?:/i.test(tab.url)) {
    host = new URL(tab.url).hostname;
  }
  if (host) {
    // 双面判定: 清单覆盖(引擎 matchDomain 同语义) + 授权真实在(containsOrigin)。
    // 只查清单不查授权会出现"清单有但授权被用户在 chrome://settings 撤了"的假就绪。
    const domains = await getDomains();
    const covered = hostCoveredBy(host, domains);
    const origins = domainToOrigins(host);
    const grantedOk = origins.length ? await Promise.all(origins.map(containsOrigin)) : [false];
    const ready = covered && grantedOk.some(Boolean);
    currentHost = host; // onAddSite 消费(判定与申请同源, 不走 DOM 反解)
    if (ready !== siteReady) { siteReady = ready; setState(recState); }
    site.innerHTML = ready
      ? `当前标签页: <b>${host}</b><span class="sp"></span><span class="ready">✓ 已配置</span>`
      : `当前标签页: <b>${host}</b><span class="sp"></span><button class="addsite" id="btnAddSite" aria-label="一键配置并授权当前域名 ${host}">＋ 添加此域名</button>`;
    const addBtn = $("btnAddSite");
    if (addBtn) addBtn.onclick = onAddSite;
  } else {
    currentHost = null;
    site.textContent = "当前标签页: 非 http(s) 页面";
    if (!siteReady) { siteReady = true; setState(recState); }
  }
}

// 一键添加当前域名: permissions.request 必须手势内同步发起(前面垫任何 await 手势
// 即失效, 弹窗不弹 granted 静默 false —— v1.0.9 实锤教训, 与 options addDomain 同款)。
// host 走 refresh 存下的 currentHost(判定用的就是它, 申请与判定同源)。
function onAddSite() {
  const host = currentHost;
  if (!host) return;
  chrome.permissions.request({ origins: domainToOrigins(host) }, (granted) => {
    if (!granted) return;
    (async () => {
      const list = await getDomains();
      if (!hostCoveredBy(host, list)) await setDomains([...list, host]);
      refreshSafe();
    })();
  });
}

async function currentTab() {
  const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
  return t || null;
}

// ---------- 一键导出(全量语义) ----------
// popup 与侧栏共享 common.js 的导出辅助; 关联结果从 storage 取(侧栏分析的成果这里直接生效)。
// 结果反馈走 expCount 行内提示而非 alert —— popup 关闭前用户需要看到结果,
// alert 会阻塞且样式突兀; 按钮空态已禁用, "没数据"分支只是兜底。
async function quickExport(fmts) {
  const entries = await loadHarvestEntries();
  if (!entries.length) { setExpNote("还没有录制数据", "err"); return; }
  const corr = (await chrome.storage.local.get(["toolbox.corrResult"]))["toolbox.corrResult"] || null;
  // AI 依赖链(侧栏建链成果)同样生效: 提取器 + ${var} 参数化, 与侧栏导出同语义
  const chain = (await chrome.storage.local.get(["toolbox.aiChain"]))["toolbox.aiChain"] || null;
  const out = [];
  const errs = [];
  // JMX/PY 导出净化(与侧栏同一套规则, common.js): 预检(OPTIONS)/静态资源/SSE 对
  // 压测与重放脚本没有意义, 自动剔除并透明提示; JSONL/HAR 是数据格式, 保真全量。
  const { entries: cleanSet, dropped } = filterSkippable(entries);
  for (const f of fmts) {
    try {
      if (f === "jsonl") out.push({ name: `harvest_${stamp()}.jsonl`, data: toJsonl(harvestToExportRows(entries)), mime: "application/json" });
      if (f === "har") out.push({ name: `harvest_${stamp()}.har`, data: JSON.stringify(buildHar(entries), null, 2), mime: "application/json" });
      if (f === "jmx") {
        // 前置识别走自动结果(auth.js 规则表), 不读侧栏的手动覆盖(那属于工作台能力)
        const auto = autoDetectPrelude(cleanSet);
        // v1.0.84: 轻量自动关联 + AI 链合并, AI 不可用时轻量检测仍能产出 JSONPostProcessor + CSV
        const mergedChain = mergeChain(autoDetectChain(cleanSet), chain);
        const jmxApplied = applyAiChainToJmx(applyCorr(cleanSet, corr), mergedChain);
        // CSV 数据驱动(v1.0.82): popup 一键导出同样生成 data.csv + JMX 引用 ——
        // 依赖链变量(单号/ID)压测时按行换值; 无链时为空, 不生成 CSVDataSet。
        // collectCsvData 在 applyAiChainToJmx 之前调(取录制值, 不是 ${var} 占位符)。
        const csvData = collectCsvData(cleanSet, mergedChain);
        out.push({ name: `webtoolbox_${stamp()}.jmx`,
          data: buildJmx(jmxApplied, {
            title: "web-toolbox " + new Date().toISOString().slice(0, 16).replace("T", " "),
            prelude: auto.ids.size ? [...auto.ids] : null,
            csvData,
            csvFileName: `data_${stamp()}.csv`,
          }), mime: "application/xml" });
        if (csvData.length) out.push({ name: `data_${stamp()}.csv`, data: csvTemplateText(csvData), mime: "text/csv" });
      }
      if (f === "py") out.push({ name: `replay_${stamp()}.py`, data: buildPyScript(cleanSet, "cookies.state.json", { sessionMarkers: SESSION_MARKERS, aiChain: chain }), mime: "text/x-python" });
    } catch (err) {
      errs.push(`${f}: ${err.message}`);
    }
  }
  if (!out.length) { setExpNote("导出失败: " + errs.join("; "), "err"); return; }
  for (const f of out) downloadText(f.name, f.data, f.mime);
  setExpNote(`✓ 已下载 ${out.length} 个文件` + (dropped ? ` (JMX/PY 剔除 ${dropped} 条预检/静态资源)` : "") + (errs.length ? `(${errs.length} 个失败)` : ""), errs.length ? "err" : "ok");
}

// 导出结果行内提示(写在 expCount 位置, 3s 后还原成条数)
function setExpNote(text, cls) {
  const el = $("expCount");
  el.textContent = text;
  el.style.color = cls === "err" ? "#d93025" : cls === "ok" ? "#188038" : "";
  // 无 clearTimeout 守卫是有意的: 快速连点导出排多个 3s 定时器, 每个 refresh 幂等,
  // 重复还原成条数无副作用; popup 关闭时 Chrome 静默销毁全部定时器, 无泄漏面。
  // 走 refreshSafe: setTimeout 回调里 refresh 的 rejection 无人接。
  setTimeout(() => { refreshSafe(); }, 3000);
}

$("btnExpJmx").onclick = () => quickExport(["jmx"]);
$("btnExpPy").onclick = () => quickExport(["py"]);
$("btnExpJsonl").onclick = () => quickExport(["jsonl"]);
$("btnExpHar").onclick = () => quickExport(["har"]);
$("btnExpAll").onclick = () => quickExport(["jsonl", "jmx", "py"]);

// ---------- 侧栏 / 配置入口 ----------
$("openPanel").onclick = async () => {
  const t = await currentTab();
  if (t && t.id) {
    await chrome.sidePanel.open({ tabId: t.id }).catch(() => {});
  } else {
    await chrome.sidePanel.open({ windowId: chrome.windows.WINDOW_ID_CURRENT }).catch(() => {});
  }
  window.close();
};

// ---------- 录制控制 ----------
// 非 http(s) 页面(chrome:// 设置页等)无法附加调试器 —— 前置拦截, 提示比报错友好。
const isRecordable = (t) => !!(t && t.url && /^https?:/i.test(t.url));
$("btnRecord").onclick = async () => {
  const t = await currentTab();
  if (!t || !t.id) { alert("找不到当前标签页"); return; }
  if (!isRecordable(t)) { alert("当前页面不是 http(s), 无法录制。\n请先切到目标系统页面。"); return; }
  const r = await chrome.runtime.sendMessage({ type: "startRecording", tabId: t.id });
  if (!r || !r.ok) {
    alert("开始录制失败: " + ((r && r.error) || "未知") +
      "\n\n若提示无法附加调试器, 请确认没有其他调试工具(如抓包软件)正占用该页面。");
    return;
  }
  refreshSafe();
};
$("btnPause").onclick = async () => {
  await chrome.runtime.sendMessage({ type: "pauseRecording" });
  refreshSafe();
};
$("btnResume").onclick = async () => {
  const t = await currentTab();
  if (!t || !t.id) { alert("找不到当前标签页"); return; }
  if (!isRecordable(t)) { alert("当前页面不是 http(s), 无法录制。\n请先切到目标系统页面。"); return; }
  const r = await chrome.runtime.sendMessage({ type: "startRecording", tabId: t.id });
  if (!r || !r.ok) alert("继续录制失败: " + ((r && r.error) || "未知"));
  refreshSafe();
};
$("btnStop").onclick = async () => {
  await chrome.runtime.sendMessage({ type: "stopRecording" });
  refreshSafe();
};
$("opt").onclick = () => chrome.runtime.openOptionsPage();

// ---------- 状态推送(onChanged 替代 1s 轮询) ----------
// popup 是短命窗口(点开才存在), 打开时主动 refresh 一次拿全量(状态+条数+当前站点),
// 之后靠 storage 推送: toolbox.recording → setState; toolbox.harvest → 条数;
// toolbox.domains → refresh(siteReady 门槛要跟清单变更走 —— 用户在 options 删了
//   当前域名, popup 还开着的话录制按钮必须立即藏回去, 否则点了录制全被过滤丢掉)。
// 1s setInterval 的代价: popup 开着的每秒一次 sendMessage + tabs.query, 完全冗余
// —— 信号源都已有 onChanged 推送, 轮询只在消息通道死锁时有意义, 而那种场景
// refresh 的 catch 分支(storage 直读)才是真正兜底, 轮询反而把通道死锁掩盖成静默正常。
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes["toolbox.recording"]) {
    const v = changes["toolbox.recording"].newValue;
    setState((v === "recording" || v === "paused") ? v : "idle");
  }
  if (changes["toolbox.harvest"]) {
    const decoded = decodeHarvest(changes["toolbox.harvest"].newValue);
    if (decoded !== null) { // 损坏信封(decoded===null)不动条数, 保持按钮态
      entryCount = decoded.length;
      syncExportButtons();
    }
  }
  if (changes["toolbox.domains"]) {
    refreshSafe(); // 重判 siteReady(清单增删都重算覆盖关系 + site 行呈现); 回调上下文无人接 rejection
  }
});

syncExportButtons();
refreshSafe();
