// replay.js —— 批量链路重放 + 回归 diff(纯前端, 无 LLM)
//
// 在页面上下文按顺序重放"可见集/勾选集", 每条的响应与录制时存的响应做 diff:
//   状态码变化 → FAIL(code mismatch)
//   响应体长度/关键字段变化 → 提示不一致(标黄, 人工确认)
//   重放失败(网络错误/未授权) → ERR
// 结果出汇总表: 每行 方法 路径 状态码对比 一致/不一致, 点击可看 diff。
// 目的: 录一次 → 改完代码/参数 → 一键重放整条链路, 快速定位被破坏的接口。

// 归一化响应用于比较: 尽量剥离易变部分(时间戳/耗时/随机串), 否则几乎必然 diff。
// 策略: 数字叶子值 > 10^10(毫秒时间戳) → 归一; 保留其它。
function normalizeForCompare(text) {
  if (!text) return text;
  try {
    const j = JSON.parse(text);
    const walk = (v) => {
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === "object") {
        const o = {};
        for (const k of Object.keys(v)) o[k] = walk(v[k]);
        return o;
      }
      // 毫秒/纳秒/秒级时间戳 & 超长 token → 模糊化
      // 秒级(10 位, 1e9~2e9): 2001~2033 年的 unix 秒, 两次录制必不同 → 不归一必 DIFF 误报
      if (typeof v === "number") return (v >= 1e9) ? "~num" : v;
      if (typeof v === "string") {
        if (/^\d{10}$/.test(v) || /^\d{13,19}$/.test(v)) return "~ts";
        if (v.length > 48) return "~long";
      }
      return v;
    };
    return JSON.stringify(walk(j));
  } catch {
    // 非 JSON: 用长度 + 子串指纹(大文本只取前后 200 字符)
    return (text.length) + ":" + text.slice(0, 200) + "|" + text.slice(-200);
  }
}

// 单条看门狗默认 60s(单源): sidepanel 链路重放与 runChain 兜底共用本常量。
// 注意 replayFn 的默认参数【必须写死字面量 60000, 不能引用本常量】——
// chrome.scripting 注入只序列化函数自身源码, 顶层常量不会跟着进页面,
// 引用常量会在页面侧 ReferenceError。改超时时须两处同步(本常量 + replayFn 字面量)。
const SINGLE_TIMEOUT_MS = 60000;

// 单条重放(diff 用): 返回 {status, ok, text}
// 超时: 单条挂起(服务端 accept 后不回话/连接黑洞)时 fetch 永远不 resolve, 链路重放
// 的 10 分钟租约只在条目之间检查, 单条挂起会卡死整条链 —— 每条请求独立 60s 看门狗。
// 超时不走 reject(那会与"未授权/网络错误"混在一起不可区分), 返回 status:0 + 带 timeout 字样的 text。
function replayFn(url, method, headers, body, timeoutMs = 60000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  return fetch(url, {
    method,
    headers,
    body: body || undefined,
    credentials: "include",
    signal: ctl.signal,
  }).then((r) => r.text().then((t) => {
    clearTimeout(timer);
    return { status: r.status, ok: r.ok, text: t };
  })).catch((e) => {
    clearTimeout(timer);
    if (e && (e.name === "AbortError" || /aborted/i.test(String(e)))) {
      return { status: 0, ok: false, text: `timeout: 单条请求 ${Math.round(timeoutMs / 1000)}s 无响应(接口挂起?)` };
    }
    throw e; // 其余(网络/未授权)维持原路径: executeScript reject → 调用方 catch
  });
}

// 结果判定: 一条重放 vs 录制。
// opts.asserts: [{type:"status"|"contains"|"not_contains"|"json_eq", target, expect}]
//   由 A3「AI 生成断言」产出; 提供时重放结束用它判定业务成败 ——
//   状态码 200 但响应含业务错误码(如 ISC-999)也能判 FAIL, 不只是响应文本 diff。
function verdict(recorded, live, opts = {}) {
  const asserts = (opts && opts.asserts) || [];
  if (!live || live.status === 0) return { verdict: "ERR", msg: "网络错误/未授权" };
  // 业务断言优先(显式规则): 命中成功/失败判定
  if (asserts.length) {
    let pass = true, failMsg = "";
    for (const a of asserts) {
      const target = String(a.target || "");
      const expect = String(a.expect || "");
      if (a.type === "status" && live.status === Number(target)) continue;
      if (a.type === "contains" && live.text.includes(target)) continue;
      if (a.type === "not_contains" && !live.text.includes(target)) continue;
      // json_eq: 取 JSON 路径值与 expect 精确比较(宽松: 类型强转字符串)
      if (a.type === "json_eq") {
        try {
          const j = JSON.parse(live.text);
          let v = j;
          for (const seg of target.split(".").filter(Boolean)) {
            if (v == null) break;
            if (Array.isArray(v)) v = v[0];
            v = v[seg];
          }
          if (v != null && String(v) === expect) continue;
        } catch { /* 非 JSON → 该断言不通过 */ }
      }
      pass = false;
      failMsg = a.type + ":" + target + " 期望 " + expect;
      break;
    }
    return pass ? { verdict: "OK", msg: "断言通过" } : { verdict: "FAIL", msg: "业务断言失败 " + failMsg };
  }
  // 无断言: 退回状态码 + 响应归一 diff
  if (recorded.status !== live.status) return { verdict: "FAIL", msg: `状态码 ${recorded.status}→${live.status}` };
  const a = normalizeForCompare(recorded.response);
  const b = normalizeForCompare(live.text);
  if (a === b) return { verdict: "OK", msg: "响应一致" };
  return { verdict: "DIFF", msg: "响应体有差异(可能仅时间戳, 点开看)" };
}

// ---------- 执行租约(deepseek-pp execution.ts 模式) ----------
// 防三类真实事故:
//   1. 超时自停: 长链路某条卡死(页面被挂起/网络黑洞), 没有 deadline 就永远转圈
//   2. 租约防多开: 连点两次"链路重放"会跑出两条并发重放互相踩(结果错乱+双倍压力)
//   3. 取消语义: cancelled 布尔只停"下一条", 加租约后 cancel/超时/被顶替三种停止原因可区分
function createExecutionLease(opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000; // 默认 10 分钟自停
  const deadlineAt = Date.now() + timeoutMs;
  let current = true;
  let stopKind = null; // "cancelled" | "timeout" | "lease_lost"
  return {
    isCurrent: () => current,
    stopKind: () => stopKind,
    cancel() { if (current) { current = false; stopKind = "cancelled"; } },
    // 每步(每条重放前)调一次: 租约失效/超时都抛, 由调用方 catch 收尾
    assertActive() {
      if (!current) throw { stopKind: stopKind || "lease_lost" };
      if (Date.now() >= deadlineAt) { current = false; stopKind = "timeout"; throw { stopKind: "timeout" }; }
    },
  };
}

// 批量重放: 串行(保留链路顺序, 前置登录必须在业务之前)。
// 进度回调 onProgress(i, total, entry, r)。支持中止: 返回的 {cancel}。
// opts.lease: 执行租约(可选); 不传则内部建一个(仅含 timeout 语义)。
// opts.beforeRequest(entry, i, liveResults): 可选, 在发每条请求前改写该条(如 AI 参数注入), 返回改写后的 entry。
// opts.afterRequest(entry, i, live): 可选, 每条完成后拿到 live 响应(供提取参数链的真实值)。
// opts.assertFor(entry, i): 可选, 返回该条的业务断言数组(如 AI 生成), 有则用它判定而非文本 diff。
// opts.keepHeaders: Set(小写头名), 链显式注入的头 —— 浏览器管理头剔除时放行(录制快照里的
//   authorization 是过期凭据该剔, 链注入的 header.Authorization 是 live 活值该留; 不放行
//   则 Bearer 系统的链静默失效且回执谎报 applied)。
function runChain(entries, tabId, opts) {
  const { onProgress, beforeRequest, afterRequest, assertFor } = opts || {};
  const lease = opts.lease || createExecutionLease(opts);
  const keep = (opts && opts.keepHeaders instanceof Set) ? opts.keepHeaders : null;
  const results = [];
  const run = async () => {
    for (let i = 0; i < entries.length; i++) {
      try { lease.assertActive(); } catch { break; } // 取消/超时/租约被顶: 停在当前条, 已完成的保留
      const raw = entries[i];
      // 兜底归一化: 旧数据可能存了 CDP 的 postData 对象({text,params}), fetch 会把它
      // 序列化成 [object Object] —— normalizeEntry 由 common.js 提供(node 单测注入)。
      const norm = (typeof normalizeEntry === "function") ? normalizeEntry(raw) : raw;
      const e = (beforeRequest ? beforeRequest(norm, i, results) : norm) || norm;
      const bizHeaders = Object.fromEntries(Object.entries(e.headers || {})
        .filter(([k]) => !isSkipHeader(k) || (keep && keep.has(String(k).toLowerCase()))));
      let live;
      try {
        const res = await chrome.scripting.executeScript({
          target: { tabId },
          world: "MAIN",
          func: replayFn,
          args: [e.url, e.method, bizHeaders, e.body || null, opts.singleTimeoutMs ?? SINGLE_TIMEOUT_MS],
        });
        live = res[0]?.result;
      } catch (ex) {
        live = { status: 0, ok: false, text: String(ex) };
      }
      const asserts = assertFor ? assertFor(e, i) : null;
      const r = verdict(e, live, { asserts });
      r.entry = e;
      r.live = live;
      results.push(r);
      if (afterRequest) afterRequest(e, i, live);
      if (onProgress) onProgress(i + 1, entries.length, e, r);
    }
    return results;
  };
  return { run, cancel: () => lease.cancel(), lease };
}

// node 环境导出(供单测)
if (typeof module !== "undefined" && module.exports) {
  module.exports = { normalizeForCompare, verdict, runChain, createExecutionLease, SINGLE_TIMEOUT_MS };
}