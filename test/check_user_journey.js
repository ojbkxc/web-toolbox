// check_user_journey.js —— 用户旅程可用性闸门(v1.1.48)
//
// 为什么需要: 单元/契约闸门全绿不代表"新人装完能用"。已知的真实摩擦点:
//   ① manifest 里没有 commands 定义 → 扩展快捷键页是空的, 用户按 Ctrl+Shift+... 没反应也无从发现;
//   ② 录制中"停止/暂停/继续"三个按钮是 display:none 切换的 —— 若某个状态分支漏改 display,
//      用户会看到"按钮消失了", 而不是错误;
//   ③ 未配置域名时 popup 必须藏录制按钮并给出"一键添加"入口(否则点了没反应);
//   ④ 侧栏空态必须给出下一步指引(不能只显示空白列表)。
// 这些"看不见的可用性"没有断言, 回归时最先坏。
//
// 手法: 静态结构断言(manifest 字段 / HTML 控件存在) + vm 行为断言(popup 状态机按钮显隐)。
const fs = require("fs");
const vm = require("vm");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");

let fails = 0;
const ok = (name, cond, got) => {
  if (cond) console.log("  OK " + name);
  else { fails++; console.log("FAIL " + name + " → " + JSON.stringify(got)); }
};

// ---------- ① manifest 快捷键 ----------
const mf = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
ok("manifest 定义了 commands(快捷键/命令面板可发现)", !!mf.commands && Object.keys(mf.commands).length > 0,
  mf.commands || "缺 commands");
if (mf.commands) {
  const keys = Object.keys(mf.commands);
  ok("commands 数量 >= 2(开/停录制至少两条)", keys.length >= 2, keys);
  const bad = keys.filter((k) => !mf.commands[k].description || !mf.commands[k].description.trim());
  ok("每条 command 都有 description(命令面板里要显示给人看)", bad.length === 0, bad);
  // 快捷键不是必填(可让用户在 chrome://extensions/shortcuts 自配), 但若写了必须是合法形态
  const badKey = keys.filter((k) => mf.commands[k].suggested_key
    && !/^(Ctrl|Alt|Command|MacCtrl)(\+(Shift|Alt|Ctrl))*\+[A-Z0-9]$|^F[1-9]$/.test(mf.commands[k].suggested_key.default || "Ctrl+Shift+Y"));
  ok("suggested_key 形态合法(或留空让用户自配)", badKey.length === 0, badKey);
}

// ---------- ② popup 控件齐 ----------
const html = fs.readFileSync(path.join(ROOT, "popup", "popup.html"), "utf8");
for (const id of ["btnRecord", "btnStop", "btnPause", "btnResume", "openPanel", "btnExpAll"]) {
  ok(`popup 有 #${id}`, new RegExp(`id="${id}"`).test(html), "缺控件");
}

// ---------- ③④ 侧栏空态指引 ----------
const spHtml = fs.readFileSync(path.join(ROOT, "sidepanel", "sidepanel.html"), "utf8");
const spJs = fs.readFileSync(path.join(ROOT, "sidepanel", "sidepanel.js"), "utf8");
ok("侧栏有未配置域名的空态指引", /未配置域名|还没有配置域名/.test(spJs), "缺空态文案");
ok("侧栏空态给出'去配置'入口", /openOptionsPage|去配置|打开配置/.test(spJs), "缺入口");

// ---------- ⑤ popup 状态机按钮显隐(vm 行为级) ----------
// 简化环境: 只加载 popup.js 需要的 DOM/chrome; 通过 refresh 驱动各状态, 断言 display 组合。
function newEnv(state) {
  const els = new Map();
  const mk = (id) => {
    const el = {
      id, style: {}, dataset: {}, children: [], value: "", textContent: "", innerHTML: "",
      className: "", checked: false, disabled: false, placeholder: "",
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      addEventListener() {}, setAttribute() {}, appendChild() {}, insertBefore() {},
      querySelector() { return null; }, querySelectorAll() { return []; }, focus() {},
    };
    els.set(id, el);
    return el;
  };
  const store = {
    "toolbox.domains": state.domains || [],
    "toolbox.recording": state.recState === "idle" ? null : { state: state.recState, tabId: 1 },
    "toolbox.harvest": { v: 1, entries: Array.from({ length: state.count || 0 }, (_, i) => ({ id: "j" + i, method: "GET", url: "https://example.com/x", path: "/x", status: 200, headers: {}, body: "", response: "", ts: "", durationMs: 1 })) },
    "toolbox.llm": { url: "", model: "", api_key: "" },
  };
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    URL, URLSearchParams, AbortController, Promise, Date,
    document: { getElementById: mk, createElement: () => mk("tmp"), querySelectorAll: () => [], body: mk("body") },
    chrome: {
      runtime: {
        sendMessage: async (msg) => {
        if (msg && msg.type === "getRecInfo") {
          return { recState: state.recState, count: state.count || 0, domains: state.domains || [], unmatched: [], harvestCorrupt: false, pending: 0, attachedTabs: 0 };
        }
        return { ok: true };
      },
        onMessage: { addListener() {} }, openOptionsPage() {},
        getManifest: () => ({ version: "test" }),
      },
      storage: {
        local: {
          // 双形态: common.getDomains 用回调式 get(keys, cb); popup catch 分支用
          // await 形式(无 cb) —— 只认一种会让另一处永远 pending, 测试挂死无输出。
          get: (keys, cb) => {
            const r = {};
            for (const k of [].concat(keys)) r[k] = store[k];
            if (typeof cb === "function") { cb(r); return; }
            return Promise.resolve(r);
          },
          set: (obj, cb) => { Object.assign(store, obj); if (typeof cb === "function") cb(); return Promise.resolve(); },
        },
        onChanged: { addListener() {} },
      },
      tabs: { query: async () => [{ id: 1, url: (state.domains && state.domains[0] ? "https://" + state.domains[0] + "/" : "https://example.com/") }], create: async () => ({}) },
      sidePanel: { open: async () => {} },
      windows: { WINDOW_ID_CURRENT: -2, getCurrent: async () => ({ id: 1 }) },
      // 回调式(Chrome API 原生形态): common.containsOrigin 传 {origins} + cb,
      // async 桩返回 promise 却永不调 cb → Promise 包一层后永远 pending, refresh 挂死
      permissions: {
        contains: (p, cb) => cb(true),
        request: (p, cb) => cb(true),
      },
      action: { setBadgeText: async () => {} },
      downloads: { download: async () => {} },
    },
    navigator: { clipboard: { writeText: async () => {} } },
    fetch: async () => ({ ok: true, text: async () => "" }),
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  // popup.html 的真实加载顺序: common.js → auth.js → correlate.js → jmx.js → pyscript.js → popup.js
  // 这里按需只加载 common.js(popup 依赖 getDomains 等) + popup.js —— 不引入无关模块, 减少桩面积。
  for (const rel of ["common.js", "popup/popup.js"]) {
    const abs = path.join(ROOT, rel);
    new vm.Script(fs.readFileSync(abs, "utf8"), { filename: rel }).runInContext(sandbox);
  }
  return { sandbox, els };
}

// popup 用 style.display = "" 表示显示, "none" 表示隐藏 —— 判据只能看是否等于 none。
// 初版把 "" 也当成"未显示", 导致四条状态断言全红(而 UI 实际是对的): 判据写错 = 假红。
function shown(els, id) {
  const el = els.get(id);
  return !!el && el.style.display !== "none";
}

(async () => {
  // popup.js 在 vm 加载时自己跑顶层 refreshSafe()(152/306 行), 内部 setTimeout 排程后
  // 调 refresh() → setState()。这里不手动再调一次(重复跑无意义), 只等异步链走完。
  const settle = () => new Promise((r) => setTimeout(r, 60));
  const mkEnv = async (state) => {
    const env = newEnv(state);
    // 顶层 refreshSafe() 在 vm 加载时就排程了 refresh: setState(显隐)在第一个 await 后
    // 同步执行, 不依赖整条链完成 —— 等一拍即可断言。
    await settle();
    return env;
  };

  // 状态 A: 已配置域名 + idle → 只显示"开始录制"
  {
    const { els } = await mkEnv({ recState: "idle", count: 0, domains: ["example.com"] });
    ok("idle: 显示开始录制 / 藏停止与继续", shown(els, "btnRecord") && !shown(els, "btnStop") && !shown(els, "btnResume"),
      { rec: shown(els, "btnRecord"), stop: shown(els, "btnStop"), resume: shown(els, "btnResume") });
  }
  // 状态 B: recording → 显示停止+暂停, 藏开始
  {
    const { els } = await mkEnv({ recState: "recording", count: 3, domains: ["example.com"] });
    ok("recording: 显示停止/暂停 / 藏开始",
      shown(els, "btnStop") && shown(els, "btnPause") && !shown(els, "btnRecord"),
      { stop: shown(els, "btnStop"), pause: shown(els, "btnPause"), rec: shown(els, "btnRecord") });
  }
  // 状态 C: paused → 显示继续与停止
  {
    const { els } = await mkEnv({ recState: "paused", count: 3, domains: ["example.com"] });
    ok("paused: 显示继续/停止 / 藏暂停",
      shown(els, "btnResume") && shown(els, "btnStop") && !shown(els, "btnPause"),
      { resume: shown(els, "btnResume"), stop: shown(els, "btnStop"), pause: shown(els, "btnPause") });
  }
  // 状态 D: 未配置域名 → 藏录制, 给一键添加
  {
    const { els } = await mkEnv({ recState: "idle", count: 0, domains: [] });
    const recHidden = !shown(els, "btnRecord");
    ok("未配置域名: 藏录制按钮", recHidden, shown(els, "btnRecord"));
    ok("未配置域名: 出现一键添加入口", els.has("btnAddSite") || /btnAddSite/.test(fs.readFileSync(path.join(ROOT, "popup", "popup.js"), "utf8")),
      "缺 btnAddSite 接线");
  }

  console.log(fails ? `=== user journey FAIL: ${fails} ===` : "=== user journey PASS ===");
  process.exit(fails ? 1 : 0);
})();