// 配置页: 域名白名单(授权/撤销) + LLM 端点配置(url/model/key 可空)。

const $input = document.getElementById("input");
const $list = document.getElementById("list");
const $add = document.getElementById("add");
const $llmUrl = document.getElementById("llmUrl");
const $llmModel = document.getElementById("llmModel");
const $llmKey = document.getElementById("llmKey");
const $llmMsg = document.getElementById("llmMsg");

let domains = [];

// ---------- 域名 ----------
async function refresh() {
  domains = await getDomains();
  render();

  const cfg = await getLlmConfig();
  $llmUrl.value = cfg.url;
  $llmModel.value = cfg.model;
  $llmKey.value = cfg.api_key;
}

function render() {
  $list.innerHTML = "";
  if (!domains.length) {
    const li = document.createElement("li");
    li.innerHTML = '<div class="empty">还没有配置域名,先添加一个</div>';
    $list.appendChild(li);
    return;
  }
  for (const d of domains) {
    const li = document.createElement("li");
    const origins = domainToOrigins(d);
    // 覆盖提示: 引擎 matchDomain 是 host===d || host.endsWith('.'+d) —— 任何配置都
    // 覆盖其全部子域配置(与段数无关: a.b.com 配了 x.a.b.com 也全冗余)。此前限"<=2 段"
    // 会让多级父域的冗余子域漏标(呈现层弱于引擎语义)。endswith 判定即引擎同款, 零误标。
    const covered = domains.filter((x) => x !== d && x.endsWith("." + d));
    li.innerHTML = `
      <span class="host">${escapeHtml(d)}${covered.length ? ` <span class="covers" title="这些子域配置是冗余的, 删除不影响工作">覆盖 ${covered.map(escapeHtml).join(", ")}</span>` : ""}</span>
      <span class="state" data-state aria-label="授权状态"></span>
      <button data-edit aria-label="编辑域名 ${escapeHtml(d)}">编辑</button>
      <button data-del aria-label="删除域名 ${escapeHtml(d)}, 同时撤销授权">删除</button>`;
    li.querySelector("[data-del]").onclick = () => removeDomain(d);
    li.querySelector("[data-edit]").onclick = () => editDomain(d);
    containsOrigin(origins[0]).then((has) => {
      const el = li.querySelector("[data-state]");
      el.textContent = has ? "已授权" : "未授权";
      el.className = "state " + (has ? "ok" : "");
    });
    $list.appendChild(li);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// 添加: 同样必须手势内同步发起权限申请(前面不能有 await), 否则弹窗不弹且 granted=false
function addDomain() {
  const raw = $input.value.trim();
  if (!raw) return;
  const host = raw.replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase();
  // 无点单段主机(localhost 等)是合法目标(domainToOrigins 已支持精确授权), 不能一刀切拦;
  // 只拦明显不是主机的输入(空/带空格/纯符号)。
  if (!host || /\s/.test(host) || !/^[a-z0-9._:-]+$/i.test(host)) {
    $input.value = "";
    $input.placeholder = "看起来不是域名,请输入如 example.com";
    return;
  }
  if (!host.includes(".") && !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(host)) {
    $input.value = "";
    $input.placeholder = "单段主机只支持 localhost/127.0.0.1";
    return;
  }
  if (domains.includes(host)) {
    $input.value = "";
    return;
  }
  chrome.permissions.request({ origins: domainToOrigins(host) }, (granted) => {
    if (!granted) return;
    (async () => {
      domains = await setDomains([...domains, host]);
      $input.value = "";
      refresh();
    })();
  });
}

async function removeDomain(d) {
  await removeOrigins(domainToOrigins(d));
  domains = await setDomains(domains.filter((x) => x !== d));
  refresh();
}

// 行内编辑: 旧配置替换成新域名。
// 顺序必须是 先申请新授权(手势内同步发起), 成功才 换清单+撤旧授权 ——
// 如果先撤旧后申请新, 用户在权限弹窗点"拒绝"会两头落空(旧授权没了新授权也没拿到)。
function editDomain(d) {
  const li = [...$list.children].find((el) =>
    el.querySelector(".host")?.textContent.split(" ")[0] === d);
  if (!li) return;
  const hostSpan = li.querySelector(".host");
  const covers = li.querySelector(".covers");
  const stateEl = li.querySelector("[data-state]");
  const editBtn = li.querySelector("[data-edit]");
  const delBtn = li.querySelector("[data-del]");

  // 变成编辑态: 显示输入框 + 保存/取消
  const input = document.createElement("input");
  input.type = "text";
  input.value = d;
  input.style.cssText = "flex:1; padding:4px 8px; border:1px solid #ccc; border-radius:4px; font-size:13px";
  hostSpan.textContent = "";
  hostSpan.appendChild(input);
  hostSpan.appendChild(covers || document.createComment("")); // 保留覆盖提示
  stateEl.textContent = "";
  editBtn.textContent = "保存";
  delBtn.textContent = "取消";
  input.focus();
  input.setSelectionRange(d.length, d.length);

  const restore = () => refresh(); // 取消/失败都直接重绘回原样
  const onSave = () => {
    const raw = input.value.trim().toLowerCase();
    if (!raw || raw === d) return restore(); // 没改 = 取消
    let host = "";
    try { host = new URL(raw.includes("://") ? raw : "http://" + raw).hostname; } catch { /* 下面统一拦 */ }
    host = host || raw.replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase();
    if (!host.includes(".") && !/^(localhost|127\.0\.0\.1)$/.test(host)) {
      setMsg("✗ 看起来不是域名, 如 example.com", "err");
      return;
    }
    if (domains.includes(host)) return restore(); // 已存在, 当作无变化
    if (host.split(".").length <= 2 && domains.some((x) => x !== d && (host.endsWith("." + x) || x.endsWith("." + host)))) {
      return restore(); // 新旧有覆盖关系, 视为无变化
    }

    // 手势内同步发起权限申请(onclick 直接调, 不经 await 链 ——
    // chrome.permissions.request 对"用户手势"判定极严, 前面垫任何 await 都会失效,
    // 静默 granted=false → 表现为"保存后提示未授权"这个反人类体验)。
    chrome.permissions.request({ origins: domainToOrigins(host) }, (granted) => {
      if (!granted) { setMsg("未授权新域名, 保持原配置", "err"); return restore(); }
      // 走到这里授权已生效
      (async () => {
        const idx = domains.indexOf(d);
        domains = await setDomains(domains.map((x, i) => (i === idx ? host : x)));
        await removeOrigins(domainToOrigins(d)); // 再撤旧授权(清单已更新, 撤失败不影响功能)
        setMsg(`已改为 ${host}`, "ok");
        refresh();
      })();
    });
  };
  const onCancel = () => restore();

  editBtn.onclick = onSave;
  delBtn.onclick = onCancel;
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") onSave();
    if (e.key === "Escape") onCancel();
  });
}

// ---------- LLM 配置 ----------
// 保存: 先做纯本地校验, 再在"保存"点击手势内同步发起权限申请 ——
// 与 addDomain/editDomain 同规则: request 前垫 await 会让手势判定失效,
// 静默 granted=false(权限框根本不弹)。已授权主机 Chrome 直接回调 granted=true
// 不弹窗, 所以无需先 containsOrigin 查一遍(那正是垫 await 的根源)。
function saveLlm() {
  const url = $llmUrl.value.trim();
  if (url) {
    try {
      const u = new URL(url);
      if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("协议");
    } catch {
      setMsg("✗ API 地址不是合法的 http(s) URL", "err");
      return;
    }
  }
  let host = "";
  try { host = new URL(url).hostname; } catch { /* 留空则不授权 */ }
  if (!host) return doSaveLlm();

  chrome.permissions.request({ origins: [`http://${host}/*`, `https://${host}/*`] }, (granted) => {
    if (!granted) {
      setMsg("未授权该主机,AI 功能将无法调用", "err");
      return;
    }
    doSaveLlm();
  });
}

async function doSaveLlm() {
  await setLlmConfig({
    url: $llmUrl.value.trim(),
    model: $llmModel.value.trim() || "qwen3.7-plus",
    api_key: $llmKey.value.trim(), // 可空
  });
  setMsg("已保存", "ok");
}

async function testLlm() {
  setMsg("测试中…", "");
  // 测「输入框当前值」而非上次保存的配置 —— callLlm 从 storage 读, 用户改了
  // 输入框没保存时, 测的是旧地址: 显示 ✓ 却对新配置无证明力(保存后才炸)。
  // 偏移参数覆盖 model, api_key 走 callLlm 的显式传参。
  const url = $llmUrl.value.trim();
  const model = $llmModel.value.trim() || "qwen3.7-plus";
  const api_key = $llmKey.value.trim();
  if (!url) { setMsg("✗ 请先填写 API 地址", "err"); return; }
  // 未授权主机时 fetch 会以 Failed to fetch 结束; 先检查授权, 未授权给指引而非裸错。
  try {
    const host = new URL(url).hostname;
    const granted = await containsOrigin(`http://${host}/*`).catch(() => false)
      .then(async (h) => h || await containsOrigin(`https://${host}/*`));
    if (!granted) {
      setMsg(`✗ 未授权主机 ${host} —— 先点「保存」完成授权(保存即申请该主机的访问权限)`, "err");
      return;
    }
  } catch {
    setMsg("✗ API 地址不是合法的 http(s) URL", "err");
    return;
  }
  const r = await callLlm([
    { role: "user", content: "回复两个字:收到" },
  ], { max_tokens: 50, model, apiKey: api_key, urlOverride: url });
  if (r.ok) {
    setMsg(`✓ 连通正常,模型回复: ${r.content.trim().slice(0, 20)}`, "ok");
  } else {
    setMsg("✗ " + r.error, "err");
  }
}

function setMsg(t, cls) {
  $llmMsg.textContent = t;
  $llmMsg.className = "msg " + cls;
}

// ---------- AI 桥接 ----------
// 配置存在 chrome.storage.local 的 toolbox.bridge 里, 由 bridge-client.js 读取。
// 注意: WebSocket 必须由 service worker 发起 —— options 页面里建连接没有意义
// (页面关了就断), 所以这里只写配置, 再通过消息让 worker 立刻重连。
const KEY_BRIDGE = "toolbox.bridge";
const $bridgeUrl = document.getElementById("bridgeUrl");
const $bridgeToken = document.getElementById("bridgeToken");
const $bridgeEnabled = document.getElementById("bridgeEnabled");
const $bridgeMsg = document.getElementById("bridgeMsg");

function setBridgeMsg(t, cls) {
  $bridgeMsg.textContent = t;
  $bridgeMsg.className = "msg " + (cls || "");
}

async function loadBridgeConfig() {
  const r = await chrome.storage.local.get([KEY_BRIDGE]);
  const c = r[KEY_BRIDGE] || {};
  $bridgeUrl.value = c.url || "ws://127.0.0.1:9280/ext";
  $bridgeToken.value = c.token || "";
  $bridgeEnabled.checked = c.enabled !== false;
}

async function saveBridgeConfig() {
  const url = $bridgeUrl.value.trim() || "ws://127.0.0.1:9280/ext";
  if (!/^wss?:\/\//i.test(url)) {
    setBridgeMsg("✗ 地址必须以 ws:// 或 wss:// 开头", "err");
    return false;
  }
  const token = $bridgeToken.value.trim();
  await chrome.storage.local.set({
    [KEY_BRIDGE]: { url, token, enabled: $bridgeEnabled.checked },
  });
  // 配置变更会触发 bridge-client 的 storage.onChanged 监听自动重连, 这里无需再发消息
  setBridgeMsg(token ? "✓ 已保存" : "✓ 已保存(未填令牌, 不会连接)", "ok");
  return true;
}

async function testBridge() {
  const okSaved = await saveBridgeConfig();
  if (!okSaved) return;
  setBridgeMsg("连接中…", "");
  // 状态查询走 service worker: 它才是持有 WebSocket 的一方
  try {
    const st = await chrome.runtime.sendMessage({ type: "bridgeStatus" });
    if (st && st.connected) {
      setBridgeMsg("✓ 已连接", "ok");
    } else {
      setBridgeMsg("✗ " + ((st && st.lastError) || "未连接(bridge 启动了吗?)"), "err");
    }
  } catch (e) {
    setBridgeMsg("✗ " + String(e && e.message || e), "err");
  }
}

// ---------- 事件 ----------
$add.onclick = addDomain;
$input.addEventListener("keydown", (e) => { if (e.key === "Enter") addDomain(); });
document.getElementById("saveLlm").onclick = saveLlm;
document.getElementById("testLlm").onclick = testLlm;
document.getElementById("saveBridge").onclick = saveBridgeConfig;
document.getElementById("connectBridge").onclick = testBridge;

refresh();
loadBridgeConfig();
