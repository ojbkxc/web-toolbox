// samples/loader.js — 样本库加载器。
// 把 samples/ 下各种形态的样本(known/ + opensource/)统一成:
//   { meta: sample.json 元数据, entries: [{method,url,path,query,headers,body}] }
// 供回归测试(test_regression_samples.js)与将来的 auth.js 消费。
// 纯 node, 零依赖。

const fs = require("fs");
const path = require("path");

// 解析 URL -> {path, query}
function splitUrl(url) {
  try {
    const u = new URL(url);
    return { path: u.pathname, query: u.search.replace(/^\?/, "") };
  } catch {
    // 非绝对 URL(如 taurus yaml 里的相对路径)
    const q = url.indexOf("?");
    return q >= 0 ? { path: url.slice(0, q), query: url.slice(q + 1) } : { path: url, query: "" };
  }
}

// sample.jsonl 格式: 每行 {method,url,post,headers?,status?}
function readJsonl(file) {
  const entries = [];
  for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t);
      const { path: p, query } = splitUrl(o.url || "");
      let body = o.post || o.body || "";
      if (typeof o.body === "object" && o.body !== null) body = JSON.stringify(o.body);
      const en = {
        method: o.method || "GET",
        url: o.url,
        path: p,
        query,
        headers: o.headers || {},
        body,
      };
      // 可选: 响应体(登录链 token 特征在 resp 里, 认证形态识别需要)
      if (o.response !== undefined) en.response = typeof o.response === "object" ? JSON.stringify(o.response) : String(o.response);
      if (o.status !== undefined) en.status = o.status;
      // 可选: 响应 mime。引擎真实条目必有 item.mime(CDP responseReceived 的 response.mimeType,
      // SSE 判定主信号)。此前 loader 丢弃 mime —— 样本即使标注也进不了回归, filterSkippable
      // 的 mime 主路径在样本维度结构性盲区(v1.0.65 #158 方向②对账发现)。
      if (o.mime !== undefined) en.mime = String(o.mime);
      entries.push(en);
    } catch {}
  }
  return entries;
}

// XML 属性值反转义(与 body 提取同一套实体; path/domain 一样是 xmlEsc 产物,
// 自家 buildJmx 的多参数 query 会让 path 含 &amp; —— 不反转义则读回 '&amp;' 污染 query)
function xmlUnesc(s) {
  return String(s).replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&#10;/g, "\n");
}

// .jmx 格式: 提取 HTTPSamplerProxy 的 path/method/body
function readJmx(file) {
  const xml = fs.readFileSync(file, "utf-8");
  const entries = [];
  // 按采样器块切
  const re = /<HTTPSamplerProxy[^>]*>(.*?)<\/HTTPSamplerProxy>/gs;
  let m;
  while ((m = re.exec(xml))) {
    const block = m[1];
    const path = xmlUnesc(/<stringProp name="HTTPSampler.path">([^<]*)<\/stringProp>/.exec(block)?.[1] || "");
    const method = /<stringProp name="HTTPSampler.method">([^<]*)<\/stringProp>/.exec(block)?.[1] || "GET";
    const domain = xmlUnesc(/<stringProp name="HTTPSampler.domain">([^<]*)<\/stringProp>/.exec(block)?.[1] || "");
    const protocol = /<stringProp name="HTTPSampler.protocol">([^<]*)<\/stringProp>/.exec(block)?.[1] || "https";
    // body: raw 形态
    let body = "";
    const argV = /<stringProp name="Argument.value">([^<]*)<\/stringProp>/.exec(block)?.[1] || "";
    if (argV) body = xmlUnesc(argV);
    // domain 是 ${VAR} 形态(v1.0.79 buildJmx 变量化产物) → 不走 new URL 解析:
    // node 的 new URL('https://${HOST_1}/order/list?...') 会把 '${HOST_1}/order'
    // 当 hostname 拆出(实测 hostname='order'), path/query 全被污染。url 保留
    // 变量串原样(明示这是变量化 JMX, 不可作绝对 URL 用), path/query 直接用采样器
    // 自己的 —— 采样器 path 是纯 path+query(不含主机), roundtrip 三要素依然一致。
    const isVar = /^\$\{[^}]+\}$/.test(domain);
    const url = isVar ? `${protocol}://${domain}${path}` : (domain ? `${protocol}://${domain}${path}` : path);
    const qPos = path.indexOf("?");
    const { path: p, query } = isVar ? { path: qPos >= 0 ? path.slice(0, qPos) : path, query: qPos >= 0 ? path.slice(qPos + 1) : "" } : splitUrl(url);
    entries.push({ method, url, path: p, query, headers: {}, body });
  }
  return entries;
}

// .json postman collection v2
function readPostman(file) {
  const coll = JSON.parse(fs.readFileSync(file, "utf-8"));
  const entries = [];
  const walk = (items) => {
    for (const it of items) {
      if (it.item) walk(it.item);
      else {
        const r = it.request || {};
        let url = r.url;
        if (url && typeof url === "object") url = url.raw || url.url || "";
        let body = "";
        if (r.body && r.body.raw) body = r.body.raw;
        const { path: p, query } = splitUrl(url || "");
        entries.push({ method: r.method || "GET", url: url || "", path: p, query, headers: {}, body });
      }
    }
  };
  walk(coll.item || []);
  return entries;
}

// 某样本目录 -> {meta, entries, type}
function readSampleDir(dir) {
  const metaPath = path.join(dir, "sample.json");
  if (!fs.existsSync(metaPath)) return null;
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));

  const jsonl = path.join(dir, "sample.jsonl");
  if (fs.existsSync(jsonl)) return { meta, entries: readJsonl(jsonl), type: "jsonl" };

  // 目录里可能有 jmx / postman
  const jmxFiles = fs.readdirSync(dir).filter((f) => f.endsWith(".jmx"));
  if (jmxFiles.length) return { meta, entries: readJmx(path.join(dir, jmxFiles[0])), type: "jmx" };

  const pm = path.join(dir, "postman-sample-collection.json");
  if (fs.existsSync(pm)) return { meta, entries: readPostman(pm), type: "postman" };

  return { meta, entries: [], type: "none" };
}

// 遍历 samples/ 全部样本
function loadAllSamples(samplesRoot) {
  const out = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      if (name.startsWith("_")) continue; // 临时目录
      const full = path.join(dir, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) {
        if (fs.existsSync(path.join(full, "sample.json"))) {
          out.push({ dir: full, ...readSampleDir(full) });
        } else {
          walk(full);
        }
      }
    }
  };
  walk(samplesRoot);
  return out;
}

module.exports = { loadAllSamples, readSampleDir, readJsonl, readJmx, readPostman, splitUrl };