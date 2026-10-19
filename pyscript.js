// Python 重放脚本生成器(纯规则,零幻觉):
// SKIP_HEADERS/isSkipHeader 由 common.js 提供(勿重复声明, 同页 script 共享全局作用域)
// 选中条目 -> requests 脚本。Cookie 从 state 文件读(配合 Cookie 桥导出的 .state.json),
// 业务头/参数化占位全保留 —— 生成即可运行,喂给工具链可再加工。
//
// 设计: 与 iserver IcsApi 的用法对齐:
//   - Cookie 用独立函数从 state json 加载(不再焊死在脚本里)
//   - 业务头保留 x-gr-orgcode 等(浏览器管理的 Cookie/UA/sec- 头剔除)
//   - body 原样(含 ${...} 参数化占位,导出前 correlate 已替换的话)

// node 单测直接 require 本文件时没有 common.js 前置 —— 兜底定义
if (typeof isSkipHeader === "undefined") {
  const SKIP_HEADERS = ["cookie", "referer", "origin", "host", "content-length",
    "accept-encoding", "connection", "user-agent", "sec-ch-ua", "sec-ch-ua-mobile",
    "sec-ch-ua-platform", "sec-fetch-dest", "sec-fetch-mode", "sec-fetch-site",
    "sec-fetch-user", "authorization", "accept", "accept-language"];
  function isSkipHeader(k) {
    return SKIP_HEADERS.includes(String(k).toLowerCase());
  }
}

// Python 字符串字面量安全化: 优先 repr 语义
function pyStr(s) {
  return JSON.stringify(String(s)); // JSON 字符串恰好是合法 Python 字符串(双引号)
}

// JSONPath 简易取值辅助(生成进脚本): 与扩展侧 extractFromLive 同语义 ——
// a.b.0.c 路径, 数组字段省略下标默认取首元素, 取不到返回 None。
const PY_PICK_FN = [
  `def pick(obj, path):`,
  `    """按 a.b.0.c 路径取 JSON 值; 数组缺下标时取首元素; 取不到返回 None。""";`,
  `    cur = obj`,
  `    for seg in [s for s in path.split(".") if s]:`,
  `        if cur is None:`,
  `            return None`,
  `        if isinstance(cur, list) and not seg.isdigit():`,
  `            cur = cur[0] if cur else None`,
  `            if cur is None:`,
  `                return None`,
  `        try:`,
  `            cur = cur[seg]`,
  `        except (KeyError, IndexError, TypeError):`,
  `            return None`,
  `    return cur`,
  ``,
  ``,
];

// AI 依赖链 → PY 注入行(与 applyAiChain.inject 的三种 toParam 形态对齐):
//   header.K → headers[K] = ctx[var]; url.K → query 参数/REST 路径段重写;
//   body 叶子 → payload 文本替换(JSON 值形态 / 表单 k=v 形态, 同扩展正则)。
function pyChainInjectLines(e, chains) {
  const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const lines = [];
  for (const c of chains) {
    const target = c.toParam || "";
    const varKey = pyStr(c.var);
    const vExpr = `str(ctx[${varKey}])`;
    if (/^header\./i.test(target)) {
      const k = target.slice(7);
      if (k) lines.push(`    if ctx.get(${varKey}) is not None: headers[${pyStr(k)}] = ${vExpr}`);
    } else if (/^url\./i.test(target)) {
      const k = target.slice(4);
      const qRe = new RegExp(`(^|&)${esc(k)}=`);
      if (e.query && qRe.test(e.query)) {
        // PY 侧 url 是完整串(base+path+"?"+query), 参数名前可能是 ? 或 &, 都要认
        lines.push(`    if ctx.get(${varKey}) is not None: url = re.sub(${pyStr(`(^|[?&])${k}=[^&]*`)}, lambda m: m.group(1) + ${pyStr(k + "=")} + urllib.parse.quote(${vExpr}), url)`);
      } else {
        const segRe = new RegExp(`/${esc(k)}/[^/?]+`);
        if (segRe.test(e.url || "")) {
          lines.push(`    if ctx.get(${varKey}) is not None: url = re.sub(${pyStr(`/${k}/[^/?]+`)}, ${pyStr("/" + k + "/")} + urllib.parse.quote(${vExpr}), url)`);
        }
      }
    } else {
      const leaf = target.split(".").pop().replace(/\s/g, "");
      if (leaf) {
        const le = esc(leaf);
        // 值锚定优先(v1.0.97, 与 aic.inject/applyAiChainToJmx 同款): 同名异值字段按名
        // 首匹配会注错位置 —— 先替换录制值快照出现的那处(终点锚防前缀值误配), miss 再
        // 按名/表单兜底(AI 链不带 value)。
        // repl 一律 lambda: 值含 \g/\1 时字符串 repl 会被 re.sub 当组引用解释
        // (re.error 或静默毁 payload); lambda 拼接是纯文本, 与 JS 函数式替换同语义。
        // JSON 值直接拼(str() 已是纯文本, json.dumps 会再裹一层引号成 ""v"" —— server 收到双引号)
        const jsonNameRe = `"${le}"\\s*:\\s*("[^"]*"|[0-9A-Za-z_.-]+)`;
        const formRe = `(^|&)${le}=[^&]*`;
        const jsonValRe = c.value != null ? `"${le}"\\s*:\\s*("|)${esc(c.value)}\\1(?=[,}\\]\\s]|$)` : "";
        const jsonRep = `lambda m: ${pyStr(`"${leaf}": "`)} + ${vExpr} + ${pyStr('"')}`;
        const formRep = `lambda m: m.group(1) + ${pyStr(leaf + "=")} + urllib.parse.quote(${vExpr})`;
        const fallback = `re.sub(${pyStr(jsonNameRe)}, ${jsonRep}, payload, count=1) if payload.lstrip().startswith("{") else re.sub(${pyStr(formRe)}, ${formRep}, payload, count=1)`;
        lines.push(`    if ctx.get(${varKey}) is not None:`);
        if (jsonValRe) {
          lines.push(`        _new = re.sub(${pyStr(jsonValRe)}, ${jsonRep}, payload, count=1)`);
          lines.push(`        if _new != payload:`);
          lines.push(`            payload = _new`);
          lines.push(`        else:`);
          lines.push(`            payload = ${fallback}`);
        } else {
          lines.push(`        payload = ${fallback}`);
        }
      }
    }
  }
  return lines;
}

// 单条请求 -> python 函数体
// fname: 显式函数名(由 buildPyScript 两遍法定名, 保证 def 与 main 调用一致)
// chains: 该条目作为 to 的 AI 链(注入); extracts: 作为 from 的 [var, fromJsonPath](响应提取存 ctx)
function genPyFunc(e, fname, sessionMarkers, chains = [], extracts = []) {
  const biz = Object.entries(e.headers)
    .filter(([k]) => !isSkipHeader(k));
  const headerLines = biz.map(([k, v]) => `        ${pyStr(k)}: ${pyStr(v)},`).join("\n");
  const u = new URL(e.url);
  const hasQuery = e.query && e.query.length > 0;
  // 会话失效检测子串(默认统一认证文案兜底; 调用方可传该系统的失效特征)
  const markers = (sessionMarkers && sessionMarkers.length) ? sessionMarkers : ["统一认证"];
  const markerCond = markers.map((m) => `${pyStr(m)} in r.text[:2000]`).join(" or ");
  const injectLines = chains.length ? pyChainInjectLines(e, chains) : [];

  const lines = [];
  lines.push(`def step_${fname}(sess, ctx=None, base_url="${u.origin}"):`);
  lines.push(`    """${e.method} ${e.path}""";`);
  lines.push(`    ctx = ctx if ctx is not None else {}`); // 勿用 or {}: 空 dict 是 falsy, or 会换新 dict → 提取结果外层拿不到
  lines.push(`    url = base_url + ${pyStr(e.path + (hasQuery ? "?" + e.query : ""))}`);
  lines.push(`    headers = {`);
  lines.push(headerLines || `        # (无业务头)`);
  lines.push(`    }`);
  if (e.body) {
    lines.push(`    payload = ${pyStr(e.body)}`);
    lines.push(...injectLines);
    lines.push(`    r = sess.request(${pyStr(e.method)}, url, data=payload.encode("utf-8"), headers=headers, timeout=30)`);
  } else {
    lines.push(...injectLines);
    lines.push(`    r = sess.request(${pyStr(e.method)}, url, headers=headers, timeout=30)`);
  }
  lines.push(`    if r.status_code == 200 and (${markerCond}):`);
  lines.push(`        raise RuntimeError("会话过期, 请用 Cookie 桥重新导出 state 文件")`);
  lines.push(`    try:`);
  lines.push(`        j = r.json()`);
  lines.push(`        rc = (j or {}).get("resultCode") if isinstance(j, dict) else None`);
  lines.push(`        print(f"  [{r.status_code}] ${e.method} ${e.path.split('/')[-1]} -> resultCode={rc}")`);
  lines.push(`    except ValueError:`);
  lines.push(`        j = None`);
  lines.push(`        print(f"  [{r.status_code}] ${e.method} ${e.path.split('/')[-1]} -> (non-json, {len(r.text)} bytes)")`);
  // AI 链提取: 该条是某链的 from → 响应字段存 ctx, 后续步骤注入(会话内自动关联)
  for (const [v, p] of extracts) {
    lines.push(`    if j is not None:`);
    lines.push(`        _val = pick(j, ${pyStr(p)})`);
    lines.push(`        if _val is not None:`);
    lines.push(`            ctx[${pyStr(v)}] = _val`);
    lines.push(`        else:`);
    lines.push(`            print(f"  ! 链变量 ${v} 提取失败(${p}), 下游用录制值")`);
  }
  lines.push(`    return r`);
  lines.push(``);
  return lines.join("\n");
}

// 多条 -> 完整脚本
// opts: { sessionMarkers, aiChain } aiChain: AI 参数依赖链(建链成果), from 步骤提取响应字段、
//   to 步骤注入 —— 与重放/JMX 同语义, 会话内自动关联(录制的旧单号不再 404)。
function buildPyScript(entries, stateFileName, opts = {}) {
  const sessionMarkers = Array.isArray(opts.sessionMarkers) ? opts.sessionMarkers : ["统一认证"];
  const chain = Array.isArray(opts.aiChain) ? opts.aiChain : [];
  const state = stateFileName || "cookies.state.json";
  const seen = new Set();
  const parts = [];
  parts.push(`#!/usr/bin/env python3`);
  parts.push(`# -*- coding: utf-8 -*-`);
  parts.push(`"""web-toolbox 生成的重放脚本 (${new Date().toISOString()})`);
  parts.push(`Cookie: 由 Cookie 桥导出的 state 文件提供(先在浏览器登录,再点扩展导出)。`);
  parts.push(`依赖: pip install requests`);
  if (chain.length) {
    parts.push(`参数链: ${chain.length} 条跨接口依赖已内联 —— 上游步骤响应字段自动提取, 下游步骤参数自动替换。`);
  }
  parts.push(`"""`);
  parts.push(`import glob`);
  parts.push(`import json`);
  parts.push(`import os`);
  parts.push(`import re`);
  parts.push(`import sys`);
  parts.push(`import urllib.parse`);
  parts.push(``);
  parts.push(`# Windows 控制台默认 GBK: print 里的 ⚠/✓ 等字符会 UnicodeEncodeError 直接炸掉 main ——
# 降级警告(缺 state 文件)反而比正常路径先死。强制 utf-8 输出(替代方案是要求用户设
# PYTHONIOENCODING, 那违背"下载即可运行")。errors=replace 双保险(重定向到不支持 utf-8 的管道)。`);
  parts.push(`if hasattr(sys.stdout, "reconfigure"):  # py3.7+`);
  parts.push(`    sys.stdout.reconfigure(encoding="utf-8", errors="replace")`);
  parts.push(`    sys.stderr.reconfigure(encoding="utf-8", errors="replace")`);
  parts.push(``);
  parts.push(`import requests`);
  parts.push(``);
  if (chain.length) parts.push(...PY_PICK_FN);
  // Cookie 桥导出文件名是 cookies_<主机名>.state.json; 不要求改名,
  // 找同目录下最新的 cookies*.state.json; 用户显式传名则精确匹配。
  parts.push(`def find_state_file(preferred):`);
  parts.push(`    """定位 Cookie 桥导出的 state 文件: 优先精确名, 否则取目录里最新的 cookies*.state.json。"""`);
  parts.push(`    here = os.path.dirname(os.path.abspath(__file__))`);
  parts.push(`    p = os.path.join(here, preferred)`);
  parts.push(`    if os.path.exists(p):`);
  parts.push(`        return p`);
  parts.push(`    cands = [f for f in glob.glob(os.path.join(here, "cookies*.state.json"))`);
  parts.push(`             if os.path.isfile(f)]`);
  parts.push(`    if not cands:`);
  parts.push(`        return p  # 不存在, build_session 会给提示`);
  parts.push(`    return max(cands, key=os.path.getmtime)`);
  parts.push(``);
  parts.push(``);
  parts.push(`STATE_FILE = find_state_file(${pyStr(state)})`);
  parts.push(``);
  parts.push(``);
  parts.push(`def build_session():`);
  parts.push(`    """从 Cookie 桥导出的 state 文件构建会话(缺失文件时降级为无 Cookie,只测无鉴权接口)。"""`);
  parts.push(`    sess = requests.Session()`);
  parts.push(`    if not os.path.exists(STATE_FILE):`);
  parts.push(`        print(f"⚠ 未找到 {STATE_FILE}, 先用浏览器扩展 Cookie 桥导出(或直接打开页面确保已登录)")`);
  parts.push(`        return sess`);
  parts.push(`    with open(STATE_FILE, "r", encoding="utf-8") as f:`);
  parts.push(`        data = json.load(f)`);
  parts.push(`    for c in data.get("cookies", []):`);
  parts.push(`        dom = (c.get("domain") or "").lstrip(".")`);
  parts.push(`        if dom:  # 保留全部 Cookie(勿按域过滤, 会漏 SSO token)`);
  parts.push(`            sess.cookies.set(c["name"], c["value"], domain=dom if c.get("domain","").startswith(".") else "." + dom,`);
  parts.push(`                             path=c.get("path", "/"), secure=c.get("secure", False))`);
  parts.push(`    print(f"[session] 已加载 {len(data.get('cookies', []))} 个 Cookie")`);
  parts.push(`    return sess`);
  parts.push(``);
  parts.push(``);
  // 两遍法: 先定名(重名加序号), 再生成函数 + main 调用, 保证 def 与调用一致
  const names = entries.map((e) => {
    const base = (e.path.split("/").filter(Boolean).pop() || "req")
      .replace(/[^A-Za-z0-9_]/g, "_");
    let n = 0;
    if (seen.has(base)) {
      n = 2;
      while (seen.has(base + "_" + n)) n++;
    }
    seen.add(base);
    return base + (n ? "_" + n : "");
  });
  // AI 链定位: 与 applyAiChain 同规则 —— id 优先(建链快照), 下标兜底旧数据;
  // 源不在集/倒序(fi>=ti)跳过, 生成侧就不能给假链。
  const byId = new Map(entries.map((e, i) => [e.id, i]));
  const locate = (c, which) => {
    const id = which === "from" ? c.fromId : c.toId;
    if (id != null) return byId.has(id) ? byId.get(id) : -1;
    const raw = which === "from" ? c.from : c.to;
    return (raw >= 0 && raw < entries.length) ? raw : -1;
  };
  entries.forEach((e, i) => {
    const toChains = [], extracts = [];
    for (const c of chain) {
      const ti = locate(c, "to");
      if (ti !== i) continue;
      const fi = locate(c, "from");
      if (fi < 0 || fi >= ti) continue;
      toChains.push(c);
    }
    for (const c of chain) {
      const fi = locate(c, "from");
      if (fi !== i) continue;
      const ti = locate(c, "to");
      if (ti < 0 || ti <= i) continue;
      extracts.push([c.var, c.fromJsonPath || ""]);
    }
    parts.push(genPyFunc(e, names[i], sessionMarkers, toChains, extracts));
  });
  parts.push(`def main():`);
  parts.push(`    sess = build_session()`);
  parts.push(`    ctx = {}  # AI 参数链共享变量池: 上游步骤提取的响应字段, 下游步骤注入`);
  // 环境切换(v1.0.79): 每步的 base_url 默认=录制 origin, main 统一可覆盖 —— 与 JMX 的
  // HOST_n 变量同语义(跨环境只改一处)。录制跨域时各步 origin 不同, 故传 None 走各自默认。
  parts.push(`    base_url = None  # 环境切换: 改成 "https://prod.example.com" 覆盖全部单域脚本`);
  names.forEach((n) => {
    parts.push(`    step_${n}(sess, ctx, base_url)`);
  });
  parts.push(`    return 0`);
  parts.push(``);
  parts.push(``);
  parts.push(`if __name__ == "__main__":`);
  parts.push(`    sys.exit(main())`);
  parts.push(``);
  return parts.join("\n");
}

// node 导出(单测用)
if (typeof module !== "undefined" && module.exports) {
  module.exports = { buildPyScript, pyStr };
}
