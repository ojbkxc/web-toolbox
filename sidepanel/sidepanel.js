// 侧栏: 录制控制 + 请求列表/详情 + 重放/冒烟 + Cookie 桥 + 导出(JSONL/HAR/JMX/PY) + AI 报告。
// 唯一工作台(popup 只做快速操作: 录制控制 + 一键全量导出), 全程不需要 DevTools:
//   · 重放/冒烟 用 chrome.scripting.executeScript(MAIN world) 在页面上下文执行
//     → 依赖域名已授权(未授权时给可操作提示)。
//   · 录制引擎在 background(chrome.debugger), 本页只做控制与展示, 状态/数据经 storage.onChanged 实时同步。

const $ = (id) => document.getElementById(id);

let entries = [];           // {id, method, url, path, query, headers, body, status, response, mime, ts}
let selectedId = null;
let cookies = [];
let corrResult = null;
let tab = null;             // 当前活动 tab(点击 Record/导出 Cookie 时实时取)
let authOk = false;
let viaParent = null;
let preludeIds = new Set();      // 登录前置条目的 id(自动识别 + 手动覆盖合并后的最终结果)
let manualPrelude = new Map();   // id -> bool: 用户手动覆盖(强制前置/强制非前置), 优先于自动识别

const STORE_KEY = "toolbox.harvest";

// 单条看门狗 60s: replay.js 的单源常量(脚本链在 replay.js 之后加载, 页面全局可解析);
// 链路重放与引擎兜底同值 —— 改超时只动 replay.js 一处(replayFn 体内字面量除外, 见其注释)。
const SINGLE_TIMEOUT_MS_OUTER = (typeof SINGLE_TIMEOUT_MS !== "undefined") ? SINGLE_TIMEOUT_MS : 60000;

// 慢阈值口径(v1.0.57 钉死): >SLOW_MS 标红(超时嫌疑)、>MID_MS 标黄(偏慢)。
// 列表(L255)与详情(L454)两处消费, 必须同值 —— 不同值会让"列表看着正常、点开详情
// 却标慢"或反之, 用户无法信任任一个。抽成常量单源, 未来调阈值只动这里。
// 注意: replay 冒烟的 P99 统计是"压测口径"(test/check_replay_smoke.js, 统计学量),
// 与这里的"单条 UX 标色"是两个语义, 不共用此常量、也不同源。
const SLOW_MS = 3000, MID_MS = 1000;

// ---------- 状态徽章 + 录制控制 ----------
const REC_IDLE = "idle", REC_ON = "recording", REC_PAUSED = "paused";
let recState = REC_IDLE;

function setState(st) {
  recState = st;
  const badge = $("stBadge");
  const label = $("stLabel");
  const map = {
    [REC_IDLE]: ["idle", "IDLE"],
    [REC_ON]: ["rec", "REC"],
    [REC_PAUSED]: ["pause", "PAUSE"],
  };
  const [cls, txt] = map[st] || map[REC_IDLE];
  badge.className = "badge " + cls;
  label.textContent = txt;

  $("btnStart").style.display = st === REC_IDLE ? "" : "none";
  $("btnPause").style.display = st === REC_ON ? "" : "none";
  $("btnResume").style.display = st === REC_PAUSED ? "" : "none";
  // 重录按钮: 录制中(含暂停)常驻 —— 点它=清空本轮重来, 是"重新录制"的显式入口
  // (此前旧数据一直躺着, 用户不知道要先停+清才能重录)。idle 时不需要(直接 ● Record 即可)。
  $("btnRerecord").style.display = (st === REC_ON || st === REC_PAUSED) ? "" : "none";
  $("btnStop").style.display = st === REC_ON || st === REC_PAUSED ? "" : "none";
}

// ---------- Tab 切换 ----------
// aria-selected 与 class active 同步: class 只是视觉, 读屏用户要听"当前在哪个页"
// (role=tab 的选中态语义由 aria-selected 承载, 不是 CSS 类)。
// 切 tab 统一走 activate(t): onclick / 箭头键盘都进同一函数, 单源。
function activate(t) {
  document.querySelectorAll(".tab").forEach((x) => { x.classList.remove("active"); x.setAttribute("aria-selected", "false"); });
  document.querySelectorAll(".page").forEach((x) => x.classList.remove("active"));
  t.classList.add("active");
  t.setAttribute("aria-selected", "true");
  $("pg" + t.dataset.tab[0].toUpperCase() + t.dataset.tab.slice(1)).classList.add("active");
  if (t.dataset.tab === "ck") loadCookiesForActiveTab();
}
document.querySelectorAll(".tab").forEach((t) => {
  t.onclick = () => activate(t);
  // WAI-ARIA tabs pattern 键盘契约: 左右箭头在 tab 间移动并激活(自动激活模式——
  // 面板内容轻量无需"焦点移动+单独确认"两步), Home/End 跳首尾; 循环(末端右箭头回首)。
  // 读屏用户在 tablist 内默认用箭头导航, 只有 onclick 时方向键无响应是 pattern 违约。
  // roving tabindex 无需管理: 三 tab 都是原生 button(天然可聚焦), 无多余 Tab 停留点,
  // 箭头移动后 focus() 已把焦点送到目标 tab——roving 的"单一 Tab 停留点"目标天然满足。
  t.onkeydown = (ev) => {
    const tabs = Array.from(document.querySelectorAll(".tab"));
    const i = tabs.indexOf(ev.currentTarget);
    let j = -1;
    if (ev.key === "ArrowRight") j = (i + 1) % tabs.length;
    else if (ev.key === "ArrowLeft") j = (i - 1 + tabs.length) % tabs.length;
    else if (ev.key === "Home") j = 0;
    else if (ev.key === "End") j = tabs.length - 1;
    if (j < 0) return;
    ev.preventDefault();
    tabs[j].focus();
    activate(tabs[j]);
  };
});

// ---------- 活动 tab ----------
async function currentTab() {
  const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
  return t || null;
}

// ---------- 录制状态拉取(打开/操作后主动调用) + storage 推送同步 ----------
async function refreshState() {
  let st = REC_IDLE;
  try {
    const info = await chrome.runtime.sendMessage({ type: "getRecInfo" });
    if (info) {
      st = (info.recState === REC_ON || info.recState === REC_PAUSED) ? info.recState : REC_IDLE;
      const n = info.count || 0;
      $("tabRecN").textContent = n ? ` ${n}` : "";
      $("expCount").textContent = n;
      updateEmptyHint(info); // "录不上"的空态直接写明原因
    }
  } catch {
    const r = await chrome.storage.local.get(["toolbox.recording"]);
    st = (r["toolbox.recording"] === REC_ON || r["toolbox.recording"] === REC_PAUSED) ? r["toolbox.recording"] : REC_IDLE;
  }
  setState(st);
}

async function currentTabId() {
  const t = await currentTab();
  return (t && t.id) || null;
}

// 非 http(s) 页面(chrome:// 设置页等)无法附加调试器 —— 前置拦截, 与 popup 同规则。
const isRecordable = (t) => !!(t && t.url && /^https?:/i.test(t.url));
$("btnStart").onclick = async () => {
  const t = await currentTab();
  if (!t || !t.id) { setRecStatus("找不到当前标签页", "err"); return; }
  if (!isRecordable(t)) { setRecStatus("当前页面不是 http(s), 无法录制。切到目标系统页再开始。", "err"); return; }
  const r = await chrome.runtime.sendMessage({ type: "startRecording", tabId: t.id });
  if (!r || !r.ok) {
    setRecStatus("开始录制失败: " + ((r && r.error) || "未知"), "err");
    return;
  }
  refreshState();
};
$("btnPause").onclick = async () => {
  await chrome.runtime.sendMessage({ type: "pauseRecording" });
  refreshState();
};
$("btnResume").onclick = async () => {
  const t = await currentTab();
  if (!t || !t.id) { setRecStatus("找不到当前标签页", "err"); return; }
  if (!isRecordable(t)) { setRecStatus("当前页面不是 http(s), 无法录制。切到目标系统页再继续。", "err"); return; }
  const r = await chrome.runtime.sendMessage({ type: "startRecording", tabId: t.id });
  if (!r || !r.ok) setRecStatus("继续录制失败: " + ((r && r.error) || "未知"), "err");
  refreshState();
};
$("btnStop").onclick = async () => {
  await chrome.runtime.sendMessage({ type: "stopRecording" });
  refreshState();
};

// 重录(↻ 重录): 停止当前录制 → 丢弃已录数据 → 立即开始新一轮(同 tab)。
// 用户"录完导出后要重新录制"的显式入口 —— 此前旧数据一直躺着, 没有"边录边清"的手势,
// 重新录制要先停再开导出页找「🗑 丢弃」再回来, 入口难找。这里把整条路径做成一个按钮。
$("btnRerecord").onclick = async () => {
  const t = await currentTab();
  if (!t || !t.id) { setRecStatus("找不到当前标签页", "err"); return; }
  if (!isRecordable(t)) { setRecStatus("当前页面不是 http(s), 无法录制。切到目标系统页再重录。", "err"); return; }
  const n = entries.length;
  if (n && !confirm(`重录将丢弃已录 ${n} 条并停止当前录制, 立即开始新一轮。确定?`)) return;
  // 停止(清 attach + 状态回 idle) → 清数据(clearHarvest 连带派生键全清, onChanged 清空分支
  // 同步本地态) → 同一 tab 开录。失败任一步都给出明确提示, 不留"幽灵录制中"。
  const rs = await chrome.runtime.sendMessage({ type: "stopRecording" });
  if (!rs || !rs.ok) { setRecStatus("停止失败: " + ((rs && rs.error) || "未知"), "err"); return; }
  await chrome.runtime.sendMessage({ type: "clearHarvest" });
  const r = await chrome.runtime.sendMessage({ type: "startRecording", tabId: t.id });
  if (!r || !r.ok) { setRecStatus("重录失败: " + ((r && r.error) || "未知"), "err"); return; }
  setRecStatus("↻ 已清空并重新开始录制", "ok");
  refreshState();
};

// ---------- 请求列表 ----------
// 过滤词: 空格分词, 每词须命中(path 或 method 或 status)——AND 语义。
// 纯数字词支持比较语法: "500"=等于, ">=400"/">400"/"<300"=范围 —— 找失败请求不用数状态码。
// 只影响显示与导出(导出集=可见集), 录制永远全录。
let filterKw = [];
// 勾选模式状态(声明提前到使用点之前: renderList/togglePick 都引用)
let pickMode = false;
let pickIds = new Set();
function matchFilter(e) {
  if (!filterKw.length) return true;
  const hay = (e.path + " " + e.method + " " + e.status).toLowerCase();
  return filterKw.every((k) => {
    const cmp = k.match(/^(>=|<=|>|<)(\d+)$/);
    if (cmp) {
      const v = e.status, n = Number(cmp[2]);
      if (cmp[1] === ">=") return v >= n;
      if (cmp[1] === "<=") return v <= n;
      if (cmp[1] === ">") return v > n;
      return v < n;
    }
    return hay.includes(k);
  });
}
function visibleEntries() { return entries.filter(matchFilter); }
function setFilter(q) {
  filterKw = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  updateScopeHint();
  renderList();
}

// ---------- 清洗(预检/静态资源/重复) ----------
// isSkippable/STATIC_EXT/dedupeIdentical 由 common.js 提供(勿重复声明) —— 与 JMX/PY
// 导出净化同一套规则 + 完全相同请求去重(v1.0.82): 录制 177 条里 51 次 getByheadAndBodyParam
// 有 17 次请求完全重复(path/query/body 一字不差), 页面轮询噪音, 压测脚本里是采样器冗余。
// 清洗: 从 entries 移除可见集里 isSkippable 的条目 + method+path+query+body 完全相同的
// 重复请求(保留首条); 同步清理关联的前置标记。
// 删的是真实数据(storage 同步覆盖), 故先 confirm 列明细 —— 不可撤销。
function cleanVisible() {
  const vis = visibleEntries();
  const victims = vis.filter(isSkippable);
  const deduped = dedupeIdentical(vis);
  const dupes = vis.length - deduped.length;
  const delIds = new Set();
  if (victims.length) for (const e of victims) delIds.add(e.id);
  if (dupes) {
    // 去重受害者: 可见集里被 dedupeIdentical 剔除的条目(保留首条的 dedupeKey 命中集合)
    const seen = new Set();
    for (const e of vis) {
      const k = dedupeKey(e);
      if (seen.has(k)) { delIds.add(e.id); }
      else seen.add(k);
    }
  }
  const n = delIds.size;
  if (!n) { setRecStatus("无可清洗条目", "ok"); return; }
  const sample = victims.slice(0, 5).map((e) => e.method + " " + e.path).join("\n  ");
  const dupNote = dupes ? `\n  · 重复请求 ${dupes} 条(完全相同)已并入` : "";
  if (!confirm(`移除 ${n} 条预检/静态资源${dupes ? `/重复请求` : ""}?不可撤销。\n  ${sample}${n > 5 ? "\n  …" : ""}${dupNote}`)) return;
  const selIdx = entries.findIndex((e) => e.id === selectedId);
  entries = entries.filter((e) => !delIds.has(e.id));
  // 勾选集同清(#173 复选框全量修复): 此前只清 preludeIds/manualPrelude, pickIds 残留
  // 死 id → "✓ 已选 N" 计数虚高、exportSet 语义漂移(与 removeOne 的 pickIds.delete 不对称)
  for (const id of delIds) { preludeIds.delete(id); manualPrelude.delete(id); pickIds.delete(id); }
  if (manualPrelude) persistManualPrelude();
  persistPickIds();
  if (delIds.has(selectedId)) { selectedId = null; ensureSelection(selIdx); updateTrimUi(); }
  // AI 依赖链的 from/to 是旧数组下标 —— 删条目后必错位, 直接失效(避免注入到错接口)
  if (aiChain && aiChain.length) {
    aiChain = null;
    chrome.storage.local.remove("toolbox.aiChain", () => {});
  }
  persistEntries();
  setRecStatus(`✂ 已移除 ${n} 条可清洗请求(预检/静态资源${dupes ? " + 重复请求" : ""})。`, "ok");
  renderList();
}
$("btnClean").onclick = cleanVisible;

// 空列表提示: 把"为什么录不上"直接说出来(引擎诊断通道, 修"静默录不上")
let emptyHint = "暂无录制。<br>点上方 ● Record 开始。";
function updateEmptyHint(info) {
  let h;
  if (info.harvestCorrupt) {
    h = "⚠ 录制数据损坏, 已隔离(备份在 toolbox.harvest.corrupt)。<br>新条目会写入新库。";
  } else if (info.recState === REC_ON && !(info.attachedTabs > 0)) {
    h = "⚠ 引擎未附加标签页(点了黄条\"取消\"? 页面已关?)。<br>■ Stop 后重新 Record。";
  } else if (info.recState === REC_ON && !info.count) {
    const domains = info.domains || [];
    const unmatched = info.unmatched || [];
    if (!domains.length) {
      h = "⚠ 未配置域名, 捕到也全丢。<br>点 ⚙ 配置。";
    } else if (unmatched.length) {
      h = `捕到了, 但来自未配置的域:<br><b>${escHtml(unmatched.join(", "))}</b><br>去 ⚙ 配置加上。`;
    } else {
      h = `录制中, 等 <b>${escHtml(domains.join(", "))}</b> 的请求。<br>去页面操作, 回来看。`;
    }
  } else if (info.recState === REC_PAUSED && !info.count) {
    h = "已暂停, 未录到数据。点 ▶ 继续。";
  } else {
    h = "暂无录制。<br>点上方 ● Record 开始。";
  }
  if (h !== emptyHint) {
    emptyHint = h;
    if (!entries.length) renderList();
  }
}

function renderList() {
  const list = $("list");
  const detail = $("detail");
  const vis = visibleEntries();
  $("tabRecN").textContent = entries.length ? ` ${entries.length}` : "";
  $("visN").textContent = filterKw.length ? `可见 ${vis.length}/${entries.length}` : "";
  $("visCount").textContent = vis.length;
  if (!entries.length) {
    list.innerHTML = `<div class="empty">${emptyHint}</div>`;
    detail.innerHTML = `<div class="empty">← 点一条请求看详情</div>`;
    return;
  }
  list.innerHTML = "";
  const frag = document.createDocumentFragment();
  if (!vis.length) {
    list.innerHTML = `<div class="empty">过滤词滤掉了全部 ${entries.length} 条。<br>清空或改词。</div>`;
    return;
  }
  // 有数据未选中(#173 详情区不空屏): 详情区渲染录制摘要, "← 点一条请求看详情"
  // 只在真零数据时出现 —— 有数据时详情区也有可读内容(总数/失败/慢请求一眼速览)。
  if (selectedId == null || !entries.some((x) => x.id === selectedId)) {
    const fails = entries.filter((e) => e.status >= 400).length;
    const slow = entries.filter((e) => (e.durationMs || 0) > SLOW_MS).length;
    detail.innerHTML = `<div class="empty">← 点左侧请求看详情<br><br>共 <b>${entries.length}</b> 条${fails ? ` · <span style="color:#d93025">失败 ${fails}</span>` : ""}${slow ? ` · <span style="color:#b06000">慢 ${slow}</span>` : ""}</div>`;
  }
  for (const e of [...vis].reverse()) {
    const div = document.createElement("div");
    div.className = "req" + (e.id === selectedId ? " sel" : "");
    const hasDyn = corrResult && corrResult.groups.some((g) => g.method === e.method && g.path === e.path);
    const isPre = preludeIds.has(e.id);
    const pickMark = pickMode && pickIds.has(e.id) ? '<span class="dyn" style="color:#188038" title="已选入导出集">●</span>' : "";
    // 耗时: >SLOW_MS 标红(超时嫌疑), >MID_MS 标黄(慢); 状态码颜色分级一眼挑出失败请求。
    // durationMs/status 裸进 innerHTML 不走 escHtml 的威胁模型(v1.0.60 固化): 两者是"引擎保证
    // 数字"字段 —— durationMs 唯一赋值点 background.js 引擎节 Math.max(0, Math.round(...))
    // 恒非负数, status 是 CDP 状态码; 字符串形态仅"手改 storage"可达, 与空 url 坏条目
    // (v1.0.26 #118)同口径: 该用户有能力自定位, normalizeEntry 加防御反而静默模糊问题。
    // 区别于 receiptNote(v1.0.16 #105): 那是 AI 产出可被 prompt 注入诱导, 必须转义。
    // 真值字段(shortPath/url/body)走 escHtml 护住 —— 数字约定字段裸拼是既定取舍。
    const ms = e.durationMs || 0;
    const msTitle = ms ? `${ms}ms` : "";
    const msHtml = ms ? `<span class="dur${ms > SLOW_MS ? " slow" : ms > MID_MS ? " mid" : ""}" title="${msTitle}">${ms > 9999 ? (ms / 1000).toFixed(0) + "s" : ms + "ms"}</span>` : "";
    const stCls = e.status >= 500 ? "s5" : e.status >= 400 ? "s4" : e.status >= 200 && e.status < 300 ? "s2" : "";
    // 先一次性写 innerHTML, 再 appendChild 事件节点:
    // innerHTML += 会整串重新解析, 之前 append 的 checkbox 被"重建"且 DOM onclick 属性
    // 不进序列化 → 勾选框点了没反应、还冒泡成"选中条目"(实测踩过)。
    div.innerHTML = `<span class="m ${e.method}">${e.method}</span><span class="u">${escHtml(shortPath(e))}</span>${pickMark}${isPre ? '<span class="dyn" style="color:#1a73e8" title="登录前置">🔐</span>' : (hasDyn ? '<span class="dyn">⚡</span>' : "")}${msHtml}<span class="st ${stCls}">${e.status}</span>`;
    // 键盘可达性: title 只有鼠标 hover 能读; aria-label 屏幕阅读器/键盘聚焦时朗读。
    // role="button" + tabindex 让条目本身可 Tab 聚焦, Enter 触发选择(等价 div.onclick)。
    // Tab 停留点膨胀是已记录取舍: 30 条录制=30 个 Tab 停留点, 键盘用户过列表要按 30 次。
    // roving tabindex(方向键在条目间移动, 只一条 tabindex=0)不引入: ① 列表是筛选/回查用,
    //    键盘主线是 Tab 进列表 → 顺路听几条 → Enter 选; 方向键另起一套心智负担比 30 次 Tab 更重;
    //    ② 30 条是 v1.0.11 性能底线场景, 每条 tabindex=-1 只省 Tab 数不省渲染, 收益仅键盘过长;
    //    ③ checkbox 必须保持可聚焦(v1.0.42 取舍), roving 后条目与 checkbox 的焦点接力复杂度激增。
    // shortPath 是用户数据但走 setAttribute(DOM 属性 API 不解析实体)——纯文本属性, 无注入面;
    // 对比上面 innerHTML 模板里的 shortPath 已过 escHtml —— 那是 innerHTML 注入面, 通道不同防护不同。
    div.setAttribute("role", "button");
    div.setAttribute("tabindex", "0");
    div.setAttribute("aria-label", `${e.method} ${shortPath(e)} 状态 ${e.status}`);
    div.onkeydown = (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); select(e.id); } };
    // 勾选模式: checkbox = 选条目进导出集; 普通模式: checkbox = 登录前置标记
    // Tab 序: 条目(tabindex=0)与 checkbox 各占一个 Tab 停留点 → 键盘过一条要按两次。
    // checkbox 本是鼠标批操作件, 键盘选条目走条目自身(Enter/Space)——把它移出 Tab 序
    // (tabindex=-1, 仍可点击/程序聚焦), 每条一个 Tab 停留点; 勾选操作键盘走 Space 于条目内
    // 不可达时, 保留 checkbox 可聚焦性成本(两次 Tab)优于可达性损失——不降, 只记录设计取舍。
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.style.marginRight = "6px";
    if (pickMode) {
      cb.checked = pickIds.has(e.id);
      cb.title = "勾选进导出集(导出/关联/AI 只作用于勾选)";
      cb.setAttribute("aria-label", `勾选 ${e.method} ${shortPath(e)} 进导出集`);
      cb.onclick = (ev) => { ev.stopPropagation(); togglePick(e.id); };
    } else {
      cb.checked = isPre;
      cb.title = "登录前置请求 → 导出 JMX 时包进仅一次控制器";
      cb.setAttribute("aria-label", `把 ${e.method} ${shortPath(e)} 标为登录前置`);
      cb.onclick = (ev) => { ev.stopPropagation(); togglePrelude(e.id); };
    }
    div.insertBefore(cb, div.firstChild);
    div.onclick = () => select(e.id);
    frag.appendChild(div);
  }
  list.appendChild(frag);
}

// ---------- 导出集勾选(选择模式) ----------
// 勾选优先: 有勾选条目时导出/关联/AI 只用勾选集; 否则用过滤可见集。
// 勾选集持久化(#173 复选框全量修复): 侧栏一关 pickIds 全丢, 与 manualPrelude 持久化
// 不对称 —— 用户勾了几十条业务接口, 重开侧栏逐条重勾是实打实的数据丢失。
const KEY_PICK_IDS = "toolbox.pickIds";
function persistPickIds() {
  // 只在勾选模式内持久化(退出模式本就清空); 死 id 无害: exportSet 按 entries 过滤,
  // 不存在的 id 自然不进集, 下次 loadHarvest 后真实条目仍还原。
  if (pickMode) chrome.storage.local.set({ [KEY_PICK_IDS]: [...pickIds] }, () => {});
  else chrome.storage.local.remove(KEY_PICK_IDS, () => {});
}
function togglePickMode() {
  pickMode = !pickMode;
  if (!pickMode) pickIds = new Set();
  $("btnPick").classList.toggle("pri", pickMode);
  $("btnPick").textContent = pickMode ? `✓ 已选 ${pickIds.size}` : "☐ 勾选";
  $("btnPickAll").style.display = pickMode ? "" : "none";
  persistPickIds();
  updateScopeHint();
  updateTrimUi(); // 勾选模式进出会改变"起点是否在导出集内"的判定 → 提示须同步
  renderList();
}
// 勾选模式下的全选/反选: 可见集一键入集/一键清空(勾几十条业务接口不用逐条点)
function togglePickAll() {
  const vis = visibleEntries();
  // 空可见集护栏: [].every() === true, 原实现会走"全清"分支提示"退回可见集 0 条" ——
  // 用户在重过滤词下点全选, 收到的是误导性提示(实际一条都没勾上/没清掉)。明说空集。
  if (!vis.length) { setRecStatus("可见集为空(过滤词滤掉了全部条目), 无可全选。先清空或改过滤词。", ""); return; }
  const allIn = vis.every((e) => pickIds.has(e.id));
  if (allIn) {
    for (const e of vis) pickIds.delete(e.id);
    // 全清后 exportSet 退回可见集(空勾选集 ≠ 导出空集)——明说, 防止用户以为"导出会得到空集"
    setRecStatus(`已清空勾选 —— 导出/关联/AI 退回可见集 ${vis.length} 条(空勾选不是导出空集)`, "");
  } else {
    for (const e of vis) pickIds.add(e.id);
    setRecStatus(`已选全部可见 ${vis.length} 条`, "ok");
  }
  $("btnPick").textContent = `✓ 已选 ${pickIds.size}`;
  persistPickIds();
  updateScopeHint();
  updateTrimUi(); // 全选/全清同样改变"起点是否在勾选集内"判定 —— 与 togglePick/togglePickMode 同步
  renderList();
}
function togglePick(id) {
  if (pickIds.has(id)) pickIds.delete(id); else pickIds.add(id);
  $("btnPick").textContent = pickMode ? `✓ 已选 ${pickIds.size}` : "☐ 勾选";
  persistPickIds();
  updateScopeHint();
  updateTrimUi(); // 勾/退单条也改变"起点是否在勾选集内"判定 —— 不补这行 trimNote 会陈旧(掩盖于测试手动调 updateTrimUi)
  renderList();
}
// 导出/关联/AI 统一入口: 勾选优先, 否则可见集
function exportSet() {
  if (pickMode && pickIds.size) return entries.filter((e) => pickIds.has(e.id));
  return visibleEntries();
}
function updateScopeHint() {
  const scope = pickMode && pickIds.size ? `勾选 ${pickIds.size} 条` : `可见 ${visibleEntries().length} 条`;
  $("expScope").innerHTML = `已录 <b>${entries.length}</b> 条 · 可见 <b>${visibleEntries().length}</b> 条 → 导出/关联/AI 取<b>${scope}</b>。格式:`;
}
$("btnPick").onclick = togglePickMode;
$("btnPickAll").onclick = togglePickAll;

// 手动切换某条是否前置(自动识别可被覆盖, 覆盖结果持久到 manualPrelude 不随 auto 重扫丢失)
function togglePrelude(id) {
  const next = !preludeIds.has(id);
  manualPrelude.set(id, next);
  persistManualPrelude();
  if (next) preludeIds.add(id); else preludeIds.delete(id);
  updatePreludeUi();
  renderList();
}

// 手动覆盖持久化: manualPrelude 是模块变量, 侧栏一关就丢 ——
// 用户在 10 条登录链上逐条勾的前置标记, 重开侧栏全部还原是实打实的数据丢失。
const KEY_MANUAL_PRELUDE = "toolbox.manualPrelude";
function persistManualPrelude() {
  chrome.storage.local.set({ [KEY_MANUAL_PRELUDE]: [...manualPrelude.entries()] }, () => {});
}

// 自动识别登录前置 + 合并手动覆盖, 刷新 UI。
// 手动覆盖优先: 被用户明确取消(强制非前置)的条目, 不再被 auto 重新勾上。
function refreshPrelude() {
  const auto = autoDetectPrelude(entries);
  const merged = new Set();
  for (const e of entries) {
    const manual = manualPrelude.get(e.id);
    if (manual === true) merged.add(e.id);
    else if (manual === false) { /* 用户强制非前置, 跳过 */ }
    else if (auto.ids.has(e.id)) merged.add(e.id);
  }
  preludeIds = merged;
  updatePreludeUi();
  renderList();
}

function updatePreludeUi() {
  const n = preludeIds.size;
  const el = $("preludeHint");
  const cnt = $("preludeCount");
  if (!el) return;
  if (n) { el.style.display = ""; cnt.textContent = n; }
  else { el.style.display = "none"; }
  updateCsvUi();
}

// CSV 数据驱动提示(v1.0.82): 依赖链变量数决定是否显示「数据驱动」行。
// 链变量来自 aiChain(AI 建链 + corr 合成链) + 轻量自动关联(v1.0.84)。无链时无数据可驱动 → 隐藏, 不空占一行。
function updateCsvUi() {
  const el = $("csvHint");
  if (!el) return;
  const cols = collectCsvData(exportSet(), mergeChain(autoDetectChain(exportSet()), aiChain || []));
  const cnt = $("csvCount");
  if (cols.length) {
    el.style.display = "";
    cnt.textContent = cols.length;
  } else {
    el.style.display = "none";
  }
}

// 起点裁剪提示: 选中一条时显示 trimHint(从这条开始导), 取消选中隐藏
function updateTrimUi() {
  const el = $("trimHint");
  if (!el) return;
  const e = entries.find((x) => x.id === selectedId);
  if (e) {
    el.style.display = "";
    $("trimFrom").textContent = `${e.method} ${e.path}`;
    // 两类"不会裁剪"边界都要明示(v1.0.42):
    // ① optTrim 被手动关 → 已选起点但开关关, 本次导出不裁(否则"从 X 开始导出"文案在
    //    开关关闭后陈旧误导); ② 勾选模式下起点不在勾选集内 → 裁剪在勾选集内找起点,
    //    静默不裁(免得用户勾了 {a,c} 却选着 b 时疑惑"起点怎么没生效")。
    // off 优先于 pick 注: 开关关时"任何勾选形态都不裁"是终态结论(修开关是唯一出路),
    // 双提示叠加只会稀释行动指引, 不并列。
    const off = $("optTrim") && !$("optTrim").checked
      ? " (注意: 起点开关已关闭, 本次导出不会裁剪)" : "";
    const note = off || (pickMode && pickIds.size && !pickIds.has(selectedId)
      ? " (注意: 该起点不在勾选集内, 导出时不会裁剪)" : "");
    const noteEl = $("trimNote");
    if (noteEl) noteEl.textContent = note;
  }
  else { el.style.display = "none"; }
}

function shortPath(e) {
  return e.path + (e.query ? "?" + e.query.slice(0, 30) : "");
}

// 选中态保底(#173 详情区不空屏): 选中条被删/被清后按原位置就近补选, 而不是退回空态。
// idx 是被删条【删除前】在 entries 里的下标(取不到时传 -1)—— 剩余列表同位置的前一条
// 语义上最接近被删条(时间序相邻), 删第一条则选新的首条。列表全空才真的回空态。
function ensureSelection(idx) {
  if (!entries.length) { selectedId = null; renderDetail(); return; }
  const fallback = entries[Math.max(0, Math.min(idx, entries.length - 1))];
  selectedId = fallback ? fallback.id : null;
  renderDetail();
  updateTrimUi();
}

function select(id) {
  selectedId = id;
  renderList();
  renderDetail();
  updateTrimUi();
  // 读屏焦点语义: 键盘 Enter 选中后焦点仍停在列表条目上, 读屏用户不知道详情区已更新。
  // detail 挂 polite 播报详情首行(方法+路径+状态)——焦点不抢(抢焦点会把 Tab 序打散,
  // 条目间连续浏览被中断), 用播报告知"详情已换"。aria-selected 变化由 renderList 重渲染
  // 的 .sel 类承载视觉, 播报走这里。
  const sel = entries.find((x) => x.id === id);
  if (sel && $("detail")) {
    const ann = $("detailAnn");
    if (ann) ann.textContent = `已选中 ${sel.method} ${shortPath(sel)} 状态 ${sel.status}`;
  }
}

function renderDetail() {
  const e = entries.find((x) => x.id === selectedId);
  const detail = $("detail");
  if (!e) {
    // 有数据但未选中 → 摘要形态(renderList 同款); 真零数据 → 初始指引。
    if (entries.length) {
      const fails = entries.filter((x) => x.status >= 400).length;
      const slow = entries.filter((x) => (x.durationMs || 0) > SLOW_MS).length;
      detail.innerHTML = `<div class="empty">← 点左侧请求看详情<br><br>共 <b>${entries.length}</b> 条${fails ? ` · <span style="color:#d93025">失败 ${fails}</span>` : ""}${slow ? ` · <span style="color:#b06000">慢 ${slow}</span>` : ""}</div>`;
    } else {
      detail.innerHTML = `<div class="empty">← 点一条请求看详情</div>`;
    }
    return;
  }
  const bizHeaders = Object.entries(e.headers)
    .filter(([k]) => !isSkipHeader(k))
    .map(([k, v]) => `${k}: ${v}`).join("\n");
  const dynInfo = corrResult && corrResult.groups.find((g) => g.method === e.method && g.path === e.path);
  // 按钮态反映"裁剪真会生效"(选中 + optTrim 开 + 起点在导出集内)——与 updateTrimUi 的
  // trimNote 同一套判定: ① optTrim 关 → 普通态(点了就开); ② 勾选模式下起点不在勾选集内 →
  // pri 高亮是假象(实际不裁), title 警示与 trimNote 同文案, 避免按钮态与真实效果背离。
  const trimOff = !!$("optTrim") && !$("optTrim").checked;
  const trimOutsidePick = pickMode && pickIds.size && !pickIds.has(selectedId);
  const isTrimActive = !!e && !trimOff && !trimOutsidePick;

  detail.innerHTML = `
    <div class="kv"><h4 id="kv-url">URL</h4><pre aria-labelledby="kv-url">${escHtml(e.url)}</pre></div>
    ${(e.durationMs ? `<div class="kv"><h4 id="kv-dur">耗时</h4><div class="badge-txt" aria-labelledby="kv-dur">${e.durationMs}ms${e.durationMs > SLOW_MS ? ' <span style="color:#d93025">⚠ 慢</span>' : e.durationMs > MID_MS ? ' <span style="color:#b06000">偏慢</span>' : ""}</div></div>` : "")}
    ${/* durationMs 裸拼同列表: 引擎保证数字, 威胁模型见 renderList 耗时构造区注释(v1.0.60) */ ""}
    ${dynInfo ? `<div class="kv"><h4 id="kv-dyn">动态字段</h4><div class="badge-txt" style="color:#b06000" aria-labelledby="kv-dyn">已识别 ${dynInfo.dynamics.length} 处(导出 JMX 时参数化)</div></div>` : ""}
    <div class="kv"><h4>业务头(Cookie 除外, 每行 k: v)</h4><textarea id="dHeaders" aria-label="业务头, 每行一个 k: v, 可编辑后重放">${escHtml(bizHeaders || "(无)")}</textarea></div>
    <div class="kv"><h4>请求体(可编辑后重放)</h4><textarea id="dBody" aria-label="请求体, 可编辑后重放">${escHtml(e.body || "")}</textarea></div>
    <div class="kv">
      <div class="acts">
        <button class="btn pri" id="replay" aria-label="重放这条请求(页面上下文, Cookie 最新)">▶ 重放</button>
        <button class="btn warn" id="loadtest" title="页面上下文快速并发验证(会话新鲜); 严肃压测请导 JMX" aria-label="冒烟压测这条请求(快速并发验证)">🔥 冒烟</button>
        <button class="btn" id="aiDiag" aria-label="AI 诊断这条请求的失败原因">🩺 AI 诊断</button>
        <button class="btn" id="curl" title="复制为 curl 命令(可在终端直接重放/贴给同事)" aria-label="复制这条请求为 curl 命令">📋 cURL</button>
        <button class="btn" id="delOne" title="从录制中删除这一条(不可撤销)" aria-label="从录制中删除这一条, 不可撤销">🗑 删除</button>
        <button class="btn${isTrimActive ? " pri" : ""}" id="setTrim" title="${isTrimActive ? "这条已是导出起点(选中即起点); 开关在「导出」页" : trimOutsidePick ? "这条不在勾选集内, 勾选模式导出不会裁剪(先勾选它或退出勾选模式)" : trimOff ? "把这条设为导出起点(裁掉它之前的条目); 开关在「导出」页顶部" : "把这条设为导出起点(裁掉它之前的条目); 开关在「导出」页顶部"}" aria-label="${isTrimActive ? "这条已是导出起点, 开关在导出页" : trimOutsidePick ? "设为导出起点, 但当前不在勾选集内, 勾选模式导出不会裁剪" : "把这条设为导出起点, 裁掉它之前的条目"}">${isTrimActive ? "✂ 已是起点" : "✂ 起点"}</button>
        <span class="badge-txt" id="replayMsg"></span>
      </div>
    </div>
    ${e.aiDiagnosis ? `<div class="kv"><h4 id="kv-diag">AI 诊断</h4><pre aria-labelledby="kv-diag">${escHtml(e.aiDiagnosis)}</pre></div>` : ""}
    <div class="kv"><h4 id="kv-resp">响应</h4><pre id="dResp" aria-labelledby="kv-resp" data-status="${e.status} ${escHtml(e.mime || "")}">${escHtml((e.response || "").slice(0, 20000))}</pre></div>
    <div class="badge-txt err" id="replayErr" role="alert"></div>`;

  $("replay").onclick = () => replay(e);
  $("loadtest").onclick = () => showLoadTest(e);
  $("aiDiag").onclick = () => aiDiagnose(e);
  $("curl").onclick = () => copyCurlFor(e);
  $("delOne").onclick = () => removeOne(e);
  // ✂ 起点: 选中即已是起点(select/updateTrimUi 链), 按钮价值是跨页指引 ——
  // 点击确认 + 切到导出页(开关在导出页顶部, 用户不点就永远不知道去哪找)。
  // 强制置 on: 用户点了"起点"按钮就是想要裁剪, 即使之前手动关过 optTrim 也直接开 ——
  // 点按钮的意图覆盖旧开关态, 不该让用户再自己去导出页开一遍。
  $("setTrim").onclick = () => {
    if ($("optTrim")) $("optTrim").checked = true;
    setRecStatus(`✓ 已设为导出起点: ${e.method} ${e.path} —— 开关在「导出」页顶部`, "ok");
    document.querySelector('.tab[data-tab="exp"]').click();
  };
}

function setStatus(msg, cls) {
  const el = $("expMsg");
  if (!el) return;
  el.textContent = msg;
  el.className = "status " + (cls || "");
}
// 录制页状态(录制页动作的状态提示 —— 原来全写导出页 expMsg, 用户在录制页看不到)
// aria-live: 键盘/读屏用户听不到动态文本变化, 状态更新要播报(播报中/AI 完成/错误三类反馈全走这)
function setRecStatus(msg, cls) {
  const el = $("chainMsg");
  if (!el) return;
  el.textContent = msg;
  el.className = "badge-txt " + (cls === "err" ? "err" : cls === "ok" ? "" : "");
}

// ---------- 页面上下文执行(页面内 fetch, Cookie 自动最新) ----------
// 目标 tab 必须已授权(optional_host_permissions)。未授权时 executeScript 抛错,
// 提示用户去配置域名 —— 与录制同一套授权机制。
async function execInPage(tabId, fn, args) {
  const res = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: fn,
    args: args || [],
  });
  return res[0]?.result;
}

function hostErrMsg(e) {
  return "无法在页面上下文执行(未授权该域名?): " + String(e) +
    "\n\n点 ⚙ 配置域名 → 添加并授权后重试。";
}

// ---------- 重放 ----------
// replayFn 由 replay.js 提供(同页共享全局) —— 这里绝不能再声明:
// 顶层 const 重复声明在解析期抛 SyntaxError, 整个 sidepanel.js 不执行, 按钮全死(v0.3.9 实锤)。

async function replay(e) {
  const t = await currentTab();
  const msgEl = $("replayMsg");
  const errEl = $("replayErr");
  const body = $("dBody").value;
  const headers = {};
  $("dHeaders").value.split("\n").forEach((line) => {
    const i = line.indexOf(":");
    if (i > 0) {
      const k = line.slice(0, i).trim();
      const v = line.slice(i + 1).trim();
      if (k && v) headers[k] = v;
    }
  });
  if (!t || !t.id) { errEl.textContent = "找不到当前标签页"; return; }
  msgEl.textContent = "重放中…";
  errEl.textContent = "";
  try {
    const r = await execInPage(t.id, replayFn, [e.url, e.method, headers, body]);
    msgEl.textContent = `→ ${r.status} ${r.ok ? "OK" : "FAIL"}`;
    const respPre = $("dResp");
    if (respPre) respPre.textContent = r.text;
  } catch (ex) {
    msgEl.textContent = "";
    errEl.textContent = hostErrMsg(ex);
  }
}

// ---------- 复制 cURL(交接/贴群/终端重放的最通用格式) ----------
// 注: 剔除 SKIP_HEADERS 管理头(Cookie 归浏览器管, 复制出去也是旧的);
// body 为空时整个省略(-d '' 会让 GET 变 POST 语义混乱)。
async function copyCurlFor(e) {
  const msgEl = $("replayMsg");
  const parts = [`curl '${e.url.replace(/'/g, "'\\''")}'`];
  parts.push(`-X ${e.method}`);
  for (const [k, v] of Object.entries(e.headers || {})) {
    if (isSkipHeader(k)) continue;
    parts.push(`-H '${k}: ${String(v).replace(/'/g, "'\\''")}'`);
  }
  if (e.body) parts.push(`--data-raw '${e.body.replace(/'/g, "'\\''")}'`);
  const cmd = parts.join(" \\\n  ");
  try {
    await navigator.clipboard.writeText(cmd);
    msgEl.textContent = "✓ cURL 已复制";
  } catch {
    msgEl.textContent = "";
    $("replayErr").textContent = "复制失败(剪贴板权限), 手动框选详情区复制";
  }
}

// ---------- 单条删除 ----------
// 与 cleanVisible 同一套联动: 前置标记/选中态/AI 链失效清理。
function removeOne(e) {
  if (!confirm(`删除这条请求?不可撤销。\n  ${e.method} ${e.path}`)) return;
  entries = entries.filter((x) => x.id !== e.id);
  preludeIds.delete(e.id);
  manualPrelude.delete(e.id);
  persistManualPrelude();
  pickIds.delete(e.id);
  persistPickIds();
  if (aiChain && aiChain.length) {
    // AI 链锚定条目 id, 被删的 from/to 不在集 → 重放时自动跳过该链, 无需整链失效;
    // 但导出 JMX 用的是下标语义的旧链会错位 —— 统一保守清掉, 重新建链成本低于错注。
    aiChain = null;
    chrome.storage.local.remove("toolbox.aiChain", () => {});
  }
  persistEntries();
  if (selectedId === e.id) {
    // 删的是当前选中条: 就近补选(选中被删条在剩余列表中位置的前一条; 删的是第一条
    // 则选新的第一条)——详情区不至于退回"← 点一条请求看详情"空态
    const oldIdx = [...entries].findIndex((x) => x.id === e.id);
    selectedId = null;
    ensureSelection(Math.max(0, oldIdx - 1));
  } else {
    renderList();
  }
  setRecStatus(`✓ 已删除 1 条`, "ok");
}

// ---------- 冒烟(页面上下文快速并发验证, 非严肃压测) ----------
// 浏览器环境两大约束决定了数字只能做定性参考:
//   1. 同域 HTTP/1.1 连接池上限约 6 条 —— UI 并发>6 时请求在浏览器里排队, P99 含排队时间;
//   2. 单渲染进程 + 真实会话, 永远是"单用户视角", 模拟不了多用户。
// 严肃压测(基准数字/阶梯加压/分布式)请导 JMX。
const loadFn = async (url, method, headers, body, conc, total, timeoutMs) => {
  const times = [];
  const errors = [];
  let done = 0;
  const deadline = performance.now() + (timeoutMs || 5 * 60 * 1000); // 5 分钟上限自停(防页面挂起后永转)
  // 单条看门狗: deadline 只在循环头检查, fetch 挂起(接口 accept 后不回话/连接黑洞)时
  // 永远到不了检查点 → 整轮冒烟卡死在"冒烟中…"。每条请求挂 AbortController,
  // 单条超时计一次失败并继续, 与整体 deadline 双保险(与 replayFn 同款机制)。
  const singleMs = Math.min(30000, (timeoutMs || 5 * 60 * 1000));
  async function once() {
    const t0 = performance.now();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), singleMs);
    try {
      const r = await fetch(url, { method, headers, body: body || null, credentials: "include", signal: ctl.signal });
      await r.text();
      clearTimeout(timer);
      times.push({ ms: performance.now() - t0, ok: r.ok, status: r.status });
      if (!r.ok) errors.push(r.status);
    } catch (ex) {
      clearTimeout(timer);
      times.push({ ms: performance.now() - t0, ok: false, status: 0 });
      errors.push(String(ex).slice(0, 80));
    }
  }
  async function worker() {
    while (done < total) {
      if (performance.now() >= deadline) return;
      done++;
      await once();
    }
  }
  const t0 = performance.now();
  await Promise.all(Array.from({ length: conc }, worker));
  return { wall: performance.now() - t0, times, errors: errors.slice(0, 10), timeout: performance.now() >= deadline };
};

function showLoadTest(e) {
  selectedId = e.id;
  renderList();
  $("detail").innerHTML = `
    <div class="kv"><h4 id="kv-lt">冒烟目标</h4><pre aria-labelledby="kv-lt">${escHtml(e.method + " " + e.path)}</pre></div>
    <div class="kv" role="group" aria-labelledby="kv-ltp"><h4 id="kv-ltp">参数</h4>
      <label>并发 <input type="number" id="ltConc" value="5" min="1" max="20" style="width:64px" aria-label="并发数"></label>
      <label style="margin-left:10px">总次数 <input type="number" id="ltTotal" value="50" min="1" max="2000" style="width:72px" aria-label="总请求次数"></label>
    </div>
    <div class="kv"><div class="acts"><button class="btn warn" id="ltRun" aria-label="开始冒烟压测(向服务端真实发请求)">▶ 开始冒烟</button>
      <span class="badge-txt">会向服务端真实发 ${e.method} 请求, 请确认环境可承受</span></div></div>
    <div class="kv"><h4 id="kv-ltr">结果</h4><pre id="ltOut" style="background:#0d1117;color:#3fb950;max-height:70vh" role="status" aria-live="polite">待运行…</pre></div>
    <div class="kv"><span class="badge-txt">页面上下文快速验证(会话永远有效), 数字偏保守——浏览器同域连接池有限, 并发>6 时含浏览器排队;严肃压测请导 JMX</span></div>
    <div class="badge-txt err" id="ltErr" role="alert"></div>`;
  $("ltRun").onclick = () => runLoadTest(e);
}

async function runLoadTest(e) {
  const conc = Math.max(1, Math.min(20, +$("ltConc").value || 5));
  const total = Math.max(1, Math.min(2000, +$("ltTotal").value || 50));
  const out = $("ltOut");
  const err = $("ltErr");
  const t = await currentTab();
  if (!t || !t.id) { err.textContent = "找不到当前标签页"; return; }
  const bizHeaders = Object.fromEntries(Object.entries(e.headers).filter(([k]) => !isSkipHeader(k)));
  const body = e.body || null;
  // 租约防多开: 上一轮没跑完又点开始 → 旧轮被顶(按钮 disabled 本身挡大部分, 这是双保险)
  const btn = $("ltRun");
  btn.disabled = true;
  out.textContent = "冒烟中…";
  err.textContent = "";
  try {
    const r = await execInPage(t.id, loadFn, [e.url, e.method, bizHeaders, body, conc, total, 5 * 60 * 1000]);
    const ms = r.times.map((x) => x.ms).sort((a, b) => a - b);
    const q = (p) => ms[Math.min(ms.length - 1, Math.floor(ms.length * p))] || 0;
    const fails = r.times.filter((x) => !x.ok).length;
    const rps = r.wall > 0 ? (r.times.length / (r.wall / 1000)).toFixed(1) : "0";
    const stats = {
      concurrency: conc, total, completed: r.times.length, wallMs: Math.round(r.wall),
      rps: Number(rps), success: r.times.length - fails, failed: fails,
      failRate: fails ? Number((fails / r.times.length * 100).toFixed(1)) : 0,
      p50: Math.round(q(0.5)), p90: Math.round(q(0.9)), p95: Math.round(q(0.95)), p99: Math.round(q(0.99)),
      maxMs: Math.round(ms[ms.length - 1] || 0),
      errors: r.errors,
      // entry 供 perf 技能 buildPerfPrompt 消费(其 aiSanitizeEntry 上限 bodyMax 1200 / respMax 600)
      // —— body/response 落 storage 前按消费上限截断: 录制侧单条 body 可达 200KB,
      // 全量入 10MB 配额池是纯浪费(消费方永远只用前 1200 字符), response 截 600 是既有先例。
      entry: { method: e.method, url: e.url, path: e.path, status: e.status, headers: e.headers || {}, body: (e.body || "").slice(0, 1200), response: (e.response || "").slice(0, 600) },
    };
    // 落 storage, 供 perf 技能「点一下自动取数」(无需再手动压一次)
    chrome.storage.local.set({ "toolbox.lastLoadTest": stats }, () => {});
    out.textContent =
      `完成 ${r.times.length}/${total}  并发 ${conc}  总耗时 ${(r.wall / 1000).toFixed(2)}s  吞吐 ${rps} req/s\n` +
      (r.timeout ? `⚠ 已达 5 分钟上限自动停止(未发完 ${total - r.times.length} 条)\n` : "") +
      `成功 ${r.times.length - fails}  失败 ${fails} (${fails ? (fails / r.times.length * 100).toFixed(1) + "%" : "0%"})\n` +
      `P50 ${q(0.5).toFixed(0)}ms   P90 ${q(0.9).toFixed(0)}ms   P95 ${q(0.95).toFixed(0)}ms   P99 ${q(0.99).toFixed(0)}ms   MAX ${ms[ms.length - 1]?.toFixed(0) || 0}ms\n` +
      `(页面上下文冒烟: 会话新鲜、数字偏保守; 严肃压测导 JMX)\n` +
      (r.errors.length ? "错误样本: " + r.errors.join(" / ") : "");
  } catch (ex) {
    out.textContent = "";
    err.textContent = hostErrMsg(ex);
  }
  btn.disabled = false;
}

// ---------- AI 诊断 ----------
// AI 入口统一异常模式: try/catch/finally —— catch 给可读错误, finally 解锁。
// 此前 5 个 AI 函数裸奔: buildXxxPrompt/callLlm 前后任何 throw(如 pathLine 收到
// 手改 storage 混入的相对 url 直接 Invalid URL)会沿 async 函数 reject 无人接,
// disabled=false 永不执行 → 按钮永久锁死且零提示(unhandled rejection 只进 console)。
async function aiDiagnose(e) {
  const btn = $("aiDiag");
  if (btn.disabled) return;
  btn.disabled = true;
  try {
    const idx = entries.findIndex((x) => x.id === e.id);
    const ctx = entries.slice(Math.max(0, idx - 5), idx).concat(entries.slice(idx + 1, idx + 6));
    const msgEl = $("replayMsg");
    msgEl.textContent = "AI 诊断中…(思考模型需 10~30s)";
    const msgs = buildDiagnosePrompt(e, ctx);
    const r = await callLlm(msgs, { temperature: 0.2 });
    msgEl.textContent = r.ok ? "→ 诊断完成" : "";
    if (!r.ok) {
      const errEl = $("replayErr");
      if (errEl) errEl.textContent = r.error;
      return;
    }
    e.aiDiagnosis = r.content;
    persistEntries(); // 诊断结果随条目持久(重开侧栏不丢)
    if (selectedId === e.id) renderDetail();
  } catch (err) {
    const errEl = $("replayErr");
    if (errEl) errEl.textContent = "AI 诊断异常: " + (err && err.message ? err.message : err);
  } finally {
    btn.disabled = false;
  }
}

// ---------- AI 报告 ----------
const AI_REPORT_MAX = 60;
async function aiReport() {
  const btn = $("btnAiReport");
  if (btn.disabled) return;
  btn.disabled = true;
  try {
    const src = exportSet(); // AI 报告: 勾选优先, 否则可见集(过滤缩范围可全量分析)
    if (!src.length) {
      setStatus("没有可分析的请求", "err");
      return;
    }
    const truncated = src.length > AI_REPORT_MAX;
    const sent = truncated ? src.slice(0, AI_REPORT_MAX) : src;
    setStatus(`已发送前 ${sent.length} 条${truncated ? ` (共 ${src.length} 条, 超上限截断)` : ""}, LLM 分析中…`, "");
    const msgs = buildReportPrompt(sent);
    const t0 = Date.now();
    const r = await callLlm(msgs, { temperature: 0.2 });
    if (!r.ok) { setStatus(r.error, "err"); return; }
    setStatus(`✓ 完成 · ${sent.length} 条 · 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`, "ok");
    const el = $("expOut");
    el.style.display = "block";
    // 报告 + 操作按钮一起注入(HTML 里没有静态按钮, 动态生成)
    const btnIdCopy = "aiRptCopy", btnIdSave = "aiRptSave";
    el.innerHTML = `<span class="hd2">AI 流量报告</span> ` +
      `<button class="btn" id="${btnIdCopy}" style="padding:2px 8px;font-size:11px">📋 复制</button>` +
      `<button class="btn" id="${btnIdSave}" style="padding:2px 8px;font-size:11px">⬇ 下载 .md</button>` +
      `\n\n${escHtml(r.content)}`;
    el.scrollIntoView({ behavior: "smooth", block: "nearest" });
    $(btnIdCopy).onclick = async () => {
      try { await navigator.clipboard.writeText(r.content); setStatus("✓ 已复制", "ok"); }
      catch { setStatus("复制失败, 请手动框选", "err"); }
    };
    $(btnIdSave).onclick = () => downloadText(`ai_report_${stamp()}.md`, r.content, "text/markdown");
  } catch (err) {
    setStatus("AI 报告异常: " + (err && err.message ? err.message : err), "err");
  } finally {
    btn.disabled = false;
  }
}

// ---------- AI 参数建链(自动联调核心) ----------
// 把 LLM 输出的依赖链应用到当前条目, 存在 toolbox.aiChain 供 JMX 导出/重放复用。
let aiChain = null; // [{from, fromJsonPath, to, toParam, var, value}]

// 建链方向校验/自动纠向(#173): validateChain 的 from < to 只保证"下标序正确",
// 拦不住 LLM 把"生产者/消费者"角色互换 —— from 指向消费值的请求、to 指向产出值的
// 响应时, 注入逻辑会把下游响应字段当上游产出往上游请求里塞, 链整反必无值。
// 用 LLM 自报的 value(录制时的示例值)做真实位置验证:
//   · 正向: 值出现在 from 的【响应】里, 且出现在 to 的【请求】里 → 链成立
//   · 反向: 值出现在 to 的响应里, 且出现在 from 的请求里 → 角色整反, 交换 from/to
//   · 都不满足 → AI 幻觉值, 丢弃该链(不污染链表)
// 注: 与 extractFromLive 同款路径取值(extractAt), 响应结构不含该路径时退回
// "原文包含值"粗匹配 —— 建链是启发式, 宁可保守放行交给重放回执, 不可错杀真链。
function chainExtractAt(text, jsonPath) {
  try {
    const j = JSON.parse(text);
    let v = j;
    for (const seg of String(jsonPath || "").split(".").filter(Boolean)) {
      if (v == null) return null;
      if (Array.isArray(v) && !/^\d+$/.test(seg)) v = v[0];
      v = v[seg];
    }
    if (v == null) return null;
    return (typeof v === "object") ? JSON.stringify(v) : String(v);
  } catch { return null; }
}
function chainSideContains(e, val) {
  if (val == null || val === "") return false;
  const hay = [e.body, e.url, e.query, JSON.stringify(e.headers || {})].filter(Boolean).join("\n");
  return hay.includes(val);
}
function refineChainDirection(chain, src) {
  if (!Array.isArray(chain) || !chain.length) return chain;
  const keep = [], flipped = [], dropped = [];
  for (const c of chain) {
    if (!c || typeof c !== "object") continue;
    const val = c.value != null ? String(c.value) : "";
    const f = src[c.from], t = src[c.to];
    if (!f || !t) { keep.push(c); continue; } // 下标越界交由后续 id 快照/应用层兜底
    if (!val) { keep.push(c); continue; }    // AI 没给示例值 → 无法验证, 保守放行
    const fromRespHas = chainExtractAt(f.response, c.fromJsonPath) === val || String(f.response || "").includes(val);
    const toReqHas = chainSideContains(t, val);
    const toRespHas = chainExtractAt(t.response, c.fromJsonPath) === val || String(t.response || "").includes(val);
    const fromReqHas = chainSideContains(f, val);
    if (fromRespHas && toReqHas) { keep.push(c); continue; }         // 方向正确
    if (toRespHas && fromReqHas && !fromRespHas) {                   // 角色整反 → 纠向
      const fixed = { ...c, from: c.to, to: c.from };
      delete fixed.fromId; delete fixed.toId; // 快照在纠向后重新打(aiBuildChain 下一步)
      flipped.push(fixed); continue;
    }
    // 两侧响应都【非空且都不含该值】才是幻觉可判死; 任一侧响应为空(CDP 没抓到体/
    // 截断)时证据不足, 保守放行 —— 错杀真链的代价(用户看到的链凭空消失)高于
    // 放行幻觉链(重放回执 missing 兜底可见)。
    const fRespEmpty = !f.response, tRespEmpty = !t.response;
    if (!fromRespHas && !toRespHas && !fRespEmpty && !tRespEmpty) { dropped.push(c); continue; }
    keep.push(c); // 模糊形态(单侧含值/响应缺失): 保守放行, 重放回执兜底
  }
  const out = keep.concat(flipped);
  if (flipped.length) {
    setRecStatus(`⚠ 已自动纠正 ${flipped.length} 条方向搞反的链(AI 把下游当上游), 其余 ${keep.length} 条方向正确。`, "ok");
  }
  if (dropped.length && !out.length) {
    setRecStatus(`AI 返回的 ${dropped.length} 条链的示例值在两侧响应里都不存在(疑似幻觉), 已丢弃。`, "");
  }
  return out;
}

async function aiBuildChain() {
  const btn = $("btnAiChain");
  if (btn.disabled) return;
  // 已有链时点「建链」= 查看器(明细+清除/复制), 不重复烧 LLM ——
  // 想重建先清除。链对用户可见是硬需求: 之前只在建链瞬间闪一次预览。
  if (aiChain && aiChain.length) { renderChainPreview(); return; }
  const src = exportSet();
  if (!src.length) { setStatus("没有可分析的请求", "err"); return; }
  btn.disabled = true;
  try {
    // 截断须明示(与 aiReport/aiDoc 同语义): 超 40 条静默 slice 会让用户误以为全量建链。
    const truncated = src.length > 40;
    const sent = truncated ? src.slice(0, 40) : src;
    setStatus(`AI 参数建链中…(${sent.length} 条${truncated ? ` (共 ${src.length} 条, 超上限截断)` : ""}, 10~30s)`, "");
    const msgs = buildChainPrompt(sent);
    const r = await callLlm(msgs, { temperature: 0 });
    if (!r.ok) { setStatus("建链失败: " + r.error, "err"); return; }
    aiChain = refineChainDirection(validateChain(extractChainJson(r.content)), sent);
    if (!aiChain.length) {
      setStatus("AI 没找出跨接口参数传递(可能本链路本来就无跨接口依赖, 或需把登录+业务一起录)。", "ok");
      return;
    }
    // 快照建链时的条目 id: from/to 下标只对"建链时的导出集"有效;
    // 之后过滤/勾选/清洗变了集, 下标会指到错条目。重放时按 id 重新定位, 不匹配则跳过该链。
    const ids = src.map((e) => e.id);
    for (const c of aiChain) { c.fromId = ids[c.from] || null; c.toId = ids[c.to] || null; }
    chrome.storage.local.set({ "toolbox.aiChain": aiChain }, () => {});
    const n = aiChain.length;
    setStatus(`✓ 已建 ${n} 条参数依赖链。重放/导出 JMX 时自动应用(提取器+变量替换)。`, "ok");
    renderChainPreview();
  } catch (err) {
    setStatus("AI 建链异常: " + (err && err.message ? err.message : err), "err");
  } finally {
    btn.disabled = false;
  }
}

// 建链结果预览(建链后/点「链」按钮共用): 链列表 + 清除入口。
// 之前只在建链瞬间闪一次预览, 用户想确认"链还在不在/长什么样"无从查看 ——
// 「🔗」按钮变查看器: 有链显示明细, 无链提示去建链。
function renderChainPreview() {
  const el = $("expOut");
  el.style.display = "block";
  if (!aiChain || !aiChain.length) {
    el.innerHTML = `<span class="hd2">AI 参数依赖链</span>\n暂无依赖链。点「🔗 建链」分析当前导出集的跨接口参数传递。`;
    return;
  }
  el.innerHTML = `<span class="hd2">AI 参数依赖链(${aiChain.length} 条)</span> ` +
    `<button class="btn" id="chainClear" style="padding:2px 8px;font-size:11px" title="清除依赖链(重放不再注入)">🗑 清除链</button>` +
    `<button class="btn" id="chainCopy" style="padding:2px 8px;font-size:11px">📋 复制</button>\n` +
    aiChain.map((c) => {
      // 优先展示可读的接口名(建链后条目可能已被删, 找不到时退回序号)
      const f = entries.find((x) => x.id === c.fromId);
      const t = entries.find((x) => x.id === c.toId);
      const fName = f ? `${f.method} ${f.path}` : `#${c.from + 1}`;
      const tName = t ? `${t.method} ${t.path}` : `#${c.to + 1}`;
      const originTag = c.origin === "corr" ? ` <span style="color:#188038" title="自动关联值溯源合成(非 AI)">🔗⚡</span>` : "";
      return `· ${escHtml(fName)} 的 ${escHtml(c.fromJsonPath || "响应")} → ${escHtml(tName)} 的 ${escHtml(c.toParam)}  = ${escHtml(c.var)}${originTag}` +
        (c.value ? `  (录制值: ${escHtml(String(c.value).slice(0, 40))})` : "");
    }).join("\n") + `\n\n重放/链路重放/导出 JMX 自动应用: 提取器取上游 live 值 + 下游参数替换。`;
  $("chainClear").onclick = () => {
    aiChain = null;
    chrome.storage.local.remove("toolbox.aiChain", () => {});
    setStatus("已清除参数依赖链", "ok");
    renderChainPreview();
  };
  updateCsvUi(); // 链增减 → 数据驱动列数随之变(csvHint 显隐/计数同步)
  updateCsvUi(); // 链增减 → 数据驱动列数随之变(csvHint 显隐/计数同步)
  $("chainCopy").onclick = async () => {
    try { await navigator.clipboard.writeText(JSON.stringify(aiChain, null, 2)); setStatus("✓ 链 JSON 已复制", "ok"); }
    catch { setStatus("复制失败, 请手动框选", "err"); }
  };
}

// ---------- AI 接口文档 ----------
async function aiDoc() {
  const btn = $("btnAiDoc");
  if (btn.disabled) return;
  const src = exportSet();
  if (!src.length) { setStatus("没有可分析的请求", "err"); return; }
  btn.disabled = true;
  try {
    // 截断须明示(与 aiReport/skill 路径同承诺): 超 40 条静默只发前 40 会让用户
    // "以为分析了 100 条, 文档只覆盖前 40"且无从归因。
    const truncated = src.length > 40;
    const sent = truncated ? src.slice(0, 40) : src;
    setStatus(`AI 生成接口文档中…(${sent.length} 条${truncated ? ` (共 ${src.length} 条, 超上限截断)` : ""}, 10~30s)`, "");
    const msgs = buildDocPrompt(sent);
    const r = await callLlm(msgs, { temperature: 0.2 });
    if (!r.ok) { setStatus("文档生成失败: " + r.error, "err"); return; }
    const el = $("expOut");
    el.style.display = "block";
    el.innerHTML = `<span class="hd2">AI 接口文档</span> ` +
      `<button class="btn" id="aiDocCopy" style="padding:2px 8px;font-size:11px">📋 复制</button>` +
      `<button class="btn" id="aiDocSave" style="padding:2px 8px;font-size:11px">⬇ 下载 .md</button>` +
      `\n\n${escHtml(r.content)}`;
    $("aiDocCopy").onclick = async () => {
      try { await navigator.clipboard.writeText(r.content); setStatus("✓ 已复制", "ok"); }
      catch { setStatus("复制失败, 请手动框选", "err"); }
    };
    $("aiDocSave").onclick = () => downloadText(`api_doc_${stamp()}.md`, r.content, "text/markdown");
  } catch (err) {
    setStatus("AI 文档异常: " + (err && err.message ? err.message : err), "err");
  } finally {
    btn.disabled = false;
  }
}

// ---------- 自动关联 ----------
function showCorrelation() {
  const vis = exportSet(); // 关联分析: 勾选优先, 否则可见集(过滤缩范围, 剔掉轮询/心跳)
  corrResult = analyzeCorrelation(vis);
  chrome.storage.local.set({ "toolbox.corrResult": corrResult });
  const n = corrResult.groups.length;
  // 值溯源: seq/fixed 动态值(单号/UUID)在更早条目的响应里找同值叶子 → 合成参数链。
  // 之前这些字段只留一句"建议上游提取"却从没人真挂提取器(JMX _extractor 同款断档);
  // 合成链与 AI 建链同构(origin:"corr"), 重放注入/JMX 提取器/PY 提取全下游自动生效。
  // 幂等: 用户对同一集重复点「关联」时, 旧的合成链(origin:"corr")先剔除再 concat ——
  // 直接 concat 会整份翻倍(同提取器挂两个/JMeter 树冗余/receiptNote 回执重复),
  // AI 链(origin 无/非 corr)保留不动。
  let linked = 0;
  const aiChains = (aiChain || []).filter((c) => c.origin !== "corr");
  const synth = linkSeqDynamics(vis, corrResult, aiChains.map((c) => c.var));
  if (synth.length) {
    aiChain = aiChains.concat(synth);
    chrome.storage.local.set({ "toolbox.aiChain": aiChain }, () => {});
    linked = synth.length;
  }
  if (!n) {
    setStatus("没找到可关联的动态值。把同一操作做 2 遍以上(如建两笔单), 同一接口 body 有差异的字段会被参数化。", "ok");
  } else {
    setStatus(`已识别 ${vis.length} 条可见录制中的 ${n} 个接口动态字段, 共 ${corrResult.summary} 处。导出 JMX 时自动参数化。` +
      (linked ? ` 其中 ${linked} 个动态值已溯源到上游响应, 自动挂了提取链(重放/JMX/PY 生效)。` : ""), "ok");
    if (linked) renderChainPreview(); // 链变了, 让用户能直接看到合成结果
  }
  renderList();
}

// ---------- 数据加载 / 同步 ----------
// decodeHarvest/normalizeEntry/stamp/harvestToExportRows/harQueryString/buildHar/applyCorr
// 由 common.js 提供(勿在此重复声明 —— 同页 script 顶层撞名在解析期炸全页)。
// applyCorr 的 corrResult 改为显式传参(popup 复用时无法访问本页闭包状态)。
let harvestCorrupt = false;

// 侧栏侧写回(清洗/丢弃等本页操作): 与后台同一信封格式, 后台读到也认。
// 同步覆盖写入有并发风险(后台可能同时在 flush), 但清洗/丢弃是低频用户动作, 可接受;
// 后台 flush 读的是最新 storage 值, 侧栏写前 list 已从 storage 过, 冲突窗口极小。
function persistEntries() {
  chrome.storage.local.set({ [STORE_KEY]: { v: 1, entries } }, () => {});
}

async function loadHarvest() {
  const r = await chrome.storage.local.get([STORE_KEY]);
  const decoded = decodeHarvest(r[STORE_KEY]);
  harvestCorrupt = decoded === null;
  entries = decoded === null ? [] : decoded.map(normalizeEntry);
  if (harvestCorrupt) {
    console.error("toolbox.harvest 结构损坏, 已忽略(备份在 toolbox.harvest.corrupt)");
  }
  const cr = await chrome.storage.local.get(["toolbox.corrResult"]);
  corrResult = cr["toolbox.corrResult"] || null;
  const chain = await chrome.storage.local.get(["toolbox.aiChain"]);
  aiChain = chain["toolbox.aiChain"] || null;
  const asserts = await chrome.storage.local.get(["toolbox.aiAsserts"]);
  aiAsserts = new Map((asserts["toolbox.aiAsserts"] || []).map((x) => [x.path, x.asserts]));
  const mp = await chrome.storage.local.get([KEY_MANUAL_PRELUDE]);
  manualPrelude = new Map(Array.isArray(mp[KEY_MANUAL_PRELUDE]) ? mp[KEY_MANUAL_PRELUDE] : []);
  // 勾选集还原(#173 持久化配套): 勾选模式是会话级开关, 但开着侧栏关掉再开, 勾的
  // 几十条不该丢。死 id(条目已被引擎淘汰)无害: exportSet 按 entries 过滤。
  const pk = await chrome.storage.local.get([KEY_PICK_IDS]);
  if (Array.isArray(pk[KEY_PICK_IDS]) && pk[KEY_PICK_IDS].length) {
    pickIds = new Set(pk[KEY_PICK_IDS].filter((id) => entries.some((e) => e.id === id)));
  }
  if (pickIds.size && !pickMode) {
    // 有历史勾选但不在勾选模式 → 自动恢复勾选模式(用户上次的工作态, 不恢复模式
    // 的话勾选集不生效, "勾了却导出全量"是静默背离)。按钮态与 togglePickMode 对齐。
    pickMode = true;
    $("btnPick").classList.add("pri");
    $("btnPick").textContent = `✓ 已选 ${pickIds.size}`;
    $("btnPickAll").style.display = "";
  }
  refreshPrelude();
  renderList();
}

// storage 变动(引擎写入/停止清空/其他页面)实时同步
// 注: 清空必须是 set(空信封)而非 remove —— 本监听只认有 newValue 的快照
// (background clearHarvest 用 set(encodeHarvest([]))); 若改用 remove 清空,
// newValue 为 undefined → decodeHarvest 返 null → 下行 return, 列表残留旧条目。
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[STORE_KEY]) {
    const fresh = decodeHarvest(changes[STORE_KEY].newValue);
    harvestCorrupt = fresh === null; // 同步损坏标志(清空重建后空态不再误报"损坏")
    if (fresh === null) return; // 损坏快照不进 UI(保持当前列表)
    if (!fresh.length && entries.length) {
      entries = [];
      corrResult = null;
      // 派生结果与数据源同生命周期: corrResult 在这清, aiChain/aiAsserts 也必须清 ——
      // 多面板实例场景下 A 面板丢弃(storage 由 background clearHarvest 清 4 键)后,
      // B 面板内存若仍持旧链/旧断言, 无 id 的老格式链走下标兜底会错注入到新录制。
      aiChain = null;
      aiAsserts = null;
      // manualPrelude 同属派生面: storage 侧已被 background clearHarvest 清, 本地不清的话
      // 用户下次手动标记新条目时 persistManualPrelude 会把死 id 一起回写 storage(死键累积)。
      manualPrelude = new Map();
      // chainResults 指向已清空的条目 + 「调试失败」按钮必须同步藏起 ——
      // 否则用户丢弃数据后按钮仍亮着, 点了把死条目喂给 AI(LLM 看到不存在的请求白烧一次)。
      chainResults = [];
      const diagBtn = $("btnChainAiDiag");
      if (diagBtn) diagBtn.style.display = "none";
      selectedId = null;
      // pickIds 同属派生面(v1.0.78): storage 侧已被 background clearHarvest 清(清单补齐),
      // 本地不清的话 B 面板内存持死勾选 → 用户点任何条目 togglePick 时 persistPickIds
      // 把死集回写 storage(与 manualPrelude 同款死键累积路径)。pickMode 保留: 用户
      // 在另一面板丢数据, 本面板的"勾选模式"是 UI 开关不是派生数据, 退出由用户决定。
      pickIds = new Set();
      $("btnPick").textContent = pickMode ? "✓ 已选 0" : "☐ 勾选";
      updateTrimUi(); // 被选条目随清空消失, 起点裁剪提示须同步隐藏
      renderList();
    } else if (fresh.length) {
      // 后台引擎 push 增量: 只补本地没有的条目, 不整表覆盖(保住选中/编辑状态)。
      // 引擎侧 trimToFit/上限淘汰会把最旧条目从 storage 裁掉 —— 快照里消失的条目本地
      // 不删(幽灵条目): 删除会连带清 selectedId/pickIds, 录制中途引擎每批 flush 都可能
      // 裁旧条, 逐条对账会把用户正在看的选中态抖掉。幽灵条目数据完整(导出/重放照常),
      // 用户下次 persistEntries(单删/清洗)整表写回时, 引擎下一批 flush 的 trimToFit
      // 会把复活的旧条重新裁掉 —— 窗口自愈, 不累积、不炸配额, 只短窗显示多于引擎侧。
      const known = new Set(entries.map((x) => x.id));
      let added = false;
      for (const e of fresh) {
        if (!known.has(e.id)) { entries.push(normalizeEntry(e)); added = true; }
      }
      if (added) { refreshPrelude(); } // refreshPrelude 尾部已 renderList —— 此处再调会双倍全量渲染
    }
    updateScopeHint(); // 导出页"本次录制 N 条/可见 M 条"随引擎写入实时刷新
  }
  if (changes["toolbox.recording"]) {
    const v = changes["toolbox.recording"].newValue;
    setState((v === REC_ON || v === REC_PAUSED) ? v : REC_IDLE);
  }
});

// ---------- Cookie ----------
async function loadCookiesForActiveTab() {
  // currentTab/containsOrigin 的 chrome API 异常兜底: 调用点 activate(t) 是同步
  // onclick, 本函数的 promise 无人接 —— tabs.query/permissions.contains reject 时
  // 是 unhandled rejection, Cookie 页停留旧状态无提示。下面的 loadCookies 段已有
  // try/catch, 但首行 currentTab 与授权判定在 try 之外。接住后与 cookies.getAll
  // 异常同语义: 清空 + 错误可见(v1.0.54 的 catch 块语义对齐, popup refreshSafe 同款
  // "UI 不炸、状态自愈"思路 —— 这里多一步错误呈现, 因为 Cookie 页有专用提示槽 ckMsg)。
  try {
    await loadCookiesForActiveTabInner();
  } catch (e) {
    cookies = [];
    viaParent = null;
    renderCookie();
    ckMsg("读取 Cookie 失败: " + String(e).slice(0, 120), "err");
  }
}
async function loadCookiesForActiveTabInner() {
  tab = await currentTab();
  if (!tab || !tab.url || !/^https?:/i.test(tab.url)) {
    // 非 http(s) 页面(chrome:// 等)查不到 Cookie —— 必须清掉旧站点的残留,
    // 否则导出按钮可用, 且文件名取 new URL(tab.url).hostname 会张冠李戴
    cookies = [];
    viaParent = null;
    ckMsg(tab ? "当前页面不是 http(s), 无法导出 Cookie。切到目标站点再试。" : "找不到当前标签页。", "err");
    renderCookie();
    return;
  }
  const url = new URL(tab.url);
  const origins = domainToOrigins(url.hostname);
  authOk = await containsOrigin(origins[0]).then(async (has) =>
    has ? true : await containsOrigin(origins.find((o) => o.includes("*")) || origins[0]));
  viaParent = null;
  if (!authOk) {
    const parts = url.hostname.split(".");
    for (let i = 1; i < parts.length - 1; i++) {
      const parent = parts.slice(i).join(".");
      if (await containsOrigin(domainToOrigins(parent)[0])) { viaParent = parent; break; }
    }
    if (!viaParent) {
      ckMsg("此域名未授权, 点 ⚙ 配置域名后可导出 Cookie", "err");
      cookies = [];
      renderCookie();
      return;
    }
    authOk = true;
  }
  try {
    await loadCookies(url);
  } catch (e) {
    // cookies API 抛错(cookie store 瞬时不可用等): 调用点在 activate(t) 切 tab 内,
    // 不接住就是 unhandled rejection —— Cookie 页停留旧状态、用户无任何提示。
    cookies = [];
    renderCookie();
    ckMsg("读取 Cookie 失败: " + String(e).slice(0, 120), "err");
    return;
  }
  ckMsg(`✓ ${cookies.length} 个 Cookie · ${url.hostname}${viaParent ? ` (授权来自父域 ${viaParent})` : ""}`, "ok");
}

async function loadCookies(url) {
  const seen = new Map();
  const parts = url.hostname.split(".");
  // 主机 Cookie(domain=host) 只查主机本身; 域 Cookie(domain=.host 或父域)逐级向上查。
  // 无点主机(localhost)没有父域可上溯, 只查自身。
  const domainsToQuery = [url.hostname];
  if (parts.length > 1) {
    for (let i = 1; i < parts.length - 1; i++) domainsToQuery.push(parts.slice(i).join("."));
  }
  for (const d of domainsToQuery) {
    const list = await chrome.cookies.getAll({ domain: d });
    for (const c of list) {
      if (c.domain.startsWith(".") || c.domain === url.hostname) {
        seen.set(c.domain + "|" + c.name + "|" + c.path, c);
      }
    }
  }
  cookies = [...seen.values()];
  renderCookie();
}

function ckMsg(text, cls = "") {
  const el = $("ckMsg");
  el.textContent = text;
  el.className = "status2 " + cls;
}

function renderCookie() {
  $("ckCount").textContent = cookies.length;
  const has = cookies.length > 0;
  for (const id of ["expState", "copyState", "expCurl", "copyCurl", "expRaw"]) {
    $(id).disabled = !has;
  }
  const kw = $("search").value.trim().toLowerCase();
  const shown = kw ? cookies.filter((c) => c.name.toLowerCase().includes(kw)) : cookies;
  const tbl = $("tbl");
  tbl.innerHTML = "";
  if (!has) {
    tbl.innerHTML = `<tr><td colspan="2" class="empty-line" style="color:#999;padding:12px">未捕获到 Cookie —— 先在浏览器登录目标系统。</td></tr>`;
    return;
  }
  // 表头行: 读屏按 th+scope 做列导航(读单元格前播报列名), 裸 td 列名信息全丢
  tbl.innerHTML = `<thead><tr><th scope="col" style="text-align:left">名称</th><th scope="col" style="text-align:left">值</th></tr></thead>`;
  if (!shown.length) {
    tbl.innerHTML += `<tr><td colspan="2" class="empty-line" style="color:#999;padding:12px">没有 Cookie 名含「${escHtml(kw)}」—— 清空搜索词看全部 ${cookies.length} 个。</td></tr>`;
    return;
  }
  for (const c of shown.slice(0, 50)) {
    const tr = document.createElement("tr");
    // value 必须过 escHtml: cookie value 是目标站任意可控的(恶意站可 set <svg/onload=..>
    // 形态), short() 只截断不消毒 —— 21 字符的完整 payload 恰好挤进 24 字符阈值, 切勿裸拼。
    tr.innerHTML = `<td class="n">${escHtml(c.name)}</td><td>${escHtml(short(c.value))}${c.httpOnly ? ' <span style="color:#d93025">H</span>' : ""}</td>`;
    tbl.appendChild(tr);
  }
  if (shown.length > 50) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="2" style="color:#999">… 还有 ${shown.length - 50} 个</td>`;
    tbl.appendChild(tr);
  }
}

function short(v) { return v.length > 24 ? v.slice(0, 22) + "…" : v; }

function buildState() {
  return {
    cookies: cookies.map((c) => ({
      name: c.name, value: c.value, domain: c.domain, path: c.path,
      expires: c.expiresDate || -1, size: (c.name + c.value).length,
      httpOnly: c.httpOnly, secure: c.secure,
      sameSite: (c.sameSite || "unspecified").replace(/^["']|["']$/g, ""),
      sourceScheme: c.secure ? "Secure" : "Http", sourcePort: c.secure ? 443 : 80,
    })),
    origins: [],
  };
}
function exportState() { if (!cookies.length) return; downloadText(`cookies_${new URL(tab.url).hostname}.state.json`, JSON.stringify(buildState(), null, 2)); ckMsg("✓ state 已下载", "ok"); }
function copyState() { if (!cookies.length) return; copyText(JSON.stringify(buildState(), null, 2)); }
function buildCurlLine() { return "Cookie: " + cookies.map((c) => `${c.name}=${c.value}`).join("; "); }
function exportCurl() { if (!cookies.length) return; downloadText(`cookies_${new URL(tab.url).hostname}.header.txt`, buildCurlLine(), "text/plain"); ckMsg("✓ curl 串已下载", "ok"); }
function copyCurl() { if (!cookies.length) return; copyText(buildCurlLine()); }
function exportRaw() { if (!cookies.length) return; downloadText(`cookies_${new URL(tab.url).hostname}.raw.json`, JSON.stringify(cookies, null, 2)); ckMsg("✓ 原始 JSON 已下载", "ok"); }

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    ckMsg("✓ 已复制", "ok");
  } catch {
    ckMsg("✗ 复制失败(手动全选复制)", "err");
  }
}

// ---------- 导出向导 ----------
(function initFmtCards() {
  for (const c of document.querySelectorAll(".wz-fmt")) {
    const cb = c.querySelector("input");
    c.addEventListener("click", () => {
      cb.checked = !cb.checked;
      c.classList.toggle("checked", cb.checked);
    });
    cb.addEventListener("click", (ev) => ev.stopPropagation());
  }
})();

$("btnSave").onclick = async () => {
  const fmts = [];
  if ($("fmtJsonl").checked) fmts.push("jsonl");
  if ($("fmtHar").checked) fmts.push("har");
  if ($("fmtJmx").checked) fmts.push("jmx");
  if ($("fmtPy").checked) fmts.push("py");
  if (!fmts.length) { setStatus("至少勾选一种格式", "err"); return; }
  if (!entries.length) { setStatus("没有录制数据", "err"); return; }
  const vis = exportSet(); // 导出集: 勾选优先, 否则可见集
  if (!vis.length) { setStatus("导出集为空(没勾条目? 过滤词全滤掉?)", "err"); return; }
  // 起点裁剪: 选中了一条且勾了 optTrim → 裁掉它之前的条目(录整段但只导业务段)
  let outSet = vis;
  if (selectedId && $("optTrim") && $("optTrim").checked) {
    const idx = vis.findIndex((e) => e.id === selectedId);
    if (idx > 0) outSet = vis.slice(idx);
  }
  const out = [];
  const errs = [];
  let cleanDropped = 0; // jmx/py 净化剔除数(与 outSet 比, 透明提示)
  let csvData = [];     // 本次 JMX 导出的数据驱动列(循环外声明, 汇总提示在循环后引用)
  for (const f of fmts) {
    try {
      if (f === "jsonl") out.push({ name: `harvest_${stamp()}.jsonl`, data: toJsonl(harvestToExportRows(outSet)), mime: "application/json" });
      if (f === "har") out.push({ name: `harvest_${stamp()}.har`, data: JSON.stringify(buildHar(outSet), null, 2), mime: "application/json" });
      if (f === "jmx" || f === "py") {
        // 可执行格式自动剔除预检/静态资源/SSE(压测脚本里这些只是采样器噪音);
        // 数据格式(JSONL/HAR)保真不动。剔除数透明提示, 不静默改集。
        const { entries: cleanSet, dropped } = filterSkippable(outSet);
        cleanDropped = Math.max(cleanDropped, dropped);
        if (f === "jmx") {
          // JMX 导出集: 依赖链(applyAiChainToJmx)应用 + CSV 数据驱动列收集。
          // collectCsvData 在 applyAiChainToJmx 之前调 —— 取的是录制值(替换前的 body);
          // 之后调会拿到 ${var} 占位符(被 collectCsvData 防御性跳过, 列静默丢)。
          // v1.0.84: 轻量自动关联(autoDetectChain)不依赖 AI, AI 不可用时仍能产出 JSONPostProcessor + CSV。
          const mergedChain = mergeChain(autoDetectChain(cleanSet), aiChain);
          const jmxApplied = applyAiChainToJmx(applyCorr(cleanSet, corrResult), mergedChain);
          csvData = ($("optCsv") && $("optCsv").checked) ? collectCsvData(cleanSet, mergedChain) : [];
          const jmxOpts = {
            title: "web-toolbox " + new Date().toISOString().slice(0, 16).replace("T", " "),
            prelude: ($("optOnceOnly").checked || $("optAutoRelogin").checked) ? [...preludeIds] : null,
            autoRelogin: $("optAutoRelogin").checked,
            sessionMarkers: $("optAutoRelogin").checked ? SESSION_MARKERS : [],
            csvData,
            csvFileName: `data_${stamp()}.csv`,
          };
          out.push({ name: `webtoolbox_${stamp()}.jmx`, data: buildJmx(jmxApplied, jmxOpts), mime: "application/xml" });
          if (csvData.length) {
            // CSV 模板与 .jmx 一起导出(表头=变量, 首行=录制值)。用户补多行即多数据驱动。
            out.push({ name: jmxOpts.csvFileName, data: csvTemplateText(csvData), mime: "text/csv" });
          }
        }
        if (f === "py") out.push({ name: `replay_${stamp()}.py`, data: buildPyScript(cleanSet, "cookies.state.json", { sessionMarkers: SESSION_MARKERS, aiChain }), mime: "text/x-python" });
      }
    } catch (err) {
      // 单格式失败只跳过它, 不拖累其他格式(原来 JMX 抛错导致 jsonl/har 白算不下载)
      errs.push(`${f}: ${err.message}`);
    }
  }
  if (!out.length) { setStatus("导出失败: " + errs.join("; "), "err"); return; }
  // 每个文件单独触发浏览器下载
  for (const f of out) downloadText(f.name, f.data, f.mime);
  // 预览 + 下载汇总提示
  const el = $("expOut");
  el.style.display = "block";
  el.innerHTML = out.map((f) => `<span class="hd2">${escHtml(f.name)}</span>\n${escHtml(f.data.slice(0, 1200))}${f.data.length > 1200 ? "\n…" : ""}`).join("\n\n────\n\n");
  setStatus(`✓ 已导出 ${out.length} 个文件(下载目录)。数据保留, 可重导。` +
    (cleanDropped ? ` JMX/PY 已剔除 ${cleanDropped} 条预检/静态资源(JSONL/HAR 保真全量)。` : "") +
    (csvData && csvData.length ? ` JMX 已挂 ${csvData.length} 列 CSV 数据驱动(data.csv 同目录)。` : "") +
    (errs.length ? `\n⚠ ${errs.length} 个格式失败: ${errs.join("; ")}` : ""), errs.length ? "" : "ok");
};

// buildHar/harQueryString 由 common.js 提供(勿重复声明)

$("btnDiscard").onclick = async () => {
  if (!entries.length) { setStatus("没有数据可丢弃", "err"); return; }
  if (!confirm(`丢弃全部 ${entries.length} 条录制?此操作不可撤销。`)) return;
  await chrome.runtime.sendMessage({ type: "clearHarvest" });
  entries = [];
  corrResult = null;
  aiChain = null;
  aiAsserts = null;
  // chainResults 与「调试失败」按钮同清(onChanged 清空分支同款语义): 死条目不喂 AI。
  chainResults = [];
  $("btnChainAiDiag").style.display = "none";
  selectedId = null;
  updateTrimUi();
  preludeIds = new Set();
  manualPrelude = new Map(); // 丢弃后手动覆盖指向的条目已不存在
  chrome.storage.local.remove(KEY_MANUAL_PRELUDE, () => {});
  pickIds = new Set(); // 丢弃后勾选集指向的条目已不存在
  persistPickIds(); // 勾选模式仍开时把空集写回, 否则 storage 残留旧勾选(重开侧栏复活死集)
  renderList();
  refreshState();
  setStatus("已清空", "ok");
};

// ---------- 导出实现 ----------
// harvestToExportRows/stamp 由 common.js 提供(勿重复声明)

// 导出页勾选项变化时刷新提示(前置计数/仅一次开关)
$("optOnceOnly").addEventListener("change", () => updatePreludeUi());
$("optAutoRelogin").addEventListener("change", () => updatePreludeUi());
// 起点开关变化时同步 trimNote(optTrim 关闭后"从 X 开始导出"文案须明示"不会裁剪", 否则陈旧误导);
// 详情页 setTrim 按钮态也读 optTrim.checked —— 但按钮在用户下次进详情时重渲染, 不强制即时刷。
$("optTrim").addEventListener("change", () => updateTrimUi());

// ---------- 工具 ----------
function escHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// ---------- 事件 ----------
$("btnConfig").onclick = () => chrome.runtime.openOptionsPage();
// 诊断日志导出: 引擎环形缓冲快照 → JSON 下载(排障时不靠嘴描述)
$("btnDiagLog").onclick = async () => {
  try {
    const r = await chrome.runtime.sendMessage({ type: "getDiagLog" });
    const log = (r && r.log) || [];
    downloadText(`toolbox_diag_${stamp()}.json`,
      JSON.stringify({ ts: new Date().toISOString(), note: "引擎诊断日志(不含请求数据/凭据), worker 重启即清空", log }, null, 2));
    setStatus(`✓ 已导出 ${log.length} 条诊断日志`, "ok");
  } catch (e) {
    setStatus("诊断日志导出失败: " + String(e).slice(0, 120), "err");
  }
};
$("btnAiReport").onclick = aiReport;
$("btnAiChain").onclick = aiBuildChain;
$("btnAiDoc").onclick = aiDoc;
$("btnCorrelate").onclick = showCorrelation;
$("expState").onclick = exportState;
$("copyState").onclick = copyState;
$("expCurl").onclick = exportCurl;
$("copyCurl").onclick = copyCurl;
$("expRaw").onclick = exportRaw;
$("search").addEventListener("input", renderCookie);
$("q").addEventListener("input", (ev) => setFilter(ev.target.value));

// ---------- 链路重放(回归 diff) ----------
// 按顺序重放当前可见集, 每条约录/重放对比, 出汇总 + diff。
// 执行租约: 连点两次不会并发跑两条重放(旧的租约被顶掉自动停), 10 分钟超时自停。
let chainLease = null;
let chainResults = []; // 最近一次重放里非 OK 的条目, 供 AI 调试
async function runChainReplay() {
  const vis = exportSet(); // 链路重放: 勾选优先, 否则可见集
  if (!vis.length) { setRecStatus("没有可重放的条目", "err"); return; }
  const t = await currentTab();
  if (!t || !t.id) { setRecStatus("找不到当前标签页", "err"); return; }
  // 租约防多开: 若上一条还在跑, 顶掉它(它会在下一步 assertActive 处自停)
  if (chainLease) chainLease.cancel();
  const lease = createExecutionLease({ timeoutMs: 10 * 60 * 1000 });
  chainLease = lease;
  const out = $("chainOut");
  const msg = $("chainMsg");
  out.style.display = "block";
  out.innerHTML = "重放中…";
  msg.textContent = "";
  $("btnReplayChain").disabled = true;
  try {
  // 单条超时: 引用 replay.js 导出的单源常量(replayFn 内建看门狗), 不再双字面量 ——
  // 侧栏收紧它时 runChain 的 opts 兜底同步生效, 不会出现"链路重放 60s 但引擎侧仍 60s"的漂移。
  // (replayFn 函数体内因注入序列化限制仍是字面量, 见 replay.js SINGLE_TIMEOUT_MS 注释)
  const SINGLE_TIMEOUT_MS = SINGLE_TIMEOUT_MS_OUTER;
  // 有 AI 依赖链则应用到本次重放: 把 [from] 接口的响应字段值注入到 [to] 请求的对应参数(自动联调)
  const injector = aiChain && aiChain.length ? applyAiChain(vis, aiChain) : null;
  // AI 断言: 按 method+path 匹配, 命中用业务断言判定, 否则退回文本 diff
  const assertFor = (e) => (aiAsserts && aiAsserts.get(e.method + " " + e.path)) || null;
  const chainRun = runChain(vis, t.id, {
    lease,
    singleTimeoutMs: SINGLE_TIMEOUT_MS,
    beforeRequest: (e, i) => injector ? injector.inject(e, aiChain) : e,
    afterRequest: (e, i, live) => { if (injector && live && live.text) injector.note(i, e, live.text); },
    assertFor,
    onProgress: (i, total, e, r) => {
      const icon = r.verdict === "OK" ? "✅" : r.verdict === "DIFF" ? "🟡" : r.verdict === "FAIL" ? "❌" : "💥";
      out.appendChild(document.createTextNode(`重放 ${i}/${total} ${icon} ${e.method} ${shortPath(e)} ${r.msg}\n`));
      msg.textContent = `第 ${i}/${total} 条…`;
    },
  });
  const results = await chainRun.run();
  if (chainLease === lease) chainLease = null;
  // 租约被顶(用户又点了一次重放): 本次静默退出, 让新重放接管输出区
  if (lease.stopKind() === "cancelled" && chainLease && chainLease !== lease) return;
  $("btnReplayChain").disabled = false;
  // AI 链注入回执: 哪些参数链真实生效/哪些没生效, 先于 diff 汇总展示 ——
  // 出差异时先看这里, 分清"链没生效"还是"接口真变了"。
  let receiptNote = "";
  if (injector) {
    const rep = injector.report();
    if (rep.applied.length || rep.missing.length) {
      // 回执串拼了链的 var/toParam/fromJsonPath(AI 产出可被录制内容诱导注入 HTML)——
      // 整体过 escHtml 后进 innerHTML, 其余同行注入点(escHtml(method/path/msg))同语义。
      receiptNote = "\n== AI 参数链 ==\n" +
        (rep.applied.length ? rep.applied.map((s) => `  ✅ ${escHtml(s)}`).join("\n") + "\n" : "") +
        rep.missing.map((s) => `  ⚠ ${escHtml(s)}`).join("\n") + "\n";
    }
  }
  const ok = results.filter((r) => r.verdict === "OK").length;
  const diff = results.filter((r) => r.verdict === "DIFF").length;
  const fail = results.filter((r) => r.verdict === "FAIL").length;
  const err = results.filter((r) => r.verdict === "ERR").length;
  const stopNote = lease.stopKind() === "timeout"
    ? `\n⚠ 已达 10 分钟上限自动停止(完成 ${results.length}/${vis.length} 条; 可分批重放)`
    : (results.length < vis.length ? `\n⚠ 已中止(完成 ${results.length}/${vis.length} 条)` : "");
  msg.textContent = `完成: 一致 ${ok}  有差异 ${diff}  状态码变化 ${fail}  错误 ${err}${lease.stopKind() ? " (已中止)" : ""}`;
  out.innerHTML = `== 链路重放汇总 == 一致 ${ok} / 差异 ${diff} / 状态码 ${fail} / 错误 ${err}${stopNote}\n` + results.map((r) =>
    `${r.verdict === "OK" ? "✅" : r.verdict === "DIFF" ? "🟡" : r.verdict === "FAIL" ? "❌" : "💥"} ${escHtml(r.entry.method)} ${escHtml(shortPath(r.entry))} ${escHtml(r.msg)}`).join("\n") + receiptNote + "\n\n" + out.innerHTML;
  // 有失败/差异条目 → 亮出"AI 调试"按钮
  const bad = results.filter((r) => r.verdict !== "OK");
  $("btnChainAiDiag").style.display = bad.length ? "" : "none";
  chainResults = bad;
  // 落 storage, 供 diffTriage 技能「点一下自动取数」(每条 DIFF 存 录制 vs 重放 两侧快照)
  // 全 OK 轮也 remove: 上一轮的坏快照若不清, 用户"修完了重放全绿"后 diffTriage 仍会
  // 判定旧 DIFF —— 快照键必须与"最近一次重放"严格同步, 而不是"最近一次出问题的重放"。
  const diffSnaps = results
    .filter((r) => r.verdict === "DIFF" || r.verdict === "FAIL")
    .map((r) => ({ recorded: r.entry, live: { status: r.live.status, text: r.live.text || "" } }));
  if (diffSnaps.length) chrome.storage.local.set({ "toolbox.lastChainDiff": diffSnaps }, () => {});
  else chrome.storage.local.remove("toolbox.lastChainDiff", () => {});
  } catch (err) {
    // runChain 逐条有保护, 但 injector.inject(beforeRequest 回调)在逐条 try 外 ——
    // 链数据畸形时 run() 会 reject 到这里; catch 给可读错误并解锁, 不留永锁。
    if (chainLease === lease) chainLease = null;
    $("chainMsg").textContent = "重放异常: " + (err && err.message ? err.message : err);
  } finally {
    $("btnReplayChain").disabled = false;
  }
}
$("btnReplayChain").onclick = runChainReplay;

// ---------- AI 调试重放失败(A2 闭环) ----------
// 把链路重放里非 OK 的请求喂给 LLM, 给修复建议; 可选自动重试(把 LLM 修正后的 body 重发)。
async function aiDebugFailures() {
  const btn = $("btnChainAiDiag");
  if (btn.disabled) return;
  const bad = chainResults;
  if (!bad.length) { setRecStatus("没有失败/差异条目可调试", "ok"); return; }
  // 上限与 aiBuildAsserts 的 30 接口拒绝同语义: 单次合并 prompt 无截断明示可言
  // (不是"少发了"而是"拒绝并指引"), 全 ERR 大集(3000 条)会合成 15MB+ prompt ——
  // 网关 413/超时烧一次白调用, 且 120s 超时兜的是"挂死"不是"太大"。
  if (bad.length > 20) {
    setRecStatus(`失败/差异 ${bad.length} 条超出单次调试上限 20 条 —— 先用过滤/勾选缩小重放范围(核心链路优先)`, "err");
    return;
  }
  btn.disabled = true;
  try {
    const out = $("chainOut");
    out.style.display = "block";
    out.innerHTML = "AI 调试中…";
    setRecStatus(`AI 分析 ${bad.length} 条失败/差异请求…`, "");
    // 每条单独诊断(结合其前后 3 条录制上下文)。
    // ⚠ 消息结构: OpenAI 协议 system 只在开头 —— 多条 bad 的 prompt 交错合并成
    // [sys1,user1,sys2,user2] 会被部分网关拒/行为异常。合并成单 system + 分节 user。
    const blocks = [];
    for (let i = 0; i < bad.length; i++) {
      const r = bad[i];
      const idx = entries.findIndex((x) => x.id === r.entry.id);
      const ctx = entries.slice(Math.max(0, idx - 3), idx + 4);
      const base = buildDiagnosePrompt(r.entry, ctx);
      blocks.push(base[1].content); // base[0] 是同一个 system, 只取 user 部分
    }
    const sys = buildDiagnosePrompt(bad[0].entry, [])[0];
    const sysPatch = String(sys.content).replace(
      "用户在浏览器里操作一个网页系统时,某条请求失败了。",
      "用户在浏览器里操作一个网页系统时,若条请求失败了(用户消息里按【失败 N】分节)。逐条给结论。");
    const msgs = [
      { role: "system", content: sysPatch },
      { role: "user", content: blocks.map((b, i) => `【失败 ${i + 1}】\n${b}`).join("\n\n===== 下一条 =====\n\n") },
    ];
    const r = await callLlm(msgs, { temperature: 0.2 });
    if (!r.ok) { setRecStatus("AI 调试失败: " + r.error, "err"); return; }
    out.innerHTML = `<span class="hd2">AI 失败调试(基于最近一次链路重放)</span>\n\n${escHtml(r.content)}`;
    setRecStatus(`✓ AI 调试完成 · ${bad.length} 条`, "ok");
  } catch (err) {
    setRecStatus("AI 调试异常: " + (err && err.message ? err.message : err), "err");
  } finally {
    btn.disabled = false;
  }
}
$("btnChainAiDiag").onclick = aiDebugFailures;

// ---------- AI 生成断言(A3) ----------
// 为当前导出集的每条接口生成业务断言, 存 toolbox.aiAsserts;
// 链路重放时若某条有断言则用断言判定成败(状态码 200 但含业务错误码也算失败)。
let aiAsserts = null; // Map: path -> [{type,target,expect}]
async function aiBuildAsserts() {
  const btn = $("btnAiAssert");
  if (btn.disabled) return;
  const src = exportSet();
  if (!src.length) { setRecStatus("没有可分析的请求", "err"); return; }
  btn.disabled = true;
  // 去重后接口数上限: 串行逐条调 LLM, 40 条 × 10~30s 可能烧 20 分钟且不可中断 ——
  // 超上限直接拒绝并指引(先过滤缩集), 而不是让用户"点一下等一集电视剧"。
  const uniqKeys = new Set(src.map((e) => e.method + " " + e.path));
  if (uniqKeys.size > 30) {
    btn.disabled = false;
    setRecStatus(`导出集有 ${uniqKeys.size} 个接口, 断言生成上限 30 个 —— 先用过滤/勾选缩小集(如只留核心链路)`, "err");
    return;
  }
  try {
    setRecStatus(`AI 生成断言中…(${uniqKeys.size} 个接口, 每个约 10~30s)`, "");
    const out = $("chainOut");
    out.style.display = "block";
    out.innerHTML = "生成断言中…";
    const map = new Map();
    const seen = new Set();
    let done = 0, failed = 0;
    for (const e of src) {
      const key = e.method + " " + e.path;
      if (seen.has(key)) continue;
      seen.add(key);
      done++;
      out.innerHTML = `生成断言中… ${done}/${uniqKeys.size}(接口)`;
      const msgs = buildAssertPrompt(e);
      const r = await callLlm(msgs, { temperature: 0 });
      if (!r.ok) { failed++; continue; }
      let arr;
      try { arr = extractChainJson(r.content); } catch { arr = []; } // extractChainJson 已 JSON.parse, 勿再包一层
      const valid = Array.isArray(arr) ? arr.filter((a) => a && a.type && a.target) : [];
      if (valid.length) map.set(key, valid);
    }
    if (!map.size) {
      out.innerHTML = "AI 没生成出可用断言(可能响应是空/二进制, 或模型输出不满足 JSON 约束)。";
      setRecStatus("断言生成失败", "err");
      return;
    }
    aiAsserts = map;
    chrome.storage.local.set({ "toolbox.aiAsserts": Array.from(map.entries()).map(([k, v]) => ({ path: k, asserts: v })) }, () => {});
    setRecStatus(`✓ 已生成 ${map.size} 组接口断言 (跳过重复 ${seen.size - map.size} 个, 失败 ${failed} 个)。链路重放时自动生效。`, "ok");
    out.innerHTML = `<span class="hd2">AI 业务断言</span>\n` + Array.from(map.entries()).map(([k, v]) =>
      `${escHtml(k)}\n  ` + v.map((a) => `${a.type} ${escHtml(a.target)} ${escHtml(a.expect || "")}`).join("\n  ")).join("\n\n");
  } catch (err) {
    setRecStatus("AI 断言生成异常: " + (err && err.message ? err.message : err), "err");
  } finally {
    btn.disabled = false;
  }
}
$("btnAiAssert").onclick = aiBuildAsserts;

// ---------- AI 依赖链应用(自动联调) ----------
// 在重放前把条目列表按链改写: 每条的请求参数若命中某链的 to, 用对应 [from] 接口的
// 录制响应字段值(或前序重放的真实值)填充。串行重放下, [from] 先跑完, 值来自 live 响应。
// 实现: 重放循环里收集每个接口的最新响应 JSON, 按 fromJsonPath 取字段, 注入到 to 参数。
function applyAiChain(entries, chain) {
  // 返回一个"运行时提取器": 重放引擎每完成一条, 把 live.text 的 JSON 值喂给它,
  // 它维护 liveValues: from接口 → 提取的字段值; 并返回该条目被注入后的请求体/头/url。
  // from/to 的定位: 优先按建链时快照的 fromId/toId(条目 id), 下标只作旧数据兜底 ——
  // 建链后过滤/勾选/清洗改变导出集时, 下标会指到错条目(静默错注入), id 定位不受集变化影响。
  const indexOfEntry = (c, which) => {
    const id = which === "from" ? c.fromId : c.toId;
    if (id != null) {
      const i = entries.findIndex((x) => x.id === id);
      return i; // -1 = 建链时的条目已不在本次重放集 → 该链不适用
    }
    const raw = which === "from" ? c.from : c.to;
    return (raw >= 0 && raw < entries.length) ? raw : -1;
  };
  const liveValues = new Map(); // key: `fromId|fromJsonPath`(或旧数据 `from下标|path`) → 值
  const extractFromLive = (idx, fromJsonPath, text) => {
    try {
      const j = JSON.parse(text);
      // 支持 a.b.c 路径与数字下标(a.list.0.id); 数组字段省略下标时默认取首元素
      let v = j;
      for (const seg of fromJsonPath.split(".").filter(Boolean)) {
        if (v == null) return null;
        if (Array.isArray(v) && !/^\d+$/.test(seg)) v = v[0];
        v = v[seg];
      }
      if (v == null) return null; // 路径不存在 → 无值(勿 String(undefined)="undefined" 注进去)
      return (typeof v === "object") ? JSON.stringify(v) : String(v);
    } catch { return null; }
  };
  // 注入回执: 链生效情况要对用户可见 —— 命中了哪些、哪些该注没注上(值未就绪/条目不在集),
  // 否则重放结果是"链生效了还是压根没生效"的黑盒, 出差异无从归因。
  const applied = [];   // `${c.var}→${target}` 成功注入
  const missing = [];   // 该注入但没值(源不在集/响应结构变了/提取路径空)
  const inject = (e, chain) => {
    let body = e.body || "";
    let query = e.query || "";
    let headers = Object.assign({}, e.headers || {});
    let url = e.url || "";
    for (const c of chain) {
      const toIdx = indexOfEntry(c, "to");
      // 目标不在本次集(过滤/裁剪)或不是本条 → 跳过。【有意不给回执】(与 from 悬空的
      // missing 分支相反): to 条目被过滤词/勾选/裁剪排除是用户主动行为, 链"不适用"
      // 用户可知; 且只重放业务段时建过的多链大多 to 不在集, 全报会把回执区淹没。
      // 链建了什么在 renderChainPreview 渲染面始终可见。from 悬空才需要 missing ——
      // 用户看不出"源响应为什么没取到值", 归因要靠回执。
      if (toIdx < 0 || entries[toIdx] !== e) continue;
      const fromIdx = indexOfEntry(c, "from");
      const key = (c.fromId != null ? c.fromId : c.from) + "|" + c.fromJsonPath;
      if (fromIdx < 0) { missing.push(`${c.var}: 源请求不在本次重放集`); continue; } // 源条目不在集 → 无值可注
      if (fromIdx > toIdx) { missing.push(`${c.var}: 源请求在目标之后(链无效)`); continue; }
      const val = liveValues.get(key);
      if (val == null || val === "null") {
        missing.push(`${c.var}: ${c.fromJsonPath || "响应"} 在源响应里没取到值`);
        continue;
      }
      const target = c.toParam || "";
      let hit = false;
      if (/^header\./i.test(target)) {
        const k = target.slice(7);
        if (k) { headers[k] = val; hit = true; }
      } else if (/^url\./i.test(target)) {
        const k = target.slice(4);
        const v = encodeURIComponent(val);
        const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        // 依次尝试: 条目 query 字段 / URL query / 路径段 /{k}/ (前一级未命中才试下一级)
        if (query && new RegExp(`(^|&)${esc(k)}=`).test(query)) {
          query = query.replace(new RegExp(`(^|&)${esc(k)}=[^&]*`), (_m, p1) => `${p1}${k}=${v}`);
          hit = true;
        } else if (url.includes(k + "=")) { url = url.replace(new RegExp(`(^|&|\\?)${esc(k)}=[^&]*`), (_m, p1) => `${p1}${k}=${v}`); hit = true; }
        else { const before = url; url = url.replace(new RegExp(`/${esc(k)}/[^/?]+`), () => `/${k}/${v}`); hit = url !== before; } // 路径段: 连同段值整体替换; 没命中(hit=false)如实上报
      } else {
        const leaf = target.split(".").pop().replace(/\s/g, "");
        if (leaf) {
          const v = encodeURIComponent(val);
          // leaf 来自 AI 输出(toParam), 可能带正则元字符 —— 与 correlate.applyDynamics
          // 同规则 esc, 否则 "+(" 之类的字段名会让 new RegExp 抛错或语义错乱
          const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const le = esc(leaf);
          let bodyHit = false, qHit = false;
          // body 文本替换(字符串值 / 裸值)。用函数式替换: 值来自响应提取,
          // 若含 $& / $1 等字符, 字符串替换形式会被 JS 展开成匹配文本, 破坏 body。
          // JSON 字符串转义序: 先反斜杠后引号 —— 只转义引号时, 值里的字面 \ (如 Windows
          // 路径 C:\Users)产出的 C:\U 是非法转义, 重放端 JSON.parse 直接炸; 即使侥幸是
          // \b 这类合法转义, 语义也被换成退格符 —— 值被静默毁掉。表单体分支无此问题
          // (encodeURIComponent 把 \ 一并编码)。
          const safeVal = val.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
          const jsonBody = body.replace(new RegExp(`"${le}"\\s*:\\s*"[^"]*"`), () => { bodyHit = true; return `"${leaf}": "${safeVal}"`; });
          if (bodyHit) { body = jsonBody; }
          else {
            const jsonBody2 = body.replace(new RegExp(`"${le}"\\s*:\\s*[0-9A-Za-z_.-]+`), () => { bodyHit = true; return `"${leaf}": "${safeVal}"`; });
            if (bodyHit) body = jsonBody2;
            else {
              // 表单体 k=v&k2=v2(application/x-www-form-urlencoded): AI 建链不该
              // 只认 JSON —— 内网老系统大量是表单 POST, 值需 URL 编码
              const formBody = body.replace(new RegExp(`(^|&)${le}=[^&]*`), (_m, p1) => { bodyHit = true; return `${p1}${leaf}=${v}`; });
              if (bodyHit) body = formBody;
            }
          }
          // query 参数替换
          const q2 = query.replace(new RegExp(`(^|&)${le}=[^&]*`), (_m, p1) => { qHit = true; return `${p1}${leaf}=${v}`; });
          if (qHit) query = q2;
          if (!qHit) url = url.replace(new RegExp(`(^|&|\\?)${le}=[^&]*`), (_m, p1) => { qHit = true; return `${p1}${leaf}=${v}`; });
          hit = bodyHit || qHit;
        }
      }
      if (hit) applied.push(`${c.var} → ${target}`);
      else missing.push(`${c.var} → ${target}: 请求里找不到该参数(参数名变了?)`);
    }
    // url 的 query 部分以最终 query 为准重建: 条目无独立 query 字段时(旧数据), 从 url 解析出的 query 也并入。
    const qm = url.indexOf("?");
    const urlQuery = qm >= 0 ? url.slice(qm + 1) : "";
    const finalQuery = query || urlQuery;
    const base = qm >= 0 ? url.slice(0, qm) : url;
    const finalUrl = finalQuery ? base + "?" + finalQuery : base;
    return { ...e, body, query, headers, url: finalUrl };
  };
  // note: 重放每完成一条(i 为本次重放集的下标), 若该条是某链的 from → 提取 live 值。
  // 键用 fromId(建链快照), 旧数据(无 fromId)退回 from 下标 —— 与 inject 的取键对称。
  // 多级链(A→B→C)天然成立: liveValues 按 from 接口各自存值, A 的值在 B、C 注入时都还在。
  return { inject, note: (i, e, text) => {
    for (const c of chain) {
      const fromIdx = indexOfEntry(c, "from");
      if (fromIdx !== i) continue;
      liveValues.set((c.fromId != null ? c.fromId : c.from) + "|" + c.fromJsonPath, extractFromLive(i, c.fromJsonPath, text));
    }
  }, report: () => ({ applied, missing }) };
}

// ---------- AI 技能选择器 + 通用执行 ----------
// 下拉框列出全部内置 skill(基础/进阶两组), 选中后「▶ 执行」用该技能分析当前导出集。
// 各 skill 的输入不同, 按 name 分发; 输出统一渲染到 expOut(带复制/下载)。
function initSkillSel() {
  const sel = $("skillSel");
  if (!sel) return;
  sel.innerHTML = "";
  const cats = {};
  for (const s of BUILTIN_SKILLS) (cats[s.category || "其他"] = cats[s.category || "其他"] || []).push(s);
  for (const cat of Object.keys(cats)) {
    const g = document.createElement("optgroup");
    g.label = cat;
    for (const s of cats[cat]) {
      const o = document.createElement("option");
      o.value = s.name;
      // select 下拉自适应宽度(最长 option 78 字符会撑到超出侧栏), title 兜底完整描述——
      // 截断在 select 渲染层发生(CSS 限宽), option 数据保持全文, 下拉列表里原生换行/截断均可读
      o.textContent = `${s.name} — ${s.description}`;
      o.title = s.description;
      g.appendChild(o);
    }
    sel.appendChild(g);
  }
}
initSkillSel();

// 把 skill 的执行结果渲染到 expOut(统一带复制/下载按钮)
function renderSkillResult(title, content, mdName) {
  const el = $("expOut");
  el.style.display = "block";
  const idC = "skillCopy", idS = "skillSave";
  el.innerHTML = `<span class="hd2">${escHtml(title)}</span> ` +
    `<button class="btn" id="${idC}" style="padding:2px 8px;font-size:11px">📋 复制</button>` +
    `<button class="btn" id="${idS}" style="padding:2px 8px;font-size:11px">⬇ 下载 .md</button>` +
    `\n\n${escHtml(content)}`;
  el.scrollIntoView({ behavior: "smooth", block: "nearest" });
  $(idC).onclick = async () => {
    try { await navigator.clipboard.writeText(content); setStatus("✓ 已复制", "ok"); }
    catch { setStatus("复制失败, 请手动框选", "err"); }
  };
  $(idS).onclick = () => downloadText(`${mdName || "skill"}_${stamp()}.md`, content, "text/markdown");
}

// 通用 skill 执行: 按 skill.name 决定输入
async function runSelectedSkill() {
  const sel = $("skillSel");
  const btn = $("btnRunSkill");
  if (!sel || btn.disabled) return;
  const skill = getSkill(sel.value);
  if (!skill) { setStatus("未找到该技能", "err"); return; }
  // 提前校验(开始态之前): perf/diffTriage 的取数失败不能发生在"分析中…"已闪之后 ——
  // 用户点执行 → 状态栏说"分析中" → 立刻变"还没有冒烟统计" —— 开始态是误导。
  // 两技能不依赖导出集, 先校验数据源; 其余技能走导出集校验。
  if (skill.name === "perf") {
    const st = (await chrome.storage.local.get(["toolbox.lastLoadTest"]))["toolbox.lastLoadTest"];
    if (!st) { setStatus("还没有冒烟统计: 先在详情页 🔥 冒烟 跑一次。", "err"); return; }
  } else if (skill.name === "diffTriage") {
    const snaps = (await chrome.storage.local.get(["toolbox.lastChainDiff"]))["toolbox.lastChainDiff"];
    if (!snaps || !snaps.length) { setStatus("还没有 DIFF 快照: 先点 ▶ 链路重放。", "err"); return; }
  }
  btn.disabled = true;
  try {
    const src = exportSet();
    if (!src.length) { setStatus("没有可分析的请求(先录制或勾选)", "err"); return; }
    // 各 prompt 内部按 maxEntries 截断(report/inventory/sensitive 60, chain/doc 40)——
    // 截断必须对用户明示(与 aiReport 独立按钮同语义: "超上限截断"明说, 不静默),
    // 否则"以为分析了 100 条, LLM 只看到 60 条", 违背 README 截断明示承诺。
    const SKILL_MAX = { report: 60, chain: 40, doc: 40, inventory: 60, sensitive: 60 };
    const max = SKILL_MAX[skill.name];
    const truncated = max && src.length > max;
    const n = src.length;
    setStatus(`「${skill.name}」分析中…(${n} 条${truncated ? ` ,超上限只发前 ${max} 条(过滤/勾选可缩范围全量分析)` : ""}, 10~30s)`, "");
    const t0 = Date.now();
    let msgs, title, mdName;
    switch (skill.name) {
      case "perf": { // 冒烟解读: 从最近一次就地冒烟(storage)自动取统计
        const st = (await chrome.storage.local.get(["toolbox.lastLoadTest"]))["toolbox.lastLoadTest"];
        msgs = buildPerfPrompt(st.entry || src[0], st);
        title = "AI 冒烟解读"; mdName = "perf_analysis";
        break;
      }
      case "diffTriage": { // 契约破坏判定: 从最近一次链路重放(storage)自动取 DIFF 快照
        const snaps = (await chrome.storage.local.get(["toolbox.lastChainDiff"]))["toolbox.lastChainDiff"];
        // 每次只判定第一条 DIFF(避免 prompt 爆炸)。多条 DIFF 时 [0] 不手动轮转 ——
        // 工作流是"判第 1 条 → 修复 → 再重放 → 快照随重放演进": 修复生效的条目变 OK
        // 从快照消失, 下一条自然升为 [0]; 强行消费快照会破坏"最近一次重放全量"语义。
        const s0 = snaps[0];
        msgs = buildDiffTriagePrompt(s0.recorded, s0.live);
        title = `AI 契约判定(${snaps.length} 条 DIFF, 先判第 1 条${snaps.length > 1 ? " —— 修复后重新链路重放, 剩余差异会依次进入判定" : ""})`; mdName = "diff_triage";
        break;
      }
      case "sensitive": msgs = buildSensitiveScanPrompt(src); title = "AI 敏感字段扫描"; mdName = "sensitive_scan"; break;
      case "inventory": msgs = buildInventoryPrompt(src); title = "AI 接口清单"; mdName = "api_inventory"; break;
      case "session": {
        // 会话特征回填: 用 auth.js 识别结果区分 hits/misses
        const auto = autoDetectPrelude(src);
        const hits = src.filter((e) => auto.ids.has(e.id)).map((e) => ({ method: e.method, path: e.path, rule: auto.reasons.get(e.id) }));
        const misses = src.filter((e) => !auto.ids.has(e.id));
        msgs = buildSessionFeaturePrompt(src, { hits, misses });
        title = "AI 会话特征回填"; mdName = "session_features";
        break;
      }
      case "report": msgs = buildReportPrompt(src); title = "AI 流量报告"; mdName = "ai_report"; break;
      case "chain": msgs = buildChainPrompt(src); title = "AI 参数依赖链"; mdName = "ai_chain"; break;
      case "doc": msgs = buildDocPrompt(src); title = "AI 接口文档"; mdName = "api_doc"; break;
      case "assert": title = "AI 断言"; mdName = "ai_assert"; break; // 单独处理(逐条+存库)
      case "diagnose": title = "AI 诊断"; mdName = "ai_diagnose"; break; // 单独处理(需选中条目)
      default: msgs = buildReportPrompt(src); title = "AI 分析"; mdName = "ai_analysis";
    }
    if (skill.name === "assert") {
      // 复用 aiBuildAsserts 逻辑(逐条生成断言, 存 toolbox.aiAsserts)
      await aiBuildAsserts();
      return;
    }
    if (skill.name === "diagnose") {
      // 需要选中一条失败请求; 否则退化为"逐条诊断前 5 条失败"
      const fail = src.filter((e) => e.status >= 400);
      if (!fail.length) { setStatus("诊断需要一条失败请求(状态≥400), 当前导出集没有。", "err"); return; }
      const e = fail[0];
      const idx = entries.findIndex((x) => x.id === e.id);
      const ctx = entries.slice(Math.max(0, idx - 5), idx).concat(entries.slice(idx + 1, idx + 6));
      msgs = buildDiagnosePrompt(e, ctx);
    }
    const r = await callLlm(msgs, { temperature: skill.name === "chain" ? 0 : 0.2 });
    if (!r.ok) { setStatus("分析失败: " + r.error, "err"); return; }
    if (skill.name === "chain") {
      const chain = refineChainDirection(validateChain(extractChainJson(r.content)), src);
      aiChain = chain;
      if (chain.length) {
        // 与 aiBuildChain 同一套 id 快照(applyAiChain/applyAiChainToJmx 按 id 定位)
        const ids = src.map((e) => e.id);
        for (const c of aiChain) { c.fromId = ids[c.from] || null; c.toId = ids[c.to] || null; }
        chrome.storage.local.set({ "toolbox.aiChain": chain }, () => {});
      } else {
        chrome.storage.local.remove("toolbox.aiChain", () => {});
      }
      setStatus(chain.length
        ? `✓ 已建 ${chain.length} 条参数依赖链。重放/导出 JMX 时自动应用。`
        : "AI 没找出跨接口参数传递(可能本链路本就无跨接口依赖)。", chain.length ? "ok" : "");
      renderChainPreview();
      return;
    }
    setStatus(`✓ 完成 · ${n} 条${truncated ? `(LLM 实际分析前 ${max} 条)` : ""} · 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`, "ok");
    renderSkillResult(title, r.content, mdName);
  } catch (err) {
    // 与其余 5 个 AI 入口同语义: prompt 构造/callLlm 的任何同步 throw 给可读错误,
    // 不留 unhandled rejection(此前 try/finally 只有解锁, throw 会零提示)
    setStatus("AI 分析异常: " + (err && err.message ? err.message : err), "err");
  } finally {
    btn.disabled = false;
  }
}
$("btnRunSkill").onclick = runSelectedSkill;

// ---------- 初始化 ----------
// 状态同步 = 打开时主动拉一次 + storage 推送(见 onChanged 监听):
// recState 已有 toolbox.recording 推送, 条数已有 harvest 增量推送, 2s 轮询
// 每次都 sendMessage 唤醒 worker —— 侧栏常驻打开时 service worker 永不睡眠。
// refreshState 保留为"打开/操作后主动拉取"(诊断字段 attachedTabs/unmatched 空态要用)。
loadHarvest();
refreshState();