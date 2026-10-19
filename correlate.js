// 自动关联(参数化): BlazeMeter correlation 的本地化简化版。
//
// 原理: 同一接口录了多次(用户操作走了 2+ 遍 / 两个会话各录一遍), 对多条录制的
// body 做逐位置 diff —— 值完全相同=静态, 值不同=动态值(时间戳/单号/token/UUID)。
// 动态值自动:
//   1. 识别语义(时间戳→JMeter 函数, 单号/UUID→提示需要上游提取)
//   2. 替换成 ${var} 并在采样器上挂 JSON 提取器(响应里能找到的话)
//
// 不需要联网/不需要 AI —— 纯 diff + 规则。这是 BlazeMeter 收费云功能的离线版。

// ---------------- diff 引擎 ----------------

// body 是不是 x-www-form-urlencoded 表单体(k=v&k2=v2 形态)
// 识别条件: 不含 JSON 的 {} 特征 —— k6 html_form_post / blazedemo 表单流同款。
// 故意宽松: 纯文本/XML 恰好无 {} 时也会 true, 但损害面为零(已验证)——
//   非表单串走 URLSearchParams 解析要么整体当一个无值 key(vals 全空 → 静态),
//   要么不同串=不同 key(无同 key 可 diff → 无动态), 不会产生假动态字段;
//   applyDynamics 分支同理(组隔离保证只拿到自己组的 dyn, split/join 无命中即原样返回)。
// 过度收紧(如要求含 =)反而会拒掉合法的空值表单 'a=&b='。
function isFormBody(b) {
  if (!b || /[{}]/.test(b)) return false;
  const sp = new URLSearchParams(b);
  return [...sp.entries()].length >= 1 && [...sp.keys()].every((k) => k !== "");
}

// 表单体 → 键值平坦化(与 JSON diff 的 path 形态对齐: 单段键名即叶子路径)
// 同名键多值(checkbox 形态 a=1&a=2)取首个 —— 表单语义里重名字段极少且 diff 无从对位。
function parseFormBody(b) {
  const out = [];
  for (const [k, v] of new URLSearchParams(b)) out.push([k, v]);
  return out;
}

// JSON 深比较两条 body, 找出"同一路径、不同值"的动态点
// 返回 [{path, values: [v1, v2, ...]}]
// 表单体(x-www-form-urlencoded)与 JSON 走同一管线: path=键名, 值 diff 语义一致 ——
// 之前表单体 JSON.parse 失败被静默跳过(v1.0.18 INDEX「已知形态边界」如实记录的缺口,
// k6 html_form_post / csv-login / blazedemo purchase.php 全部不在 diff 管线内)。
function diffJsonBodies(bodies) {
  // 表单分支: 全部 body 都是表单形态才走表单 diff(JSON/表单混录的组 diff 无从对位, 跳过)
  if (bodies.length >= 2 && bodies.every(isFormBody)) {
    const keys = new Set();
    const parsed = bodies.map(parseFormBody);
    parsed.forEach((kv) => kv.forEach(([k]) => keys.add(k)));
    const out = [];
    for (const k of keys) {
      const vals = parsed.map((kv) => {
        const hit = kv.find(([kk]) => kk === k);
        return hit ? hit[1] : null;
      });
      const uniq = [...new Set(vals.filter((v) => v !== null))];
      if (uniq.length > 1) out.push({ path: k, values: uniq });
    }
    return out;
  }

  const parsed = bodies.map((b) => {
    try { return JSON.parse(b); } catch { return null; }
  });
  if (parsed.filter((p) => p !== null).length < 2) return []; // 不是 JSON 或只有一条

  const paths = [];
  const walk = (objs, path) => {
    // objs: 该路径上的各实例值(可能 null = 缺失)
    const first = objs.find((o) => o !== null && o !== undefined);
    if (first === undefined) return;
    if (Array.isArray(first)) {
      const maxLen = Math.max(...objs.map((o) => (Array.isArray(o) ? o.length : 0)));
      for (let i = 0; i < maxLen; i++) walk(objs.map((o) => (Array.isArray(o) ? o[i] : null)), path + `.${i}`);
      return;
    }
    if (typeof first === "object" && first !== null) {
      const keys = new Set();
      objs.forEach((o) => { if (o && typeof o === "object") Object.keys(o).forEach((k) => keys.add(k)); });
      for (const k of keys) walk(objs.map((o) => (o && typeof o === "object") ? o[k] : null), path + "." + k);
      return;
    }
    // 叶子: 值不同 → 动态
    const vals = objs.map((o) => (o === null || o === undefined) ? null : String(o));
    const uniq = [...new Set(vals)];
    if (uniq.length > 1) {
      paths.push({ path: path.replace(/^\./, ""), values: vals.filter((v) => v !== null) });
    }
  };
  walk(parsed, "");
  return paths;
}

// ---------------- 动态值语义识别 ----------------

// 给动态点分类, 决定参数化策略
// kind: timestamp(每次运行时生成) | seq(上游响应提取) | fixed(录制值即可, 提示人工确认)
function classifyDynamic(path, values) {
  const p = path.toLowerCase();
  const v = values[0] || "";

  // 业务单号(如 iserver 65 开头 13 位)优先于时间戳判断 —— 否则会被误判为毫秒时间戳
  if (/^65\d{11}$/.test(v)) return { kind: "seq", note: "单号/流水号: 应从上游响应 JSON 提取, 或改由前置接口生成" };

  // 时间戳类: 13 位毫秒 / 10 位秒 / YYYY-MM-DD HH:mm:ss
  if (/^\d{13}$/.test(v) || /^\d{10}$/.test(v)) {
    return { kind: "timestamp", fn: /^\d{13}$/.test(v) ? "${__time()}" : "${__time(/1000)}" };
  }
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?/.test(v)) {
    return { kind: "timestamp", fn: v.includes("T") ? "${__time(yyyy-MM-dd'T'HH:mm:ss)}" : "${__time(yyyy-MM-dd HH:mm:ss)}" };
  }

  // 上游提取类: 单号/ID/UUID/流水号
  if (/^\d{12,}$/.test(v)) return { kind: "seq", note: "单号/流水号: 应从上游响应 JSON 提取, 或改由前置接口生成" };
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) return { kind: "seq", note: "UUID: 每次应由前端生成或上游返回" };
  if (/(orderno|orderid|prnumber|pono|token|sessionid|serialno|random|uid|guid|sign|signature|nonce)/.test(p)) {
    return { kind: "seq", note: "命名疑似动态标识, 建议上游提取" };
  }

  return { kind: "fixed", note: "值不同但无法归类, 默认取第一个录制值(可手动改为 ${var})" };
}

// ---------------- 变量名生成 ----------------

function pathToVar(path) {
  // saleOrderDetails.0.orderNo -> var_saleOrderDetails_0_orderNo
  return "V_" + path.replace(/[^A-Za-z0-9]/g, "_");
}

// ---------------- 主流程 ----------------

// 分析一组录制条目:
//   按 method+path 分组, 组内 >= 2 条的做 body diff。
// 返回:
//   { groups: [{method, path, count, dynamics: [{path, values, classify, var, replace}]}],
//     summary }
function analyzeCorrelation(entries) {
  const groups = new Map();
  for (const e of entries) {
    const key = e.method + " " + e.path;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }

  const out = [];
  for (const [key, list] of groups) {
    const bodies = list.map((e) => e.body).filter((b) => b && b.trim());
    let dynamics = [];
    if (bodies.length >= 2) {
      dynamics = diffJsonBodies(bodies).map((d) => {
        const cls = classifyDynamic(d.path, d.values);
        return {
          ...d,
          classify: cls,
          var: pathToVar(d.path),
          // timestamp -> JMeter 函数直接替换; seq/fixed -> 录制值 + 标注
          replace: cls.kind === "timestamp" ? cls.fn : null,
        };
      });
    }
    // query 参数 diff: query 与表单同为 k=v 形态, 复用表单 diff ——
    // OAuth2 authorize 的 code、?ts=123 之类动态此前不进 diff(INDEX 边界节记录的最后一块)。
    // path 加 Q_ 前缀与 body 路径区分(替换端 applyDynamicsToQuery 按 leaf 取, 前缀不影响)。
    // 溯源端 linkSeqDynamics 用 jsonPathGet(body) 取值 —— Q_ 前缀在这里挡住: query 参数的
    // 动态值不在 body 里, 取不到即不挂链(宁可不链, 与 sign/nonce 同保守)。
    const queries = list.map((e) => e.query).filter((q) => q && q.trim());
    if (queries.length >= 2) {
      for (const d of diffJsonBodies(queries)) {
        const cls = classifyDynamic(d.path, d.values);
        dynamics.push({
          ...d,
          path: "Q_" + d.path,
          classify: cls,
          var: pathToVar(d.path),
          replace: cls.kind === "timestamp" ? cls.fn : null,
        });
      }
    }
    if (dynamics.length) {
      out.push({
        method: list[0].method,
        path: list[0].path,
        count: list.length,
        dynamics,
      });
    }
  }
  return {
    groups: out,
    summary: out.reduce((n, g) => n + g.dynamics.length, 0),
  };
}

// 把动态替换应用到 body(生成参数化后的 body 文本)
function applyDynamics(bodyText, dynamics) {
  // JSON 路径定位 -> 直接在文本上按 "key": <值> 精确替换(值级, 不重排序键)。
  // 值可能是字符串(带引号)或数字/布尔(裸值), 两种都要匹配。
  // CDP 对象 body({text}/{params})兜底: 与 normalizeEntry 同款归一化 ——
  // 条目读取层已统一归一化, 这里是纵深防御(applyCorr 是导出函数, 直调喂
  // 旧数据时 `e.body || ""` 挡不住 truthy 对象, 别让 TypeError 炸穿调用方)。
  let text = bodyText;
  if (text && typeof text === "object") {
    text = typeof text.text === "string" ? text.text
      : Array.isArray(text.params) ? text.params.map((p) => `${p.name}=${p.value ?? ""}`).join("&")
      : "";
  }
  const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const d of dynamics) {
    if (!d.replace) continue;
    // Q_ 前缀 = query 参数动态 —— body 替换端只处理 body 动态(query 走 applyDynamicsToQuery),
    // 即便 body 恰好有同名字段也不该被 query 动态替换(query 与 body 是两个参数域)
    if (/^Q_/.test(d.path)) continue;
    const leaf = d.path.split(".").pop();
    // 表单体分支: k=v 精确替换(与 JSON 分支互斥 —— 表单 diff 出的 path 必是单段键名)
    if (isFormBody(text)) {
      for (const v of d.values) {
        // 空串值跳过: 空字段发空是对的, 替换成 ${__time()} 反而错。
        if (v === "") continue;
        // 参数边界锚定替换(v1.0.96): split/join 形态会误伤前缀撞名参数(id= 命中 uid=
        // 的子串)与前缀值(ts=5 命中 ts=55 的前半); (^|&) 与 (?=&|$) 把替换限定在完整参数
        text = text.replace(new RegExp(`(^|&)${esc(leaf)}=${esc(v)}(?=&|$)`), (_m, p1) => `${p1}${leaf}=${d.replace}`);
      }
      continue;
    }
    for (const v of d.values) {
      // 空串值跳过: 空串让正则退化成 0 宽匹配, 对 `"ts": ` 后任意位置叠加替换(JSON 直接损坏)。
      if (v === "") continue;
      const raw = JSON.stringify(v);          // "带引号" 形式
      // 字符串值: 匹配 "leaf": "v" 或数字值: 匹配 "leaf": 123
      const variants = typeof v === "string" || /[^\d]/.test(v)
        ? [raw.slice(1, -1) /* 引号里的内容 */]
        : [String(v)];
      for (const inner of variants) {
        // 值终点锚(v1.0.96): 动态值互为前缀时(values 含 123 与 123456)无锚正则匹配
        // 123456 的前半, 产物 "${__time()}456" 直接损坏 JSON; 锚到值界(, } ] 空白/尾)才替换
        const pat = `"${esc(leaf)}"\\s*:\\s*("|)${esc(inner)}\\1(?=[,}\\]\\s]|$)`;
        const re = new RegExp(pat, "g");
        text = text.replace(re, `"${leaf}": ${JSON.stringify(d.replace)}`);
      }
    }
  }
  return text;
}

// 对 URL query 里的动态值做同样处理(常见: ?ts=123&page=1)
function applyDynamicsToQuery(query, dynamics) {
  let q = query;
  const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const d of dynamics) {
    if (!d.replace) continue;
    // Q_ 前缀 = query 参数动态(analyzeCorrelation 的 query diff 命名空间), 实际替换键是剥前缀后的键名
    const leaf = d.path.split(".").pop().replace(/^Q_/, "");
    for (const v of d.values) {
      // 空串值跳过: 空值 query 参数本该保持空。
      if (v === "") continue;
      // 参数边界锚定(v1.0.96): split/join 会误伤前缀撞名参数(id= 命中 uid= 的子串)与
      // 前缀值(id=100 命中 uid=1001 内部); (^|[?&]) 兼容带 ? 前缀的 query 串, (?=&|$) 锚到参数尾
      q = q.replace(new RegExp(`(^|[?&])${esc(leaf)}=${esc(v)}(?=&|$)`), (_m, p1) => `${p1}${leaf}=${d.replace}`);
    }
  }
  return q;
}

// ---------------- 值溯源: seq/fixed 动态点 → 参数链 ----------------
// correlate 的历史短板: seq 类(单号/UUID)只标注"应从上游提取", 从没有真的挂上提取器 ——
// 与 JMX _extractor 两个月没人接线是同款断档。这里用纯离线值溯源补齐:
// 动态值(如 65 开头单号)在【更早条目】的响应 JSON 里找完全相等的叶子 →
// 命中即合成参数链({origin:"corr"}), 与 AI 建链同构, 重放注入/JMX 提取器/PY 提取全下游自动生效。
// 溯源规则(保守, 宁可不链也不链错):
//   1. 只搜目标条目之前的条目(值是上游产出, 时间序天然约束)
//   2. 同值多路径: 优先叶子名与动态字段同名; 无同名且路径不唯一 → 放弃
//   3. timestamp 类不溯源(已有 ${__time()} 参数化, 挂链反而画蛇添足)

// 响应 JSON → 全部叶子 [{path, value}](数组展开成下标路径, 与 diffJsonBodies 的 path 同形态)
function indexResponseLeaves(text) {
  let j;
  try { j = JSON.parse(text); } catch { return null; }
  const out = [];
  const walk = (v, path) => {
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, path + "." + i)); return; }
    if (v && typeof v === "object") { for (const k of Object.keys(v)) walk(v[k], path + "." + k); return; }
    if (v == null) return;
    out.push({ path: path.replace(/^\./, ""), value: String(v) });
  };
  walk(j, "");
  return out;
}

// 按点路径从 body JSON 取叶子值(path 形态 a.b.0.c, 数字段即数组下标)
// 表单体: path 必是单段键名, URLSearchParams 取值(表单 diff 的 path 形态保证)
function jsonPathGet(text, path) {
  if (isFormBody(text)) {
    const v = new URLSearchParams(text).get(String(path).split(".").pop());
    return v === null ? null : v;
  }
  let v;
  try { v = JSON.parse(text); } catch { return null; }
  for (const seg of String(path).split(".")) {
    if (v == null) return null;
    v = v[seg];
  }
  return v == null ? null : String(v);
}

// corrResult + entries → 合成参数链数组。
// usedVars: 已占用的变量名(AI 链的 var), 合成时错开防撞名。
function linkSeqDynamics(entries, corrResult, usedVars) {
  if (!Array.isArray(entries) || !corrResult || !Array.isArray(corrResult.groups)) return [];
  const taken = new Set(usedVars || []);
  const mkVar = (leaf) => {
    const base = "V_" + String(leaf).replace(/[^A-Za-z0-9]/g, "_");
    let name = base, n = 2;
    while (taken.has(name)) name = base + "_" + n++;
    taken.add(name);
    return name;
  };
  const posOf = new Map(entries.map((e, i) => [e.id, i])); // 条目在集内的绝对位置
  const idxCache = new Map(); // 响应叶子索引缓存(同一响应只解析一次)
  const leavesOf = (i) => {
    if (!idxCache.has(i)) idxCache.set(i, indexResponseLeaves(entries[i].response) || []);
    return idxCache.get(i);
  };
  const links = [];
  for (const g of corrResult.groups) {
    const members = entries.filter((e) => e.method === g.method && e.path === g.path);
    for (const t of members) {
      const ti = posOf.get(t.id);
      if (ti == null || ti < 0) continue;
      for (const d of g.dynamics) {
        if (d.classify && d.classify.kind === "timestamp") continue;
        // Q_ 前缀 = query 参数动态(v1.0.96 起溯源): 取值在 query(URLSearchParams 键取),
        // 溯源命中后 toParam 用 "url."+键 —— 与 AI 链/应用端(applyAiChainToJmx/aic/PY)的
        // header./url./body 三形态对齐, 下游 url 分支自动承接。query 键可能含点,
        // 用 slice(2) 剥前缀(不按 "." 切段, query diff 的路径是完整键名)
        const isQ = /^Q_/.test(d.path);
        const leaf = isQ ? String(d.path).slice(2) : String(d.path).split(".").pop();
        const val = isQ ? new URLSearchParams(String(t.query || "").replace(/^\?/, "")).get(leaf)
          : jsonPathGet(t.body || "", d.path);
        if (val == null || val === "") continue;
        // 从最近的上游往前找: 取离目标最近的一个命中(业务上最近的产出者最可能是源)
        for (let si = ti - 1; si >= 0; si--) {
          const cands = leavesOf(si).filter((l) => l.value === val);
          if (!cands.length) continue;
          const byLeaf = cands.filter((l) => l.path.split(".").pop().toLowerCase() === leaf.toLowerCase());
          const best = byLeaf.length ? byLeaf[0] : (cands.length === 1 ? cands[0] : null);
          if (!best) continue; // 同值多路径且无同名叶 → 溯源不确定, 放弃(宁可不链)
          links.push({ from: si, fromId: entries[si].id, fromJsonPath: best.path,
            to: ti, toId: t.id, toParam: isQ ? "url." + leaf : leaf, var: mkVar(leaf), value: val, origin: "corr" });
          break;
        }
      }
    }
  }
  return links;
}

// node 环境导出(供单测; 浏览器 script 标签加载时此分支不执行)
if (typeof module !== "undefined" && module.exports) {
  module.exports = { diffJsonBodies, classifyDynamic, analyzeCorrelation,
                     applyDynamics, applyDynamicsToQuery, pathToVar,
                     indexResponseLeaves, jsonPathGet, linkSeqDynamics,
                     isFormBody, parseFormBody };
}
