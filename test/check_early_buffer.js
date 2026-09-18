// check_early_buffer.js —— 冷启动窗口(earlyBuffer)与 SW 重启恢复的行为级覆盖(v1.0.52)。
// 盲区由来: mock_bg_test 的事件流测试在 setDomains 之后才发 requestWillBeSent,
// domainsCache 已加载 —— "storage 还没读完就来了请求"的缓冲分支从未被测过。
// 这条路径是"worker 被杀又唤醒"的关键防线: Chrome MV3 SW 随时可能被回收,
// 唤醒时 storage.get 是异步的, 冷启动窗口内的请求若不缓冲就静默丢。
// 本文件用"先发请求后 setDomains"的乱序时序构造 domainsCache===null 窗口。
// v1.0.54 起兼测: unmatchedHosts 诊断线索(淘汰策略/计数/会话清零)与换 tab 竞态窗口。
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..');

const assert = (cond, msg) => { if (!cond) { console.log('FAIL: ' + msg); process.exit(1); } console.log('  OK ' + msg); };

// —— 自建 chrome stub(不用 require 注入法, 要控制时序: 先事件后域名) ——
const mem = {};
const listeners = {};
function on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); }
// detach 记录桶: 换 tab 竞态窗口断言要看 detach 顺序(attach 的 mock 不记录)
const detachLog = [];

// stateReady 是 background.js 顶层 await 链 —— 用可控 gate 让 loadRuntimeState 挂起
// 直到测试放行, 构造出"请求已到但 storage 未读完"的真实冷启动窗口。
let gateResolve = null;
const stateGate = new Promise((r) => { gateResolve = r; });
// 预置"录制中"的持久状态: SW 被杀又唤醒时, storage 里已有 recording + 域名 + 目标 tab。
// KEY_REC='toolbox.recording' / KEY_DOMAINS='toolbox.domains' / KEY_TABS='toolbox.debugTabs'。
mem['toolbox.recording'] = 'recording';
mem['toolbox.domains'] = ['app.test.com'];
mem['toolbox.debugTabs'] = [123];

global.chrome = {
  storage: {
    local: {
      QUOTA_BYTES: 10485760,
      // background 两种调用风格都用(getDomains 回调式 / loadRuntimeState await 式),
      // get 需同时支持; domains 读挂 gate —— stateReady 卡住 → domainsCache 保持 null →
      // 冷启动窗口成立(真实场景: SW 唤醒瞬间 CDP 事件先于 storage 读取完成到达)。
      get: async (keys, cb) => {
        if (Array.isArray(keys) && keys.includes('toolbox.domains')) await stateGate;
        const out = {};
        for (const k of [].concat(keys)) if (k in mem) out[k] = mem[k];
        if (cb) cb(out);
        return out;
      },
      set: async (obj, cb) => { Object.assign(mem, obj); if (cb) cb(); },
      remove: async (keys, cb) => { for (const k of [].concat(keys)) delete mem[k]; if (cb) cb(); },
    },
    onChanged: { addListener: () => {} },
  },
  runtime: { onInstalled: { addListener: (fn) => on('installed', fn) }, onMessage: { addListener: (fn) => on('message', fn) } },
  debugger: {
    onDetach: { addListener: (fn) => on('detach', fn) },
    onEvent: { addListener: (fn) => on('event', fn) },
    attach: async () => {}, detach: async (target) => { detachLog.push(target.tabId); },
    sendCommand: async () => ({ body: '{"ok":1}', base64Encoded: false }),
  },
  alarms: { onAlarm: { addListener: () => {} }, create: async () => {}, clear: async () => {} },
  action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
  tabs: { onRemoved: { addListener: () => {} } },
  permissions: { contains: async () => false },
};

require(path.join(ROOT, 'background.js'));

function msg(type, payload) {
  return new Promise((resolve) => {
    let responded = false;
    const sendResponse = (v) => { if (!responded) { responded = true; resolve(v); } };
    const ret = listeners['message'][0]({ type, ...payload }, {}, sendResponse);
    if (ret !== true && !responded) resolve(undefined);
  });
}
function fire(method, params) {
  const src = { tabId: 123 };
  for (const fn of listeners['event']) fn(src, method, params);
}

(async () => {
  // 时序: SW 启动(stateReady 挂在 domains 的 get 上) → 立刻来请求(冷启动窗口, 进 earlyBuffer)
  // → 放行 storage → stateReady 补处理缓冲请求(此时 storage 里已是 recording, 补处理后入列)。
  // 事件先于用户消息到达是真实唤醒时序(keepalive 失效被杀的 edge case 里, CDP 事件流恢复先于一切)。
  fire('Network.requestWillBeSent', {
    requestId: 'cold1',
    request: { url: 'https://app.test.com/web/login', method: 'POST', headers: {}, postData: '{"cold":1}' },
  });
  gateResolve();
  await new Promise((r) => setTimeout(r, 80));
  // 放行后请求应已被补处理进 pending → 走完整事件流
  fire('Network.responseReceived', { requestId: 'cold1', response: { status: 200, mimeType: 'application/json' } });
  fire('Network.loadingFinished', { requestId: 'cold1', timestamp: 1.5 });
  await new Promise((r) => setTimeout(r, 150));
  // 放行后请求应已被补处理进 pending → 走完整事件流
  fire('Network.responseReceived', { requestId: 'cold1', response: { status: 200, mimeType: 'application/json' } });
  fire('Network.loadingFinished', { requestId: 'cold1' });
  await new Promise((r) => setTimeout(r, 80));
  const h = mem['toolbox.harvest'];
  assert(h && h.entries && h.entries.length === 1, 'e1. 冷启动窗口的请求不丢(stateReady 后补处理入列)');
  assert(h.entries[0].body === '{"cold":1}', 'e2. 补处理的请求 body 完整(postData 归一化链未断)');
  assert(h.entries[0].status === 200, 'e3. 补处理后 responseReceived/loadingFinished 正常对接');

  // 冷启动窗口的域名过滤语义: 补处理走 handleRequestWillBeSent 同一函数,
  // 非授权域名的请求被丢(不是缓冲就全收) —— 静态断言分支形态。
  const bg = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
  assert(bg.includes('if (domainsCache === null) { earlyBuffer.push(params); return; }'), 'e4. 冷启动缓冲分支代码在(域名过滤前置)');
  assert(bg.includes('const buf = earlyBuffer.splice(0);\n    for (const p of buf) handleRequestWillBeSent(p);'), 'e5. stateReady 补处理 splice(0) 全量取出(防半处理)');
  assert(bg.includes('function handleRequestWillBeSent(params)'), 'e6. 补处理复用 handleRequestWillBeSent(域名/状态过滤同路径)');

  // —— 零覆盖 handler 补测(v1.0.53 消息协议盘点): containsPermission / refreshDomainCache ——
  // containsPermission: options/popup 判"当前 tab 域是否已授权"。回调风格 chrome.permissions.contains,
  // 与 stub 的 permissions.contains: async () => false 不同签名 —— 这里直接驱动消息 handler 验证接线。
  global.chrome.permissions.contains = (p, cb) => cb(p.origins[0] === 'https://granted.com/*');
  assert((await msg('containsPermission', { origin: 'https://granted.com/*' })).has === true, 'e7. containsPermission 回调接线(granted=true 正确回传)');
  assert((await msg('containsPermission', { origin: 'https://other.com/*' })).has === false, 'e8. containsPermission 未授权回 false');
  assert((await msg('containsPermission', {})) === undefined, 'e9. 无 origin 的 containsPermission 不进 handler(返回 undefined, 调用方早拦)');

  // refreshDomainCache: onChanged 监听已实时跟进, 显式刷新兜底。行为级: 改 storage 域名(绕过
  // onChanged —— stub 不触发监听)后 refresh 应重载 domainsCache, getRecInfo.domains 可观测。
  mem['toolbox.domains'] = ['fresh.test.com'];
  const beforeRefresh = await msg('getRecInfo');
  assert(beforeRefresh.domains.join() === 'app.test.com', 'e10. 前置: 未刷新前 domainsCache 还是旧值');
  await msg('refreshDomainCache');
  const afterRefresh = await msg('getRecInfo');
  assert(afterRefresh.domains.join() === 'fresh.test.com', 'e11. refreshDomainCache 重载缓存(onChanged 失效时的兜底路径有效)');

  // —— unmatchedHosts 诊断线索(v1.0.54) ——
  // 现在处于 recording + fresh.test.com 域名 + debugTabs[123]。发未配置域名的请求,
  // 录制中必然被域名过滤 → unmatched 计数。这里 fire 的 src.tabId 都是 123。
  // 低频域只来一次; 网关域(gw)每次都来 —— 它是"为什么录不上"的高价值线索(v1.0.54
  // 淘汰策略改为按次数留大: 旧的按插入序 FIFO 会把高价值网关域挤掉)。
  for (let i = 1; i <= 10; i++) {
    fire('Network.requestWillBeSent', { requestId: 'u' + i, request: { url: `https://no${i}.test.com/x`, method: 'GET', headers: {} } });
    fire('Network.requestWillBeSent', { requestId: 'g' + i, request: { url: 'https://gw.test.com/api', method: 'GET', headers: {} } });
  }
  await new Promise((r) => setTimeout(r, 50));
  const infoU = await msg('getRecInfo');
  assert(infoU.unmatched.length <= 8, `e12. unmatched 主机数守 8 上限(实得 ${infoU.unmatched.length})`);
  assert(infoU.unmatched.some((s) => s.startsWith('gw.test.com×')), 'e13. 高频网关域留在线索里(淘汰按次数非插入序): ' + infoU.unmatched.join(', '));
  assert(infoU.unmatched.some((s) => s.includes('×10')), 'e14. 计数累加正确(×10): ' + infoU.unmatched.filter((s) => s.includes('×10')).join(', '));
  // 会话边界: startRecording 清零(unmatchedHosts.clear 在 startRecording 里, 新会话重统计);
  // 恢复(paused→recording)也走 startRecording, 同样清零 —— "继续"是换会话语义, 不叠旧线索。
  fire('Network.requestWillBeSent', { requestId: 'u100', request: { url: 'https://no100.test.com/x', method: 'GET', headers: {} } });
  await msg('startRecording', { tabId: 123 });
  const infoR = await msg('getRecInfo');
  assert(infoR.unmatched.length === 0, 'e15. startRecording 清零诊断线索(新会话重统计)');
  // 残留语义: stopRecording 不清 unmatched —— 用户停止后仍可查"刚才漏了什么域"
  fire('Network.requestWillBeSent', { requestId: 'u200', request: { url: 'https://stop-leak.test.com/x', method: 'GET', headers: {} } });
  await msg('stopRecording');
  const infoS = await msg('getRecInfo');
  assert(infoS.unmatched.some((s) => s.startsWith('stop-leak.test.com')), 'e16. stop 后诊断线索保留(停止后仍可查"刚才漏了什么域")');

  // —— 换 tab 竞态窗口(v1.0.54): detach 旧 → attach 新 两步间 CDP 事件分流 ——
  // onEvent 分流只认 KEY_TABS: startRecording 换 tab 时 detachTab(旧) 先把旧 tab 从
  // KEY_TABS 摘掉(事件从此漏收=正确, 旧 tab 不该再录), attachTab(新) 再 push 新 tabId。
  // 窗口内(摘旧~挂新)旧 tab 事件因 KEY_TABS 不含而被丢弃 —— 与 pending.clear() 的
  // "旧 tab 在途请求作废"语义一致, 不混录。行为级验证 200(旧)→777(新):
  detachLog.length = 0;
  mem['toolbox.debugTabs'] = [200];
  await msg('startRecording', { tabId: 777 });
  assert(detachLog.includes(200), 'e17. 换 tab 先 detach 旧 tab(防双 tab 混录)');
  const tabsAfter = mem['toolbox.debugTabs'];
  assert(Array.isArray(tabsAfter) && tabsAfter.join() === '777', 'e18. 换 tab 后 KEY_TABS 只剩新 tab: ' + JSON.stringify(tabsAfter));
  // 换 tab 后旧 tab(200) 事件: KEY_TABS=[777] 不含 200 → 分流丢弃, 不入新会话
  for (const fn of listeners['event'].slice()) fn({ tabId: 200 }, 'Network.requestWillBeSent', { requestId: 'stale', request: { url: 'https://app.test.com/stale', method: 'GET', headers: {} } });
  await new Promise((r) => setTimeout(r, 50));
  const stale = (mem['toolbox.harvest'].entries || []).some((e) => e.path === '/stale');
  assert(!stale, 'e19. 换 tab 后旧 tab 事件被分流丢弃(不混入新会话)');
  // onDetach(用户点黄条取消) 与 stopRecording 并发: detachTab 幂等(catch 已断开),
  // 清 attach 记录不留"幽灵录制中"
  for (const fn of (listeners['detach'] || [])) fn({ tabId: 777 });
  await new Promise((r) => setTimeout(r, 50));
  const tabsDetached = mem['toolbox.debugTabs'];
  assert(tabsDetached.join() === '', 'e20. onDetach 清 attach 记录(不留幽灵录制): ' + JSON.stringify(tabsDetached));
  await msg('stopRecording');
  assert(true, 'e21. stopRecording 在已 detach 后再跑不炸(detachTab catch 幂等)');

  console.log('');
  console.log('=== 冷启动缓冲覆盖 PASS ===');
  process.exit(0);
})();
