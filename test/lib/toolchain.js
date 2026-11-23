// test/lib/toolchain.js —— 回归测试的外部工具收口(跨平台 + 显式 SKIP)。
//
// 背景(2026-11 走查): 早先测试用 `execSync(cmd, { shell: "bash" })` 跑 python 与
// heredoc 等待脚本。Windows 上 PATH 里只有 git.exe、没有 bash 时直接 `spawnSync bash
// ENOENT` —— 46 项门禁**环境性**变红(4/46), 与代码质量无关, 也无法在 CI/其他机器复现。
// 这里统一三条:
//   1. 永不依赖 bash / POSIX shell: 一律 spawnSync(可执行文件, argv 数组)直呼解释器;
//   2. 外部解释器按 WEBTOOLBOX_PYTHON → python → python3 → py -3 探测, 缓存结果;
//   3. 探测不到时打印 `SKIP(env) <项> — <原因>` 并计入 skipped —— 不伪装通过, 也不误报红。
//      (AGENTS.md: 环境限制用 skip 标注, 不伪装通过。)
//
// XML 合法性不再借 python xml.dom.minidom: checkXml() 是纯 JS 良构校验器, 任何机器都能跑。
// 校验口径对着 minidom: 单根、标签配对、属性加引号/不重复、文本与属性值里的 `&` 必须是
// 合法实体引用、遇 `<` 即非良构。
const { spawnSync } = require("child_process");
const http = require("http");

// ---------------- python 探测 ----------------
let probed = false;
let cached = null;

/**
 * 探测可用的 python 3 解释器。
 * @returns {{bin:string, prefix:string[]}|null}
 */
function pythonBin() {
  if (probed) return cached;
  probed = true;
  // 测试钩子: WEBTOOLBOX_NO_PYTHON=1 强制"没有解释器", 用来验证各测试的 SKIP(env) 分支
  // —— 那些分支平时永远走不到, 不模拟就等于没测(本机同时装了 python 与 py launcher,
  // 只从 PATH 摘掉 "python" 段并不能真正模拟缺解释器: py.exe 在 System32, 仍能拉起 python3)。
  if (process.env.WEBTOOLBOX_NO_PYTHON === "1") return (cached = null);
  const cands = [];
  if (process.env.WEBTOOLBOX_PYTHON) cands.push({ bin: process.env.WEBTOOLBOX_PYTHON, prefix: [] });
  cands.push({ bin: "python", prefix: [] }, { bin: "python3", prefix: [] }, { bin: "py", prefix: ["-3"] });
  for (const c of cands) {
    const r = spawnSync(c.bin, [...c.prefix, "-c", "import sys; sys.stdout.write(str(sys.version_info[0]))"], {
      encoding: "utf8", timeout: 20000, windowsHide: true,
    });
    if (!r.error && r.status === 0 && String(r.stdout).trim() === "3") {
      cached = c;
      break;
    }
  }
  return cached;
}

/**
 * 跑一段 python(argv 形态, 无 shell)。退出码非 0 / 起不来即抛错。
 * @param {string[]} args
 * @param {{timeout?:number, cwd?:string}} [opts]
 * @returns {string} stdout
 */
function pyRun(args, opts = {}) {
  const py = pythonBin();
  if (!py) throw new Error("未找到 python 3 解释器(设 WEBTOOLBOX_PYTHON 或装 python)");
  const r = spawnSync(py.bin, [...py.prefix, ...args], {
    encoding: "utf8",
    timeout: opts.timeout || 60000,
    windowsHide: true,
    cwd: opts.cwd,
    env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
  });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error(`python 退出 ${r.status}: ${String(r.stderr || "").trim().slice(0, 400)}`);
  }
  return r.stdout || "";
}

// ---------------- SKIP 记账 ----------------
const skips = [];

/** 记一条环境性跳过(打印 + 记账, 不计失败)。 */
function skip(name, reason) {
  skips.push({ name, reason });
  process.stdout.write(`SKIP(env) ${name} — ${reason}\n`);
}

function skipCount() {
  return skips.length;
}

/** 收尾用的一行摘要(没跳过时给空串, 不污染 PASS 输出)。 */
function skipSummary() {
  if (!skips.length) return "";
  return ` (SKIP ${skips.length}: ${skips.map((s) => s.name).join(", ")})`;
}

// ---------------- 等端口就绪(替代 heredoc 里的 python 轮询) ----------------
/**
 * 轮询一个 http URL 直到有响应或超时。
 * @returns {Promise<boolean>}
 */
function waitHttp(url, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = () => {
      const req = http.get(url, (res) => {
        res.resume();
        resolve(true);
      });
      req.setTimeout(1500, () => req.destroy());
      req.on("error", () => {
        req.destroy();
        if (Date.now() >= deadline) resolve(false);
        else setTimeout(attempt, 120);
      });
    };
    attempt();
  });
}

// ---------------- XML 良构校验(纯 JS) ----------------
const NAME_RE = /[A-Za-z_:][-A-Za-z0-9_:.]*/g;
const ENTITY_RE = /&(?:amp|lt|gt|quot|apos|#[0-9]+|#x[0-9A-Fa-f]+);/g;

function bad(error) {
  return { ok: false, error };
}

// 文本/属性值通用校验: 裸 `<` 非法; `&` 必须落进合法实体引用。
function textErr(text, inAttr) {
  if (text.includes("<")) return "文本含裸 `<`";
  const amp = text.indexOf("&");
  if (amp < 0) return "";
  // 把合法实体挖掉后仍有 `&` 即非法
  if (text.replace(ENTITY_RE, "").includes("&")) return "`&` 不是合法实体引用";
  if (!inAttr && text.includes("]]>")) return "文本含 `]]>`";
  return "";
}

/**
 * 校验 XML 良构性(等价 python xml.dom.minidom.parse 的接受面: 单根/配对/引号/实体)。
 * @param {string} src
 * @returns {{ok:true}|{ok:false,error:string}}
 */
function checkXml(src) {
  const s = String(src);
  const stack = [];
  let roots = 0;
  let i = 0;

  const nameAt = (from) => {
    NAME_RE.lastIndex = from;
    const m = NAME_RE.exec(s);
    return m && m.index === from ? { name: m[0], end: NAME_RE.lastIndex } : null;
  };
  const skipWs = (from) => {
    let j = from;
    while (j < s.length && /\s/.test(s[j])) j++;
    return j;
  };

  while (i < s.length) {
    const lt = s.indexOf("<", i);
    if (lt < 0) {
      const e = textErr(s.slice(i), false);
      if (e) return bad(e);
      break;
    }
    if (lt > i) {
      const e = textErr(s.slice(i, lt), false);
      if (e) return bad(e);
    }
    i = lt;

    if (s.startsWith("<!--", i)) {
      const end = s.indexOf("-->", i + 4);
      if (end < 0) return bad("注释未闭合");
      i = end + 3;
      continue;
    }
    if (s.startsWith("<![CDATA[", i)) {
      const end = s.indexOf("]]>", i + 9);
      if (end < 0) return bad("CDATA 未闭合");
      i = end + 3;
      continue;
    }
    if (s.startsWith("<?", i)) {
      const end = s.indexOf("?>", i + 2);
      if (end < 0) return bad("处理指令未闭合");
      i = end + 2;
      continue;
    }
    if (s.startsWith("<!", i)) {
      const end = s.indexOf(">", i + 2);
      if (end < 0) return bad("声明未闭合");
      i = end + 1;
      continue;
    }
    if (s.startsWith("</", i)) {
      const n = nameAt(i + 2);
      if (!n) return bad(`闭合标签名非法 @${i + 2}`);
      let j = skipWs(n.end);
      if (s[j] !== ">") return bad(`闭合标签 </${n.name}> 未结束 @${j}`);
      if (!stack.length) return bad(`多余闭合标签 </${n.name}>`);
      const open = stack.pop();
      if (open !== n.name) return bad(`标签不配对: <${open}> 与 </${n.name}>`);
      i = j + 1;
      continue;
    }

    // 开标签
    const n = nameAt(i + 1);
    if (!n) return bad(`标签名非法 @${i + 1}`);
    const attrs = new Set();
    let j = n.end;
    for (;;) {
      j = skipWs(j);
      if (j >= s.length) return bad(`标签 <${n.name}> 未结束`);
      if (s[j] === ">") {
        stack.push(n.name);
        if (stack.length === 1) roots++;
        i = j + 1;
        break;
      }
      if (s[j] === "/") {
        if (s[j + 1] !== ">") return bad(`自闭合标签 <${n.name}/> 写法非法 @${j}`);
        if (!stack.length) roots++;
        i = j + 2;
        break;
      }
      const a = nameAt(j);
      if (!a) return bad(`属性名非法 @${j}`);
      if (attrs.has(a.name)) return bad(`标签 <${n.name}> 属性重复: ${a.name}`);
      attrs.add(a.name);
      j = skipWs(a.end);
      if (s[j] !== "=") return bad(`属性 ${a.name} 缺 "=值"`);
      j = skipWs(j + 1);
      const q = s[j];
      if (q !== '"' && q !== "'") return bad(`属性 ${a.name} 的值未加引号 @${j}`);
      const end = s.indexOf(q, j + 1);
      if (end < 0) return bad(`属性 ${a.name} 的引号未闭合`);
      const e = textErr(s.slice(j + 1, end), true);
      if (e) return bad(`属性 ${a.name} ${e}`);
      j = end + 1;
    }
  }

  if (stack.length) return bad(`标签未闭合: <${stack[stack.length - 1]}>`);
  if (roots !== 1) return bad(`根元素数量 ${roots}(良构 XML 必须恰 1 个)`);
  return { ok: true };
}

// ---------------- 条件等待(替代固定 sleep) ----------------
/**
 * 轮询到 predicate 为真或超时。返回是否成立 —— 调用方仍需断言(超时后给真实失败信息,
 * 不让"睡够固定毫秒数"变成断言前提: 全量套件并发跑时 setTimeout(0) 回调链会超出固定睡眠,
 * check_options_page 曾因此 6 次跑出 5 次假红)。
 * @param {() => any|Promise<any>} pred
 * @param {{timeout?:number, interval?:number}} [opts]
 * @returns {Promise<boolean>}
 */
async function waitFor(pred, opts = {}) {
  const timeout = opts.timeout || 3000;
  const interval = opts.interval || 10;
  const deadline = Date.now() + timeout;
  for (;;) {
    let hit = false;
    try { hit = !!(await pred()); } catch { hit = false; }
    if (hit) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, interval));
  }
}

module.exports = {
  pythonBin, pyRun, skip, skipCount, skipSummary, waitHttp, checkXml, waitFor,
};
