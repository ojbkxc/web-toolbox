// AI 流量报告 + AI 错误诊断: 把已录条目组织成 prompt, 调配置的 LLM。
// 数据卫生(出扩展前统一做, 不依赖 LLM 端点是否再脱敏):
//   1. Cookie/Authorization 头永不外发
//   2. 响应体截断(默认 600 字符/条)
//   3. 请求体截断(默认 1200 字符/条)
//   4. 移除明显长 token 值(>=40 连续字符)

const AI_SKIP_HEADERS = new Set(["cookie", "authorization", "set-cookie",
  "x-csrf-token", "x-xsrf-token"]);

// 脱敏截断: 单条条目 -> AI 安全摘要。
// 只消费 e.headers/e.body/e.response/e.url/e.status/e.method/e.durationMs, 缺哪个降级哪个:
// diffTriage 的 live 侧是重放快照 {status, text}(无 headers/body 字段, runChainReplay
// L1363 存储形态), 此处 Object.entries(e.headers) 直接炸会把「AI 契约判定」技能
// 变成对真实 DIFF 永远不可用(try/catch 接住后用户只看到"分析异常")。
function aiSanitizeEntry(e, opts = {}) {
  const bodyMax = opts.bodyMax ?? 1200;
  const respMax = opts.respMax ?? 600;
  const headers = Object.entries(e.headers || {})
    .filter(([k]) => !AI_SKIP_HEADERS.has(k.toLowerCase()))
    .map(([k, v]) => `${k}: ${scrubLong(v)}`)
    .join("\n");
  return {
    method: e.method,
    // url 也要打码: query 里的长 token(access_token/签名)与 body 同规则 ——
    // 诊断/冒烟/断言/diffTriage 的 user 消息直接呈现 s.url 全量, 原样送会泄漏
    url: e.url ? scrubLong(e.url) : "",
    status: e.status,
    // 耗时透传(v1.0.58): 报告 prompt 要 LLM 找"慢请求", 数据里没耗时就是无米之炊。
    // 纯增量键 —— 不呈现耗时的 prompt 不读它即无感知; 无值时 0(旧数据/开源样本兜底)。
    durationMs: e.durationMs || 0,
    headers,
    body: e.body ? scrubLong(e.body).slice(0, bodyMax) : "",
    // respMax 语义是"前段预算", 超预算时保留前段+尾段两头(中间省略号)而非只砍头 ——
    // verdict 的非 JSON diff 指纹是"前 200 + 后 200"(replay.js normalizeForCompare),
    // 大响应差异在尾部时 verdict 判 DIFF 但只砍头的 prompt 里没有差异段, LLM 无从
    // 判定(diffTriage 的判定材料 = 录制 response vs live text, 判定面与呈现面口径须对齐)。
    response: e.response
      ? (String(e.response).length > respMax
        ? scrubLong(String(e.response).slice(0, Math.max(0, respMax - 200))) + "\n…(中间省略约 " + (String(e.response).length - respMax) + " 字符)…\n" + scrubLong(String(e.response).slice(-200))
        : scrubLong(e.response))
      : "",
  };
}

// 长随机串打码: 40+ 连续的 [A-Za-z0-9_=.+-] 视为 token/密钥段, 保留前 8 位 + ***。
// 不用 \S{40,}: url/长 query 里整段非空白会把前缀(如 token=)一起吞掉,
// 且两个长值相邻时中间的短连接符(如 : 或 ,)会逃脱打码。
function scrubLong(s) {
  return String(s).replace(/[A-Za-z0-9_=.+-]{40,}/g, (m) => m.slice(0, 8) + "***MASKED***");
}

// prompt 条目行的路径呈现: pathname + query(截断到 300 字符防长 query 挤爆条目行)。
// query 过 scrubLong —— 40+ 长参数(access_token/签名)与 body 同规则打码;
// aiSanitizeEntry 已在源头打码 url, 这里再码一次是幂等的(scrubLong 对已码串不再命中),
// 保留双重 scrub 是 pathLine 作为独立 helper 的边界防御(不依赖调用方先 sanitize)。
// 短参数(cursor/分页/排序)不受影响, LLM 能识别"这里有个 query 参数"以建 url. 链。
function pathLine(url) {
  const u = new URL(url);
  const q = u.search ? scrubLong(u.search.slice(1, 301)) : "";
  return `${u.pathname}${q ? "?" + q : ""}`;
}

// ---------- AI 流量报告 ----------
// 目标: 把一堆裸请求变成"业务流程视角"的报告(人话), 辅助交接/写文档/找接口。
function buildReportPrompt(entries, opts = {}) {
  const maxEntries = opts.maxEntries ?? 60;
  const list = entries.slice(0, maxEntries).map((e, i) => {
    const s = aiSanitizeEntry(e, opts);
    return [
      `### [${i + 1}] ${s.method} ${pathLine(s.url)}`,
      `状态: ${s.status}` + (s.durationMs ? ` · 耗时 ${s.durationMs}ms` : ""),
      s.headers ? `业务头:\n${s.headers}` : "",
      s.body ? `请求体(截断):\n${s.body}` : "",
      s.response ? `响应(截断):\n${s.response}` : "",
    ].filter(Boolean).join("\n");
  }).join("\n\n");

  return [
    { role: "system", content:
      `你是资深测试/接口分析专家。用户给你一段网页系统的真实操作流量(录制自浏览器)。` +
      `请输出中文报告, Markdown 格式, 结构如下:` +
      `\n1. **会话概览**: 用户这次操作大概率在做什么业务(1-2 句)` +
      `\n2. **业务流程**: 按时间顺序拆成几个业务步骤(如 登录→查询→提交), 每步列出涉及的接口(path+方法+一句话作用)` +
      `\n3. **关键接口**: 哪些是"写操作"(POST/PUT 且改数据), 哪些是读操作; 写操作标注⚠` +
      `\n4. **参数依赖**: 前一个接口的响应值被后一个接口引用的地方(如 orderId)` +
      `\n5. **异常与风险**: 非 2xx 请求、慢请求(条目带耗时 ms 时以此为据)、可疑字段` +
      `\n只依据给定流量, 不要猜测流量之外的信息。接口名可以按路径语义命名。` },
    { role: "user", content:
      `以下是 ${entries.length} 条按时间顺序录制的请求${entries.length > maxEntries ? `(只取前 ${maxEntries} 条)` : ""}:\n\n${list}` },
  ];
}

// ---------- AI 错误诊断 ----------
// 目标: 选中一条失败请求, 结合前后上下文, 让 LLM 给出可能原因。
function buildDiagnosePrompt(failed, context, opts = {}) {
  const f = aiSanitizeEntry(failed, { bodyMax: 2000, respMax: 1500 });
  const ctx = context.map((e, i) => {
    const s = aiSanitizeEntry(e, { bodyMax: 300, respMax: 200 });
    return `[${i + 1}] ${s.method} ${pathLine(s.url)} (${s.status}${s.durationMs ? ` · ${s.durationMs}ms` : ""})`;
  }).join("\n");

  return [
    { role: "system", content:
      `你是接口调试专家。用户在浏览器里操作一个网页系统时,某条请求失败了。` +
      `给你:失败请求的完整信息 + 它前后的请求时间线(提供因果上下文; 时间线带耗时 ms 时, 慢请求/超时是常见根因之一)。` +
      `请输出中文分析,结构:` +
      `\n1. **失败原因(最可能)**: 直接给结论, 1-3 句` +
      `\n2. **依据**: 从请求/响应/上下文里指认具体证据(引用字段值)` +
      `\n3. **下一步**: 按"先试什么再试什么"给 2-4 条可执行动作` +
      `\n不要客套,直接干货。如果信息不足,明说缺什么信息。` },
    { role: "user", content:
      `## 失败请求\n方法: ${f.method}\nURL: ${f.url}\n状态: ${f.status}${f.durationMs ? ` · 耗时 ${f.durationMs}ms` : ""}\n` +
      `业务头:\n${f.headers}\n\n请求体:\n${f.body || "(无)"}\n\n响应:\n${f.response || "(空)"}\n\n` +
      `## 前后时间线(供参考)\n${ctx || "(无上下文)"}` },
  ];
}

// ---------- AI 参数依赖建链(自动联调核心) ----------
// 目标: AI 读全量流量, 找出"前一个接口的响应字段 → 后一个接口的请求参数"的参数传递链,
// 输出结构化 JSON: [{from: 接口序号, fromJsonPath, to: 接口序号, toParam, var}]。
// 拿到后可以: 1) 重放前自动把录制值替换为链上真实值; 2) 导出 JMX 时挂 JSON 提取器。
// 输出用 JSON 约束, 后端直接 JSON.parse —— 不依赖 LLM 自由文本。
function buildChainPrompt(entries, opts = {}) {
  const maxEntries = opts.maxEntries ?? 40;
  const list = entries.slice(0, maxEntries).map((e, i) => {
    const s = aiSanitizeEntry(e, { bodyMax: 1200, respMax: 1200 });
    return [
      `### [${i + 1}] ${s.method} ${pathLine(s.url)}`,
      `状态: ${s.status}`,
      s.headers ? `业务头:\n${s.headers}` : "",
      s.body ? `请求体:\n${s.body}` : "",
      s.response ? `响应(截断):\n${s.response}` : "",
    ].filter(Boolean).join("\n");
  }).join("\n\n");

  return [
    { role: "system", content:
      `你是接口参数依赖分析专家。用户给出一段网页系统的真实流量(按时间顺序, 每条含请求与响应)。` +
      `你的任务: 找出【参数传递链】——前一个接口的响应字段, 被后一个接口的请求体/请求头/URL参数引用。` +
      `典型例子: 登录响应里的 token → 后续请求头的 Authorization; 查询响应的 orderId → 详情请求的 URL/body。` +
      `只输出一个 JSON 数组(不要任何解释文字), 每项:\n` +
      `{"from":<前一个接口的序号数字>,"fromJsonPath":"响应里的JSON路径如 data.orderId(无则填响应字段名)","to":<后一个接口的序号数字>,"toParam":"后一个请求里的参数名(如 body.orderNo / header.X-Token / url.id)","var":"自定义变量名如 token1/orderId2","value":"录制时的示例值"}\n` +
      `toParam 三种形态都会被自动注入: body.字段名(JSON 体和 k=v&k=v 表单体都支持) / header.头名 / url.参数名(query 参数如 url.id=1, 或 REST 路径段如 /order/id/123 也用 url.id)。\n` +
      `fromJsonPath 支持数字下标(如 data.list.0.id); 数组字段省略下标时默认取首元素。\n` +
      `规则: 只依赖给出的流量; 没有跨接口传递就不要编; 序号用 [n] 里的数字(从 1 开始)。` +
      `方向是硬约束: 流量按时间顺序排列, 值只能从【时间在前】的接口响应流向【时间在后】的接口请求 —— ` +
      `from 必须是【产出值】的接口(时间在前, 值在它的响应里), to 必须是【消费值】的接口(时间在后, 值在它的请求里); ` +
      `把下游(消费方, 如详情页)当 from、把上游(产出方, 如查询/登录)当 to 是方向搞反, 直接禁止。` },
    { role: "user", content:
      `以下是 ${entries.length} 条按时间顺序录制的请求${entries.length > maxEntries ? `(只取前 ${maxEntries} 条)` : ""}:\n\n${list}` },
  ];
}

// 从 LLM 返回文本里提取 JSON 数组(容错: 可能包在 ```json ``` 里, 或前后有废话)。
// 逐起点尝试: 原版 indexOf('[')+lastIndexOf(']') 一次切片, 两种真实 LLM 输出会静默丢链 ——
//   "见[1]说明: [{...}]" 起点落在引用标号上; "[{...}] 详见附注[2]" 终点被尾巴拖走。
// 改为: 每个 '[' 起点 × 从最远 ']' 收敛的终点, 逐个试 parse。
// 还须排除"元素全非对象"的数组: 引用标号 "[1]" 本身是合法 JSON 数字数组,
// 起点序优先会被它截胡 —— 而链/断言的目标形态都是 object 数组, 非对象数组跳过继续找。
function extractChainJson(text) {
  let t = String(text || "");
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1];
  for (let start = t.indexOf("["); start !== -1; start = t.indexOf("[", start + 1)) {
    for (let end = t.lastIndexOf("]"); end > start; end = t.lastIndexOf("]", end - 1)) {
      try {
        const parsed = JSON.parse(t.slice(start, end + 1));
        if (Array.isArray(parsed) && parsed.every((x) => x == null || typeof x === "object")) return parsed;
      } catch { /* 换更近的终点, 再换下一个起点 */ }
    }
  }
  return [];
}

// 校验/过滤 AI 返回的依赖链(只保留结构合理的项)。
// 序号换算: prompt 里条目标 [1]..[n](1-based), AI 按它返回; 应用层
// (applyAiChain) 用 0-based 下标 —— 这里统一减 1, 两边各认各的语义。
// from >= to 的链直接丢弃: 值是上游产出, 顺序反了注入时必无值,
// 是 AI 幻觉或序号看错 —— 保留只会污染链表与 JMX。
function validateChain(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.filter((c) =>
    c && typeof c === "object" &&
    Number.isInteger(c.from) && Number.isInteger(c.to) &&
    c.from >= 1 && c.to >= 1 && c.from < c.to &&
    typeof c.var === "string" && c.var
  ).map((c) => ({
    from: Number(c.from) - 1, fromJsonPath: String(c.fromJsonPath || ""),
    to: Number(c.to) - 1, toParam: String(c.toParam || ""),
    var: c.var, value: String(c.value ?? ""),
  }));
}

// ---------- AI 接口文档(OpenAPI 风格) ----------
function buildDocPrompt(entries, opts = {}) {
  const maxEntries = opts.maxEntries ?? 40;
  const list = entries.slice(0, maxEntries).map((e, i) => {
    const s = aiSanitizeEntry(e, { bodyMax: 1200, respMax: 1000 });
    return [
      `### [${i + 1}] ${s.method} ${pathLine(s.url)}`,
      `状态: ${s.status}`,
      s.headers ? `业务头:\n${s.headers}` : "",
      s.body ? `请求体:\n${s.body}` : "",
      s.response ? `响应:\n${s.response}` : "",
    ].filter(Boolean).join("\n");
  }).join("\n\n");

  return [
    { role: "system", content:
      `你是接口文档工程师。用户给出一段网页系统的真实流量(浏览器录制, 含请求/响应样例)。` +
      `请为每个接口生成 OpenAPI 风格的接口文档条目, Markdown 格式:\n` +
      `## 接口N: 方法 path\n` +
      `- **用途**: 一句话\n` +
      `- **请求参数**: 表格(参数名 | 位置 body/query/header | 类型 | 是否必填 | 说明), 按录制样例推断, 没有的标"示例值"来源` +
      `\n- **请求示例**: 原样 JSON/文本\n` +
      `- **响应示例**: 录制响应(截断到关键字段)\n` +
      `- **依赖前置**: 引用哪个前序接口的哪个响应字段(如: 依赖[3]的 data.orderId)\n` +
      `只依据给定流量; 每个接口都覆盖; 中文输出。` },
    { role: "user", content:
      `以下是 ${entries.length} 条按时间顺序录制的请求${entries.length > maxEntries ? `(只取前 ${maxEntries} 条)` : ""}:\n\n${list}` },
  ];
}

// ---------- AI 断言生成 ----------
function buildAssertPrompt(entry, opts = {}) {
  const s = aiSanitizeEntry(entry, { bodyMax: 1200, respMax: 2000 });
  return [
    { role: "system", content:
      `你是接口测试专家。给出一条请求的录制(请求+响应), 请生成"该接口成功/失败判定"的一组断言规则。` +
      `输出 JSON 数组(不要解释), 每项:\n{"type":"status|contains|not_contains|json_eq|json_regex","target":"响应状态码 或 响应体子串 或 JSON路径","expect":"期望值(正则支持)"}\n` +
      `要求: 1) 覆盖成功判定(该响应正常时一定有); 2) 覆盖业务失败判定(如错误码/错误消息字段); 3) 3~6 条, 具体可执行。` },
    { role: "user", content:
      `方法: ${s.method}\nURL: ${s.url}\n状态: ${s.status}\n业务头:\n${s.headers}\n请求体:\n${s.body}\n响应:\n${s.response}` },
  ];
}

// ---------- AI 冒烟解读 ----------
// 输入: 就地冒烟的统计 + 目标请求; 输出: 瓶颈判断 + 调优建议。
// 注意向模型声明数据性质: 浏览器页面上下文的冒烟数字偏保守(同域连接池排队),
// 模型不应把它当严肃压测基准下结论。
function buildPerfPrompt(entry, stats, opts = {}) {
  const s = aiSanitizeEntry(entry, { bodyMax: 1200, respMax: 600 });
  return [
    { role: "system", content:
      `你是性能测试分析师。用户对单个接口做了一次快速冒烟(浏览器页面上下文并发重放, 会话真实)——数字偏保守(浏览器同域连接池有限), 适合定性判断, 不是严肃压测基准。给你统计数字和目标请求。` +
      `请输出中文分析, Markdown:` +
      `\n1. **结论**: 接口健康度(好/一般/差) + 一句话判断(是否达到可接受水平, 依据是什么)` +
      `\n2. **瓶颈分析**: 吞吐/延迟分位数/错误率里最可疑的指标; 判断更可能是 服务端慢 / 网络 / 脚本并发设置 的问题` +
      `\n3. **调优建议**: 按"先做什么再做什么"给 2-4 条可执行动作(如 降并发、看慢请求、检查是否单点、考虑缓存)` +
      `\n只依据给定数据, 不编造基准。` },
    { role: "user", content:
      `## 冒烟统计\n` +
      `并发: ${stats.concurrency}\n总次数: ${stats.total}\n完成: ${stats.completed}\n` +
      `总耗时: ${stats.wallMs}ms\n吞吐: ${stats.rps} req/s\n` +
      `成功: ${stats.success}  失败: ${stats.failed} (${stats.failRate}%)\n` +
      `P50: ${stats.p50}ms   P90: ${stats.p90}ms   P95: ${stats.p95}ms   P99: ${stats.p99}ms   MAX: ${stats.maxMs}ms\n` +
      (stats.errors && stats.errors.length ? `错误样本: ${stats.errors.join(" / ")}` : "") +
      `\n\n## 目标请求\n方法: ${s.method}\nURL: ${s.url}\n状态: ${s.status}\n` +
      `请求体:\n${s.body || "(无)"}\n响应(截断):\n${s.response || "(空)"}` },
  ];
}

// ---------- AI 契约破坏判定 ----------
// 输入: 链路重放里一条 DIFF 条目(录制 vs live); 输出: "仅噪音" vs "真破坏+改了什么"。
function buildDiffTriagePrompt(recorded, live, opts = {}) {
  const r = aiSanitizeEntry(recorded, { bodyMax: 1200, respMax: 1500 });
  // live 侧是重放快照 {status, text}: 没有 method/url/body 字段, 把快照字段映射成
  // aiSanitizeEntry 的消费名(方法/URL 由 recorded 侧承载 —— 同一条接口, 两侧本来就相同;
  // response ← text, body 留空)。直喂快照会三行呈现 undefined, LLM 拿到的"重放结果"没有响应体。
  const l = aiSanitizeEntry(
    { method: recorded.method, url: recorded.url, headers: {}, body: "", ...live, response: live.text ?? live.response ?? "" },
    { bodyMax: 1200, respMax: 1500 });
  return [
    { role: "system", content:
      `你是接口回归分析专家。一条接口在"录制时"和"重放时"响应体有差异(状态码一致),给你两边内容判断差异性质。` +
      `请输出中文判断:\n` +
      `1. **判定**: "噪音"(仅时间戳/随机串/顺序变化等易变值) 还是 "真破坏"(字段结构/业务语义变了)` +
      `\n2. **改动清单**: 列出具体变化字段(旧值 → 新值), 最多 8 条; 噪音类写明是哪些易变值` +
      `\n3. **影响**: 对下游(依赖此接口的请求/压测) 有无实际影响, 一句话` +
      `\n直接给结论, 不要客套。` },
    { role: "user", content:
      `## 录制快照\n方法: ${r.method}\nURL: ${r.url}\n状态: ${r.status}\n请求体:\n${r.body || "(无)"}\n响应:\n${r.response || "(空)"}\n\n` +
      `## 重放结果\n方法: ${l.method}\nURL: ${l.url}\n状态: ${l.status}\n请求体:\n${l.body || "(无)"}\n响应:\n${l.response || "(空)"}` },
  ];
}

// ---------- AI 接口清单(机器可读表格) ----------
// 输入: 录制集; 输出: 结构化表格, 适合交接给 Python 工具链 / 贴 wiki。
function buildInventoryPrompt(entries, opts = {}) {
  const maxEntries = opts.maxEntries ?? 60;
  const list = entries.slice(0, maxEntries).map((e, i) => {
    const s = aiSanitizeEntry(e, { bodyMax: 800, respMax: 400 });
    return `[${i + 1}] ${s.method} ${pathLine(s.url)} 状态${s.status} 请求体:${s.body ? s.body.slice(0, 200) : "-"} 响应:${s.response ? s.response.slice(0, 200) : "-"}`;
  }).join("\n");

  return [
    { role: "system", content:
      `你是接口清单整理专家。用户给出一段网页系统录制的真实流量。请输出 Markdown 表格, 每行一个接口:\n` +
      `| # | 方法 | 路径 | 写/读 | 主要入参 | 主要出参 | 备注 |\n` +
      `规则: 写操作(POST/PUT/DELETE 且改数据)标"写", 其余"读"; 入参/出参从请求/响应样例推断(最多各 3 个, 无则"-"); ` +
      `备注写该接口一句话作用或依赖的前序接口。按时间顺序, 所有接口都要覆盖, 中文输出。` },
    { role: "user", content:
      `以下是 ${entries.length} 条按时间顺序录制的请求${entries.length > maxEntries ? `(只取前 ${maxEntries} 条)` : ""}:\n\n${list}` },
  ];
}

// ---------- AI 敏感字段扫描 ----------
// 输入: 录制集; 输出: 命中 token/password/身份证/手机号/密钥 的字段与位置, 供导出前自查。
function buildSensitiveScanPrompt(entries, opts = {}) {
  const maxEntries = opts.maxEntries ?? 60;
  const list = entries.slice(0, maxEntries).map((e, i) => {
    const s = aiSanitizeEntry(e, { bodyMax: 2000, respMax: 2000 });
    return [
      `### [${i + 1}] ${s.method} ${pathLine(s.url)}`,
      s.headers ? `业务头:\n${s.headers}` : "",
      s.body ? `请求体:\n${s.body}` : "",
      s.response ? `响应(截断):\n${s.response}` : "",
    ].filter(Boolean).join("\n");
  }).join("\n\n");

  return [
    { role: "system", content:
      `你是数据安全审查员。给出一段真实录制流量(已由工具做了初步脱敏: Cookie/Authorization 头已剥, 40+ 长 token 已打码)。` +
      `你的任务: 找出仍然暴露的敏感信息。输出 Markdown 表格(不要解释), 列: 序号 | 位置(headers/body/response/url) | 字段/路径 | 类型(password/token/身份证/手机号/邮箱/密钥/其他) | 风险说明。\n` +
      `表格后补一段「处理建议」: 每类暴露给一个可执行动作(如: 录制列表勾选该条目避免导出 / 用 ✂ 清洗 / 删除该条目)。\n` +
      `规则: 只依据给出流量; 不误报普通业务字段(如订单号/用户ID不算敏感除非是身份证); 没有就只输出一行「未发现暴露的敏感字段」。` },
    { role: "user", content:
      `以下是 ${entries.length} 条按时间顺序录制的请求${entries.length > maxEntries ? `(只取前 ${maxEntries} 条)` : ""}:\n\n${list}` },
  ];
}

// ---------- AI 会话特征回填 ----------
// 输入: 录制集 + auth.js 当前命中情况; 输出: 新发现的登录页/会话失效特征文本(反哺登录前置识别规则)。
function buildSessionFeaturePrompt(entries, opts = {}) {
  const hits = (opts.hits || []).map((h, i) => `[${i + 1}] ${h.method} ${h.path} (命中原规则: ${h.rule || "?"})`).join("\n");
  const misses = (opts.misses || []).slice(0, 10).map((e, i) => {
    const s = aiSanitizeEntry(e, { bodyMax: 600, respMax: 1200 });
    return `[${i + 1}] ${s.method} ${pathLine(s.url)} (${s.status})\n响应: ${s.response || "(空)"}`;
  }).join("\n\n");

  return [
    { role: "system", content:
      `你是认证流程分析专家。用户给出一段网页系统的录制流量, 其中一部分已被识别为登录前置(命中规则), 其余是普通业务请求。` +
      `你的任务: 找出新的"认证特征文本", 反哺登录识别规则库。` +
      `请输出中文分析:\n` +
      `1. **登录前置特征**: 在业务请求/响应里, 哪些文本特征标志"这里是登录/换票/刷新 token"动作(如 URL 关键字、响应里的"登录/认证/会话失效"文案、参数名)\n` +
      `\n2. **会话失效特征**: 当会话过期时, 系统返回什么特征(如跳转到统一认证页、特定状态码、响应里的"请重新登录"), 逐个列出来\n` +
      `\n3. **建议**: 每条给一个可直接用作正则/包含匹配的特征字符串\n` +
      `\n4. **如何应用**: 分析结果不会自动写回规则库——对当前流量, 在录制列表把对应条目勾选 🔐(立即生效并持久化); 特征字符串可作为建议反馈给扩展维护者加进内置规则\n` +
      `只依据给定流量。` },
    { role: "user", content:
      `## 已识别为登录前置的请求\n${hits || "(无)"}\n\n## 普通业务请求(含响应, 找失效/登录特征)\n${misses || "(无)"}` },
  ];
}

// node 导出(供单测; 浏览器 script 标签加载时此分支不执行)
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    aiSanitizeEntry, scrubLong, pathLine, buildReportPrompt, buildDiagnosePrompt,
    buildChainPrompt, extractChainJson, validateChain,
    buildDocPrompt, buildAssertPrompt,
    buildPerfPrompt, buildDiffTriagePrompt, buildInventoryPrompt,
    buildSensitiveScanPrompt, buildSessionFeaturePrompt,
  };
}
