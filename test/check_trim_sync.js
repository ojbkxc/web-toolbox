// 验证 trimHint 三处清空路径的同步隐藏: 清洗删掉选中条 / storage 清空 / 丢弃。
// 场景 2d(v1.0.55): 引擎裁剪推送的幽灵条目语义(不删保选中 + 自愈闭环)。
const fs = require('fs'), vm = require('vm'), path = require('path');
const ROOT = require('path').resolve(__dirname, '..');

function makeSandbox() {
  const elements = new Map();
  const storageData = new Map();
  let onChangedHandler = null; // 暴露给测试: storage.onChanged 注册的监听器(清空分支直调用)
  const storageLocal = {
    get: (keys, cb) => { const r = {}; for (const k of [].concat(keys)) r[k] = storageData.get(k); const p = Promise.resolve(r); if (typeof cb === 'function') setTimeout(() => cb(r), 0); return p; },
    set: (obj, cb) => { for (const k of Object.keys(obj)) storageData.set(k, obj[k]); const p = Promise.resolve(); if (typeof cb === 'function') setTimeout(() => cb(), 0); return p; },
    remove: (keys, cb) => { for (const k of [].concat(keys)) storageData.delete(k); const p = Promise.resolve(); setTimeout(() => cb && cb(), 0); return p; },
  };
  const mkEl = (id) => { if (elements.has(id)) return elements.get(id);
    const el = { id, style: {}, dataset: {}, children: [], value: '', textContent: '', innerHTML: '', className: '', checked: true, disabled: false,
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      _listeners: {},
      addEventListener(ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); },
      dispatchEvent(ev) { for (const fn of (this._listeners[ev] || [])) fn(); },
      setAttribute(k, v) { this[k === "aria-label" ? "ariaLabel" : k] = v; }, appendChild() {}, insertBefore() {}, querySelector() { return mkEl(id + '_q'); }, querySelectorAll() { return []; }, scrollIntoView() {}, onclick: null };
    elements.set(id, el); return el; };
  const documentObj = { getElementById: (id) => mkEl(id), createElement: () => mkEl('a' + Math.random()), createDocumentFragment: () => mkEl('f'), createTextNode: (t) => ({ textContent: t }), querySelectorAll() { return []; }, body: mkEl('body') };
  const chromeStub = {
    storage: { local: storageLocal, onChanged: { addListener(fn) { onChangedHandler = fn; } } },
    runtime: { sendMessage: async () => ({ ok: true, recState: 'idle', count: 2 }), openOptionsPage() {} },
    tabs: { query: async () => [{ id: 101, url: 'https://app.b.com/page' }] },
    // contains 回调式真调 cb(v1.0.74): containsOrigin 是 new Promise(cb 形态),
    // 旧 async()=>true 不调 cb → 任何走 containsOrigin 的 await 永挂。
    permissions: { contains: (p, cb) => cb(true) },
    scripting: { executeScript: async () => [{ result: { status: 200, ok: true, text: '{"ok":1}' } }] },
  };
  const sb = { console, setTimeout, setInterval: () => 0, clearInterval() {}, URL, URLSearchParams,
    fetch: async () => { throw new Error('no fetch'); },
    navigator: { clipboard: { writeText: async () => {} } }, document: documentObj, chrome: chromeStub, performance: { now: () => Date.now() } };
  sb.window = sb; sb.globalThis = sb;
  vm.createContext(sb);
  const html = fs.readFileSync(ROOT + '/sidepanel/sidepanel.html', 'utf8');
  for (const m of html.matchAll(/<script src="([^"]+)"><\/script>/g)) {
    const f = path.resolve(ROOT + '/sidepanel', m[1]);
    try { new vm.Script(fs.readFileSync(f, 'utf8'), { filename: f }).runInContext(sb); }
    catch (e) { console.log('  [load-err]', m[1], ':', String(e).slice(0, 150)); }
  }
  return { sb, elements, storageData, onChangedHandler };
}

const assert = (cond, msg) => { if (!cond) { console.log('FAIL: ' + msg); process.exit(1); } console.log('  OK ' + msg); };

(async () => {
  // 场景 1: 选中一条静态资源(清洗会删它), trimHint 应隐藏
  {
    const { sb, elements, storageData } = makeSandbox();
    storageData.set('toolbox.harvest', { v: 1, entries: [
      { id: 'r1', method: 'GET', url: 'https://app.b.com/app.js', path: '/app.js', query: '', headers: {}, body: null, status: 200, response: '', mime: 'text/javascript', ts: '2026-09-17T08:00:00Z' },
      { id: 'r2', method: 'POST', url: 'https://app.b.com/order/create', path: '/order/create', query: '', headers: {}, body: '{}', status: 200, response: '{}', mime: 'application/json', ts: '2026-09-17T08:00:01Z' },
    ]});
    await new Promise(r => setTimeout(r, 30));
    await vm.runInContext('loadHarvest()', sb); // 明确等待初始化完成(storage.get 是异步回调链)
    vm.runInContext('select("r1")', sb);
    assert(elements.get('trimHint').style.display === '', '1a. 选中后 trimHint 显示');
    vm.runInContext('globalThis.confirm = () => true', sb);
    await vm.runInContext('cleanVisible()', sb);
    assert(vm.runInContext('entries.length', sb) === 1, '1b. 清洗删掉选中的静态资源');
    // 1c(#173 就近补选): 清洗删掉选中条后自动补选相邻条 —— trimHint 不隐藏而是
    // 指向新选中条; 断言"指向的不再是已删条" + 详情区不空屏。
    const selAfter = vm.runInContext('selectedId', sb);
    assert(selAfter === 'r2', '1c. 清洗删掉选中条后就近补选 r2(不再空态): ' + selAfter);
    assert(elements.get('trimHint').style.display === '' && elements.get('trimFrom').textContent.includes('/order/create'),
      '1c2. trimHint 指向补选条(同步跟随): ' + elements.get('trimFrom').textContent);
  }
  // 场景 1b: trimNote —— 勾选模式下起点不在勾选集内, 提示"不会裁剪"(v1.0.38 新 UI 面)
  {
    const { sb, elements, storageData } = makeSandbox();
    storageData.set('toolbox.harvest', { v: 1, entries: [
      { id: 'r1', method: 'GET', url: 'https://app.b.com/list', path: '/list', query: '', headers: {}, body: '', status: 200, response: '{}', mime: 'application/json', ts: '2026-09-17T08:00:00Z' },
      { id: 'r2', method: 'POST', url: 'https://app.b.com/order/create', path: '/order/create', query: '', headers: {}, body: '{}', status: 200, response: '{}', mime: 'application/json', ts: '2026-09-17T08:00:01Z' },
      { id: 'r3', method: 'POST', url: 'https://app.b.com/order/submit', path: '/order/submit', query: '', headers: {}, body: '{}', status: 200, response: '{}', mime: 'application/json', ts: '2026-09-17T08:00:02Z' },
    ]});
    await new Promise(r => setTimeout(r, 30));
    await vm.runInContext('loadHarvest()', sb);
    vm.runInContext('select("r2")', sb);
    assert((elements.get('trimNote').textContent || '') === '', '1d. 普通模式起点无 note');
    // 1d2. optTrim 手动关 → note 明示"不会裁剪"(v1.0.42: 开关关了文案不能还装作会裁);
    //      再开 → note 消失(change 监听联动, 无须手动 updateTrimUi)
    vm.runInContext('document.getElementById("optTrim").checked = false; document.getElementById("optTrim").dispatchEvent("change");', sb);
    assert((elements.get('trimNote').textContent || '').includes('不会裁剪'), '1d2a. optTrim 关闭后 note 明示不裁剪(change 联动): ' + elements.get('trimNote').textContent);
    vm.runInContext('document.getElementById("optTrim").checked = true; document.getElementById("optTrim").dispatchEvent("change");', sb);
    assert((elements.get('trimNote').textContent || '') === '', '1d2b. optTrim 重开后 note 清空(change 联动)');
    vm.runInContext('togglePickMode(); togglePick("r1"); togglePick("r3");', sb);
    assert((elements.get('trimNote').textContent || '').includes('不在勾选集'), '1e. 勾选 {r1,r3} 起点选 r2 → note 明示不裁剪(togglePick 联动): ' + elements.get('trimNote').textContent);
    vm.runInContext('togglePick("r2")', sb);
    assert((elements.get('trimNote').textContent || '') === '', '1f. 起点入勾选集后 note 消失(togglePick 联动, 无须手动 updateTrimUi)');
    vm.runInContext('togglePickMode()', sb);
    assert((elements.get('trimNote').textContent || '') === '', '1g. 退出勾选模式 note 清空(togglePickMode 联动)');
    // 全清退回语义提示(v1.0.38): togglePickAll 全清 → setRecStatus 明说退回可见集
    vm.runInContext('togglePickMode(); togglePickAll();', sb);
    await vm.runInContext('togglePickAll()', sb);
    assert((elements.get('chainMsg').textContent || '').includes('退回可见集'), '1h. 全清勾选提示退回可见集: ' + elements.get('chainMsg').textContent);
    assert(vm.runInContext('exportSet().length', sb) === 3, '1i. 空勾选集 exportSet 退回可见集 3 条');
    // 1j. ✂ 起点按钮: 点详情页 setTrim → optTrim 置 on + 提示 + 切导出页
    // (querySelector stub 局部替换, 断言后还原 —— 全局替换会让本场景后的任何 querySelector 消费方拿到假对象)
    // 按钮态两段式(v1.0.41): optTrim 关 → 普通态"✂ 起点"; 置 on 后 renderDetail 再渲 → pri 高亮"✂ 已是起点"
    vm.runInContext('document.getElementById("optTrim").checked = false; renderDetail();', sb);
    const btnHtml1 = vm.runInContext('document.getElementById("detail").innerHTML', sb);
    assert(/id="setTrim"/.test(btnHtml1) && !/btn pri" id="setTrim"/.test(btnHtml1), '1j0a. optTrim 关态下 setTrim 呈普通态(无 pri)');
    vm.runInContext('globalThis.__tabClicked = null; globalThis.__realQs = globalThis.document.querySelector; globalThis.document.querySelector = () => ({ click() { globalThis.__tabClicked = "exp"; } });', sb);
    vm.runInContext('document.getElementById("setTrim").onclick()', sb);
    assert(vm.runInContext('document.getElementById("optTrim").checked', sb) === true, '1j. setTrim 点击把 optTrim 置 on');
    assert((elements.get('chainMsg').textContent || '').includes('导出起点'), '1j2. setTrim 提示指向导出页: ' + elements.get('chainMsg').textContent);
    assert(vm.runInContext('__tabClicked', sb) === 'exp', '1j3. setTrim 点击后切到导出页 tab');
    vm.runInContext('globalThis.document.querySelector = globalThis.__realQs;', sb);
    // 1j4. 置 on 后再 renderDetail: 按钮应呈 pri 高亮"已是起点"(两段态区分度)
    vm.runInContext('renderDetail()', sb);
    assert(/btn pri" id="setTrim"/.test(vm.runInContext('document.getElementById("detail").innerHTML', sb)), '1j4. optTrim 开态下 setTrim 呈 pri 高亮"已是起点"');
    // 1j5. setTrim∩pick 状态背离(v1.0.42): 勾选模式且起点不在勾选集内 → pri 高亮是假象(实际不裁),
    //      按钮应回落普通态 + title 警示(与 trimNote 同语义, 按钮态不与真实效果背离)
    //      (1h 的 togglePickAll 已在勾选模式内, 先 togglePickMode 退出清空再进, 时序与 1e 一致)
    vm.runInContext('togglePickMode(); togglePickMode(); togglePick("r1"); togglePick("r3"); renderDetail();', sb);
    const btnOutPick = vm.runInContext('document.getElementById("detail").innerHTML', sb);
    assert(!/btn pri" id="setTrim"/.test(btnOutPick), '1j5a. 起点不在勾选集内 setTrim 无 pri(高亮会背离实际不裁)');
    assert(/id="setTrim" title="[^"]*不在勾选集/.test(btnOutPick), '1j5b. 起点不在勾选集内 title 警示');
    vm.runInContext('togglePick("r2"); renderDetail();', sb);
    assert(/btn pri" id="setTrim"/.test(vm.runInContext('document.getElementById("detail").innerHTML', sb)), '1j5c. 起点入勾选集后 setTrim 恢复 pri');
    vm.runInContext('togglePickMode()', sb);
  }
  // 场景 2: storage 清空(引擎侧丢弃)
  {
    const { sb, elements, storageData } = makeSandbox();
    storageData.set('toolbox.harvest', { v: 1, entries: [
      { id: 'r1', method: 'POST', url: 'https://app.b.com/order/create', path: '/order/create', query: '', headers: {}, body: '{}', status: 200, response: '{}', mime: 'application/json', ts: '2026-09-17T08:00:01Z' },
    ]});
    // 派生结果预置: 丢弃后这些内存变量必须同步清(v1.0.27 修 onChanged 漏清面, 此处钉死按钮路径)
    storageData.set('toolbox.aiChain', [{ from: 0, fromId: 'r1', fromJsonPath: 'a', to: 0, toId: 'r1', toParam: 'b', var: 'v1', value: 'x' }]);
    storageData.set('toolbox.aiAsserts', [{ path: 'POST /order/create', asserts: [{ type: 'status', target: 'status', expect: '200' }] }]);
    storageData.set('toolbox.corrResult', { groups: [{ method: 'POST', path: '/order/create', dynamics: [] }], summary: '1 处' });
    storageData.set('toolbox.manualPrelude', [['r1', true]]);
    await new Promise(r => setTimeout(r, 30));
    await vm.runInContext('loadHarvest()', sb);
    vm.runInContext('select("r1")', sb);
    assert(vm.runInContext('aiChain !== null && aiAsserts !== null && corrResult !== null && manualPrelude.size === 1', sb), '2-pre. loadHarvest 还原了链/断言/关联/手动前置');
    // 模拟引擎清空触发的 onChanged 不在 stub 里 —— 直接调用同一段逻辑路径:
    // 通过 discard 按钮走 clearHarvest + 本地清空
    vm.runInContext('globalThis.confirm = () => true', sb);
    await vm.runInContext('document.getElementById("btnDiscard").onclick()', sb);
    assert(vm.runInContext('entries.length', sb) === 0, '2a. 丢弃清空');
    assert(elements.get('trimHint').style.display === 'none', '2b. 丢弃后 trimHint 同步隐藏');
    assert(vm.runInContext('chainResults.length', sb) === 0, '2b2. 丢弃后 chainResults 清(死条目不喂 AI, v1.0.30)');
    assert(elements.get('btnChainAiDiag').style.display === 'none', '2b3. 丢弃后「调试失败」按钮隐藏(v1.0.30)');
    assert(vm.runInContext('corrResult === null', sb), '2c. 丢弃后 corrResult 内存同步清');
    assert(vm.runInContext('aiChain === null', sb), '2d. 丢弃后 aiChain 内存同步清');
    assert(vm.runInContext('aiAsserts === null', sb), '2e. 丢弃后 aiAsserts 内存同步清');
    assert(vm.runInContext('manualPrelude.size === 0', sb), '2f. 丢弃后 manualPrelude 内存同步清');
  }
  // 场景 2b: onChanged 清空分支(B 面板视角: 引擎/别处触发清空, 本面板只靠 storage 推送)
  // —— v1.0.27 修的正是这条路径漏清 aiChain/aiAsserts。stub 捕获注册的 handler 直调
  // (changes 形态同真实 Chrome: { key: { newValue } })。
  {
    const { sb, elements, storageData, onChangedHandler } = makeSandbox();
    if (!onChangedHandler) { console.log('  [skip] onChanged handler 未捕获'); }
    else {
      storageData.set('toolbox.harvest', { v: 1, entries: [
        { id: 'r1', method: 'POST', url: 'https://app.b.com/order/create', path: '/order/create', query: '', headers: {}, body: '{}', status: 200, response: '{}', mime: 'application/json', ts: '2026-09-17T08:00:01Z' },
      ]});
      await new Promise(r => setTimeout(r, 30));
      await vm.runInContext('loadHarvest()', sb);
      await vm.runInContext('aiChain = [{from:0,to:0,var:"v"}]; aiAsserts = new Map([["k",[]]]); corrResult = {groups:[]}; manualPrelude = new Map([["r1",true]]); chainResults = [{verdict:"FAIL", entry:{id:"r1"}, msg:"x"}]; document.getElementById("btnChainAiDiag").style.display = "";', sb);
      // pickIds 死勾选(v1.0.78): B 面板内存持旧勾选时, 用户任意 togglePick 会经
      // persistPickIds 把死集回写 storage —— onChanged 清空分支必须同清(与 manualPrelude 同款路径)。
      await vm.runInContext('pickMode = true; pickIds = new Set(["r1"]); document.getElementById("btnPick").textContent = "✓ 已选 1";', sb);
      onChangedHandler({ 'toolbox.harvest': { newValue: { v: 1, entries: [] } } }, 'local');
      assert(vm.runInContext('entries.length', sb) === 0, '2g. onChanged 清空分支 entries 清');
      assert(vm.runInContext('pickIds.size', sb) === 0, '2g2. onChanged 清空分支 pickIds 清(v1.0.78, 防死勾选回写)');
      assert(vm.runInContext('pickMode', sb) === true, '2g3. 勾选模式开关保留(UI 开关不随数据清空退出)');
      assert(vm.runInContext('document.getElementById("btnPick").textContent', sb).includes('已选 0'), '2g4. 勾选按钮计数归零');
      assert(vm.runInContext('corrResult === null', sb), '2h. onChanged 清空分支 corrResult 清');
      assert(vm.runInContext('aiChain === null', sb), '2i. onChanged 清空分支 aiChain 清(v1.0.27)');
      assert(vm.runInContext('aiAsserts === null', sb), '2j. onChanged 清空分支 aiAsserts 清(v1.0.27)');
      assert(vm.runInContext('manualPrelude.size === 0', sb), '2k. onChanged 清空分支 manualPrelude 清(v1.0.27 补)');
      assert(vm.runInContext('chainResults.length', sb) === 0, '2k2. onChanged 清空分支 chainResults 清(v1.0.30)');
      assert(elements.get('btnChainAiDiag').style.display === 'none', '2k3. onChanged 清空分支「调试失败」按钮隐藏(v1.0.30)');
      assert(elements.get('trimHint').style.display === 'none', '2l. onChanged 清空分支 trimHint 同步隐藏');
    }
  }
  // 场景 2d: 引擎裁剪推送(push 分支)的幽灵条目语义(v1.0.55, #148 方向④) ——
  // 引擎 trimToFit/上限淘汰裁掉最旧条目后, onChanged 快照比本地少。push-only 分支
  // 不删本地条目(保住选中态): 消失的条目以"幽灵"形态短窗残留, 数据完整可导出;
  // 用户下次 persistEntries 写回时引擎下一批 flush 重新裁掉 —— 自愈不累积。
  {
    const { sb, storageData, onChangedHandler } = makeSandbox();
    if (!onChangedHandler) { console.log('  [skip] onChanged handler 未捕获'); }
    else {
      storageData.set('toolbox.harvest', { v: 1, entries: [
        { id: 'g1', method: 'GET', url: 'https://app.b.com/old1', path: '/old1', query: '', headers: {}, body: '', status: 200, response: '{}', mime: 'application/json', ts: '2026-09-17T08:00:00Z' },
        { id: 'g2', method: 'GET', url: 'https://app.b.com/old2', path: '/old2', query: '', headers: {}, body: '', status: 200, response: '{}', mime: 'application/json', ts: '2026-09-17T08:00:01Z' },
        { id: 'g3', method: 'GET', url: 'https://app.b.com/new1', path: '/new1', query: '', headers: {}, body: '', status: 200, response: '{}', mime: 'application/json', ts: '2026-09-17T08:00:02Z' },
      ]});
      await new Promise(r => setTimeout(r, 30));
      await vm.runInContext('loadHarvest()', sb);
      vm.runInContext('select("g1")', sb);
      // 引擎侧裁掉 g1+g2, 只剩 g3 → onChanged push 推送
      onChangedHandler({ 'toolbox.harvest': { newValue: { v: 1, entries: [
        { id: 'g3', method: 'GET', url: 'https://app.b.com/new1', path: '/new1', query: '', headers: {}, body: '', status: 200, response: '{}', mime: 'application/json', ts: '2026-09-17T08:00:02Z' },
      ]}}}, 'local');
      await new Promise(r => setTimeout(r, 10));
      assert(vm.runInContext('entries.length', sb) === 3, '2p. 引擎裁剪推送后本地不删(幽灵条目短窗保留, 防选中态被引擎淘汰抖掉)');
      assert(vm.runInContext('selectedId', sb) === 'g1', '2q. 被裁条目的选中态不被推送抖掉(push-only 保选中)');
      assert(vm.runInContext('exportSet().length', sb) === 3, '2r. 幽灵条目数据完整(导出集照常含它)');
      // 自愈闭环: stub 的 onChanged 直调不落 storage(真实 Chrome 里 newValue 即新存储态),
      // 手动把 storage 同步成引擎真实态再 loadHarvest —— 模拟"重开面板"读回引擎侧数据。
      storageData.set('toolbox.harvest', { v: 1, entries: [
        { id: 'g3', method: 'GET', url: 'https://app.b.com/new1', path: '/new1', query: '', headers: {}, body: '', status: 200, response: '{}', mime: 'application/json', ts: '2026-09-17T08:00:02Z' },
      ]});
      await vm.runInContext('loadHarvest()', sb);
      assert(vm.runInContext('entries.length', sb) === 1, '2s. 重载后幽灵条目消失(loadHarvest 回归引擎真实态, 窗口自愈闭环)');
    }
  }
  // 场景 2c: lastChainDiff 快照键与"最近一次重放"同步(v1.0.29)
  // —— 全 OK 轮必须 remove 旧 DIFF 快照: 用户"修完了重放全绿"后 diffTriage 若仍能
  // 判定旧 DIFF, 就是"最近一次出问题的重放"语义(错)而非"最近一次重放"(对)。
  // vm 串联 sidepanel 后直调 runChainReplay: mock executeScript 全返回 200 一致 → 全 OK。
  {
    const { sb, elements, storageData } = makeSandbox();
    storageData.set('toolbox.harvest', { v: 1, entries: [
      { id: 'r1', method: 'GET', url: 'https://app.b.com/api', path: '/api', query: '', headers: {}, body: '', status: 200, response: '{"ok":1}', mime: 'application/json', ts: '2026-09-17T08:00:01Z' },
    ]});
    storageData.set('toolbox.lastChainDiff', [{ recorded: { id: 'old' }, live: { status: 200, text: 'x' } }]);
    await new Promise(r => setTimeout(r, 30));
    await vm.runInContext('loadHarvest()', sb);
    vm.runInContext('globalThis.confirm = () => true', sb);
    await vm.runInContext('runChainReplay()', sb);
    assert(vm.runInContext('chainResults.length', sb) === 0, '2m. 全一致重放 chainResults 空');
    assert(storageData.get('toolbox.lastChainDiff') === undefined, '2n. 全 OK 轮 remove 旧 DIFF 快照(v1.0.29: 快照键跟最近一次重放, 不跟最近一次坏重放)');
  }
  // 场景 3: aria 契约断言已迁至 test/check_aria.js(2026-09-17 v1.0.48 拆文件——trim_sync 回归
  // trim 行为职责, aria 面断言独立成文件); 此处留一条哨兵断言防"迁移后本文件结构被误删"。
  {
    const src = fs.readFileSync(ROOT + '/sidepanel/sidepanel.js', 'utf8');
    assert(src.includes('div.setAttribute("role", "button")'), '3a. 迁移哨兵: aria 断言主体已拆走(见 check_aria.js), 源码 aria 仍在');
  }
  // 场景 4: exportSet + trim 三态叠加组合边界(v1.0.62, #155 方向①) ——
  // 单态已有覆盖(1i 空勾选退回/trimNote 文案分支), 但 filter∩trim、pick∩trim 的
  // findIndex 行为零覆盖。这里端到端走真导出管线(btnSave.onclick → downloadText),
  // 用 JSONL 产物对账实际导出集(比断言中间变量强: 中间变量对了产物也可能错)。
  // 导出函数是匿名箭头(无函数名) → 只能 document.getElementById("btnSave").onclick() 触发。
  // downloadText 是 common.js 顶层 function 声明 → vm 加载脚本后重打一遍拦截(否则真走 Blob 炸)。
  {
    const { sb, elements, storageData } = makeSandbox();
    // stub 的 getElementById 懒创建缓存 → 导出函数读 checked 的元素先 getElementById 激活
    vm.runInContext('["fmtJsonl","fmtHar","fmtJmx","fmtPy","optTrim","optOnceOnly","optAutoRelogin","btnSave"].forEach(id => document.getElementById(id))', sb);
    const dl = [];
    vm.runInContext('downloadText = (n, d) => { __dl(n, d); }', sb);
    sb.__dl = (n, d) => dl.push({ n, d });
    // 业务 path 数据(过滤词 AND 语义: 'order' 命中 r3/r4/r5; r2 静态资源作"起点被滤"素材)
    storageData.set('toolbox.harvest', { v: 1, entries: [
      { id: 'r1', method: 'POST', url: 'https://app.b.com/api/login', path: '/api/login', query: '', headers: {}, body: '{}', status: 200, response: '{}', mime: 'application/json', ts: '2026-09-17T08:00:00Z' },
      { id: 'r2', method: 'GET', url: 'https://app.b.com/static/app.js', path: '/static/app.js', query: '', headers: {}, body: '', status: 200, response: '', mime: 'text/javascript', ts: '2026-09-17T08:00:01Z' },
      { id: 'r3', method: 'POST', url: 'https://app.b.com/order/create', path: '/order/create', query: '', headers: {}, body: '{}', status: 200, response: '{}', mime: 'application/json', ts: '2026-09-17T08:00:02Z' },
      { id: 'r4', method: 'POST', url: 'https://app.b.com/order/pay', path: '/order/pay', query: '', headers: {}, body: '{}', status: 200, response: '{}', mime: 'application/json', ts: '2026-09-17T08:00:03Z' },
      { id: 'r5', method: 'POST', url: 'https://app.b.com/order/list', path: '/order/list', query: '', headers: {}, body: '{}', status: 200, response: '{}', mime: 'application/json', ts: '2026-09-17T08:00:04Z' },
    ]});
    await new Promise(r => setTimeout(r, 30));
    await vm.runInContext('loadHarvest()', sb);
    const paths = () => dl[0].d.trim().split('\n').map((l) => JSON.parse(l).url.split('/').pop());
    const setup = (trimOn) => {
      elements.get('fmtJmx').checked = false; elements.get('fmtPy').checked = false;
      elements.get('fmtJsonl').checked = true; elements.get('fmtHar').checked = false;
      elements.get('optTrim').checked = trimOn !== false;
      elements.get('optOnceOnly').checked = false; elements.get('optAutoRelogin').checked = false;
    };
    const run = async () => { dl.length = 0; await vm.runInContext('document.getElementById("btnSave").onclick()', sb); };
    // 4a. filter∩trim: 可见={r3,r4,r5}, 起点 r3 在可见集 idx=0 → 不裁
    setup();
    vm.runInContext('setFilter(""); select("r3"); setFilter("order")', sb); await run();
    assert(paths().join(',') === 'create,pay,list', '4a. filter∩trim 起点 idx=0 不裁(3 条): ' + paths().join(','));
    // 4b. pick∩trim: 勾 {r1,r2,r3,r4}, 起点 r3 集内 idx=2 → 裁
    setup(); vm.runInContext('setFilter("")', sb);
    vm.runInContext('togglePickMode(); ["r1","r2","r3","r4"].forEach(id => togglePick(id)); select("r3")', sb); await run();
    assert(paths().join(',') === 'create,pay', '4b. pick∩trim 起点集内 idx>0 裁(2 条): ' + paths().join(','));
    // 4c. pick∩trim 起点不在勾选集: 勾 {r1,r2,r4,r5}, 起点 r3 → 不裁(与 trimNote 1e 语义对齐)
    setup(); vm.runInContext('pickIds.clear(); ["r1","r2","r4","r5"].forEach(id => pickIds.add(id)); select("r3")', sb); await run();
    assert(paths().join(',') === 'login,app.js,pay,list', '4c. pick∩trim 起点不在集 不裁(4 条): ' + paths().join(','));
    // 4d. filter∩pick: 勾 {r1,r5} + filter 'order' → 勾选优先, filter 不叠加
    setup(false); vm.runInContext('pickIds.clear(); pickIds.add("r1"); pickIds.add("r5"); setFilter("order")', sb); await run();
    assert(paths().join(',') === 'login,list', '4d. filter∩pick 勾选优先(filter 不改勾选集): ' + paths().join(','));
    // 4e. filter∩trim 起点被滤掉: select r2 + filter 'order' → findIndex=-1 不裁
    setup(); vm.runInContext('pickMode = false; pickIds.clear(); setFilter("")', sb);
    vm.runInContext('select("r2"); setFilter("order")', sb); await run();
    assert(paths().join(',') === 'create,pay,list', '4e. filter∩trim 起点被滤掉 findIndex=-1 不裁(3 条): ' + paths().join(','));
  }
  // 场景 5: AI 链注入回执端到端(v1.0.65, #159 方向①) —— runChainReplay 里
  // injector.report() 的 applied/missing 拼进 chainOut.innerHTML(receiptNote),
  // 此前只有静态源码断言(check_aic3 场景 9 锚"escHtml 在"), 行为级零验证:
  // 注入真的生效 + 回执串真的拼进汇总 + AI 产出(var 名)过 escHtml 转义。
  // vm 里走真 runChainReplay —— mock executeScript 须【按条目 URL 区分响应】:
  // injector.note 从 from 条目的 live 响应取 token, 全条目同 text 的 stub 里
  // r1 的 live 响应无 token → tok 链落 missing(首轮实测踩过)。r1 回带 token 的响应、
  // r2 回与录制一致 → tok applied + ghost 链 missing。
  {
    const { sb, elements, storageData } = makeSandbox();
    // makeSandbox 的 chromeStub 是共享单例 —— 本场景换按 URL 分流的 executeScript,
    // 跑完还原(不污染后续场景; 场景 6+ 若再跑重放会重建 sandbox, 还原是卫生习惯)。
    const origExec = sb.chrome.scripting.executeScript;
    sb.chrome.scripting.executeScript = async (cfg) => {
      const url = cfg.args[0];
      const text = url.endsWith('/login') ? '{"token": "T1"}' : '{"ok":1}';
      return [{ result: { status: 200, ok: true, text } }];
    };
    storageData.set('toolbox.harvest', { v: 1, entries: [
      { id: 'r1', method: 'POST', url: 'https://app.b.com/login', path: '/login', query: '', headers: {}, body: '{}', status: 200, response: '{"token": "T1"}', mime: 'application/json', ts: '2026-09-17T08:00:00Z' },
      { id: 'r2', method: 'POST', url: 'https://app.b.com/save', path: '/save', query: '', headers: {}, body: '{"token": "OLD"}', status: 200, response: '{"ok":1}', mime: 'application/json', ts: '2026-09-17T08:00:01Z' },
    ]});
    // 链 1: r1.token → r2.body.token(命中, applied); 链 2: fromId 指向不存在条目(missing)
    storageData.set('toolbox.aiChain', [
      { from: 0, fromId: 'r1', fromJsonPath: 'token', to: 1, toId: 'r2', toParam: 'body.token', var: 'tok', value: 'OLD' },
      { from: 2, fromId: 'ghost', fromJsonPath: 'token', to: 1, toId: 'r2', toParam: 'body.nothing', var: 'gVar', value: '' },
    ]);
    await new Promise(r => setTimeout(r, 30));
    await vm.runInContext('loadHarvest()', sb);
    vm.runInContext('globalThis.confirm = () => true', sb);
    await vm.runInContext('runChainReplay()', sb);
    const outHtml = elements.get('chainOut').innerHTML;
    assert(outHtml.includes('== AI 参数链 =='), '5a. 回执区标题拼进 chainOut 汇总: ' + outHtml.slice(0, 80));
    // applied/missing 串是 var → target 单行形态(sidepanel L1590/L1533), 逐行断防跨行误命中
    const receiptLines = outHtml.split('\n').filter((l) => l.includes('✅') || l.includes('⚠'));
    assert(receiptLines.some((l) => l.includes('✅') && l.includes('tok') && l.includes('body.token')),
      '5b. applied 回执行 = var → target(tok → body.token): ' + receiptLines.filter((l) => l.includes('✅')).join(' | '));
    assert(receiptLines.some((l) => l.includes('⚠') && l.includes('gVar')),
      '5c. missing 回执行带 var 名(gVar, 悬空链明示): ' + receiptLines.filter((l) => l.includes('⚠')).join(' | '));
    assert(outHtml.includes('== 链路重放汇总 =='), '5d. 汇总主体仍在(回执拼在汇总后不破坏)');
    sb.chrome.scripting.executeScript = origExec; // 还原 stub
  }
  // 场景 6: sidepanel btnSave 导出面 SSE mime 主信号(v1.0.65, #159 方向④) ——
  // filterSkippable 双源复测结论: 判定逻辑单源(common.js), 但 popup 导出面
  // (check_export_clean e4)锚的 SSE 条还是 headers 形态(旧兜底信号), sidepanel
  // 导出面对引擎真实条目形态(mime 主信号)零断言 —— 单源修复传导两侧的"sidepanel 侧
  // 真实可达"没有被回归证明。这里端到端走真 btnSave: mime=text/event-stream 条
  // 进 JMX 净化集(剔除), JSONL 保真全量。
  {
    const { sb, elements, storageData } = makeSandbox();
    vm.runInContext('["fmtJsonl","fmtHar","fmtJmx","fmtPy","optTrim","optOnceOnly","optAutoRelogin","btnSave"].forEach(id => document.getElementById(id))', sb);
    elements.get('fmtJmx').checked = true; elements.get('fmtPy').checked = false;
    elements.get('fmtJsonl').checked = true; elements.get('fmtHar').checked = false;
    elements.get('optTrim').checked = false; elements.get('optOnceOnly').checked = false; elements.get('optAutoRelogin').checked = false;
    // s1: 引擎真实条目形态 —— 请求头表只有 Accept, SSE 信号在响应 mime(CDP responseReceived)
    storageData.set('toolbox.harvest', { v: 1, entries: [
      { id: 's1', method: 'GET', url: 'https://app.b.com/sse/stream', path: '/sse/stream', query: '', headers: { Accept: 'text/event-stream' }, body: '', status: 200, response: '', mime: 'text/event-stream', ts: '2026-09-17T08:00:00Z' },
      { id: 's2', method: 'POST', url: 'https://app.b.com/order/create', path: '/order/create', query: '', headers: {}, body: '{}', status: 200, response: '{}', mime: 'application/json', ts: '2026-09-17T08:00:01Z' },
    ]});
    const dl = [];
    sb.__dl = (n, d) => dl.push({ n, d });
    vm.runInContext('downloadText = (n, d) => { __dl(n, d); }', sb);
    await new Promise(r => setTimeout(r, 30));
    await vm.runInContext('loadHarvest()', sb);
    await vm.runInContext('document.getElementById("btnSave").onclick()', sb);
    const jmxF = dl.find((f) => f.n.endsWith('.jmx'));
    const jf = dl.find((f) => f.n.endsWith('.jsonl'));
    assert(jmxF && !jmxF.d.includes('/sse/stream') && jmxF.d.includes('/order/create'),
      '6a. btnSave JMX 剔除 mime 主信号 SSE 条(引擎真实形态, 非 headers 兜底)');
    assert(jf && jf.d.includes('/sse/stream') && jf.d.trim().split('\n').length === 2,
      '6b. JSONL 保真全量 2 条(SSE 条不丢)');
    assert((elements.get('expMsg').textContent || '').includes('剔除 1 条'),
      '6c. 剔除数透明提示(dropped 不静默): ' + elements.get('expMsg').textContent.split('\n')[0]);
    // 6d. 同批导出多格式时间戳一致性(v1.0.71, #165 方向④): btnSave 单次循环里 jsonl/har
    //     都用 `harvest_${stamp()}` 前缀 —— stamp 精度到秒, 同一次点击两格式若跨秒生成,
    //     文件名时间戳会差 1(下载目录里两文件像"不同批次"不可配对归档)。同批应一致。
    //     场景 6 本身只勾了 jsonl+jmx —— 补勾 har 再跑一次导出, 断言 jsonl/har 时间戳一致。
    elements.get('fmtHar').checked = true;
    dl.length = 0;
    await vm.runInContext('document.getElementById("btnSave").onclick()', sb);
    const names2 = dl.map((f) => f.n);
    const nj = names2.find((n) => n.endsWith('.jsonl')) || '';
    const nh = names2.find((n) => n.endsWith('.har')) || '';
    const mj = nj.match(/^harvest_(\d{14})\.jsonl$/);
    assert(mj && nh === `harvest_${mj[1]}.har`,
      '6d. 同批 jsonl/har 时间戳一致(跨批可配对归档): ' + nj + ' / ' + nh);
  }
  console.log('');
  console.log('=== trimHint 清空同步 PASS ===');
})();
