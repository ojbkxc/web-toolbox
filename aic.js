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
          // 值锚定优先(v1.0.96, 链带录制值): 同名异值字段按名首匹配会注错位置 ——
          // 先替换录制值出现的那处(终点锚防前缀值误配), miss 再按名首匹配兜底(AI 链不带 value)
          if (c.value != null) {
            const ve = esc(c.value);
            const vb = body.replace(new RegExp(`"${le}"\\s*:\\s*("|)${ve}\\1(?=[,}\\]\\s]|$)`), () => { bodyHit = true; return `"${leaf}": "${safeVal}"`; });
            if (bodyHit) body = vb;
          }
          if (!bodyHit) {
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

// node 侧导出(浏览器同页 <script> 全局加载, 此块不执行)
if (typeof module !== "undefined" && module.exports) module.exports = { applyAiChain };
