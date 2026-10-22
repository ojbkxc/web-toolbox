// exporters.js —— bridge 侧导出/关联: 直接 require 扩展仓库里同一份源码。
//
// 这不是复制粘贴: 加载的是 ../../jmx.js、../../common.js 等原文件。
// 好处:
//   1. 只有一份实现, 扩展侧改规则(清洗/关联/断言)bridge 自动同步;
//   2. 这些文件已通过 `node test/run_all.js` 的 40 项走查覆盖;
//   3. 不碰 service worker 的全局作用域(common.js 与 background.js 有同名 const,
//      在同一个 SW 里 importScripts 会 SyntaxError 把整个扩展带塌)。

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = path.resolve(here, "..", "..");

// 这些模块在 node 下都有 `if (typeof module !== "undefined")` 导出分支(见各文件末尾),
// 所以可以直接 require。require 失败说明用户把 bridge 目录单独拷走了 —— 明确报错。
function load(name) {
  try {
    return require(path.join(EXT_ROOT, name));
  } catch (e) {
    throw new Error(`无法加载扩展模块 ${name}（bridge 必须放在扩展仓库内）: ${e.message}`);
  }
}

let cached = null;
function mods() {
  if (cached) return cached;
  cached = {
    common: load("common.js"),
    jmx: load("jmx.js"),
    pyscript: load("pyscript.js"),
    correlate: load("correlate.js"),
    auth: load("auth.js"),
  };
  return cached;
}

// 与扩展侧导出页同一套口径: 先剔除静态资源, 再识别登录前置。
// 导出集语义: 传了 ids 就只导这些(id 来自 net_list), 不传就全量。
export function pick(entries, ids) {
  if (!Array.isArray(ids) || !ids.length) return entries;
  const set = new Set(ids);
  return entries.filter((e) => set.has(e.id));
}

// 与扩展侧导出页同一口径: 先剔除静态资源, 再识别登录前置。
// filterSkippable 返回 {entries, dropped}(不是数组), 扩展侧状态里会提示剔除数。
function clean(entries) {
  const { common } = mods();
  if (typeof common.filterSkippable !== "function") return entries;
  const r = common.filterSkippable(entries);
  return Array.isArray(r) ? r : (r && Array.isArray(r.entries) ? r.entries : entries);
}

export function buildHarText(entries) {
  const { common } = mods();
  if (typeof common.buildHar !== "function") throw new Error("HAR 导出器不可用");
  return JSON.stringify(common.buildHar(entries), null, 2);
}

export function buildJmxText(entries, opts = {}) {
  const { jmx, auth } = mods();
  const es = clean(entries);
  if (!es.length) throw new Error("过滤后没有条目");
  // 登录前置识别: 与侧栏导出同一份 autoDetectPrelude
  let preludeIds = [];
  try {
    const p = auth.autoDetectPrelude(es);
    preludeIds = Array.isArray(p) ? p.map((x) => (typeof x === "string" ? x : x && x.id)).filter(Boolean) : [];
  } catch {
    preludeIds = [];   // 识别失败不阻断导出, 只是没有 OnceOnly 包装
  }
  return jmx.buildJmx(es, {
    prelude: preludeIds,
    threads: opts.threads,
    title: "web-toolbox (AI bridge)",
  });
}

export function buildPyText(entries) {
  const { pyscript } = mods();
  const es = clean(entries);
  if (!es.length) throw new Error("过滤后没有条目");
  return pyscript.buildPyScript(es, "cookies.state.json", {});
}

export function correlateText(entries) {
  const { correlate } = mods();
  return correlate.analyzeCorrelation(entries);
}
