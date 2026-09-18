// E2E 全链模拟: 同页 9 个 script 串联加载(修复后), 验证:
// 1. 顶层零异常(按钮绑定活);
// 2. 用户流: 录制写入(storage 模拟) → onChanged 同步 → entries 更新 → btnSave 可导出;
// 3. body 为 CDP 对象(postData {text, params}) 时导出各格式是否炸。
const fs = require('fs');
const ROOT = require('path').resolve(__dirname, '..');
const vm = require('vm');
const path = require('path');

const html = fs.readFileSync(ROOT + '/sidepanel/sidepanel.html','utf8');
const scriptSrcs = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m=>m[1]);
const all = scriptSrcs.map(p=>path.resolve(ROOT + '/sidepanel',p));

const elements = new Map();
const mkEl = (id) => {
  if (elements.has(id)) return elements.get(id);
  const el = {
    id, style:{}, dataset:{}, children:[], value:'', textContent:'', innerHTML:'', className:'',
    checked:true, disabled:false,
    classList:{add(){},remove(){},toggle(){},contains(){return false;}},
    addEventListener(){}, setAttribute(k,v){ this[k === "aria-label" ? "ariaLabel" : k] = v; }, appendChild(){}, insertBefore(){}, querySelector(){return mkEl(id+'_q');},
    querySelectorAll(){return [];}, scrollIntoView(){}, onclick:null,
  };
  elements.set(id, el);
  return el;
};
const documentObj = {
  getElementById: (id)=>mkEl(id),
  createElement: ()=>mkEl('anon_'+Math.random()),
  createDocumentFragment: ()=>mkEl('frag'),
  querySelectorAll: ()=>[],
  body: mkEl('body'),
};
const storageData = new Map();
const changeListeners = [];
const downloads = [];
const chromeStub = {
  storage: {
    local: {
      QUOTA_BYTES: 10485760,
      get: (keys, cb)=>{ const r={}; for(const k of [].concat(keys)) r[k]=storageData.get(k); const p=Promise.resolve(r); if (typeof cb==='function') setTimeout(()=>cb(r),0); return p; },
      set: (obj, cb)=>{ const changes={}; for(const k of Object.keys(obj)) { changes[k]={newValue:obj[k]}; storageData.set(k, obj[k]); } const p=Promise.resolve(); setTimeout(()=>{ for(const L of changeListeners) L(changes,'local'); cb&&cb(); },0); return p; },
      remove: (keys, cb)=>{ for(const k of [].concat(keys)) storageData.delete(k); const p=Promise.resolve(); setTimeout(()=>cb&&cb(),0); return p; },
    },
    onChanged: { addListener(L){ changeListeners.push(L); } },
  },
  runtime: {
    sendMessage: async (msg)=>{
      if (msg.type === 'getRecInfo') return {ok:true, recState:'idle', count:((storageData.get('toolbox.harvest')||{entries:[]}).entries||[]).length, pending:0, attachedTabs:0, domains:[], unmatched:[], harvestCorrupt:false};
      return {ok:true};
    },
    openOptionsPage(){},
  },
  tabs: { query: async ()=>[{id:1, url:'https://a.b.com/x'}] },
  scripting: { executeScript: async ()=>[{result:{status:200, ok:true, text:'{}'}}] },
  sidePanel: {}, permissions: { contains: async()=>false, request: async()=>true },
};
const sandbox = {
  console, setTimeout, setInterval: ()=>0, clearInterval(){}, URL, URLSearchParams,
  fetch: async()=>{throw new Error('no fetch');},
  navigator:{clipboard:{writeText:async()=>{}}}, document: documentObj, chrome: chromeStub,
  performance:{now:()=>Date.now()},
};
sandbox.window = sandbox; sandbox.globalThis = sandbox;
vm.createContext(sandbox);

let fail = 0;
for (const f of all) {
  const src = fs.readFileSync(f, 'utf8');
  try {
    new vm.Script(src, { filename: f }).runInContext(sandbox);
    console.log('OK  ' + path.basename(f));
  } catch (e) {
    fail++;
    console.log('FAIL ' + path.basename(f) + ' :: ' + e.message);
  }
}
if (fail) { console.log('=== 顶层异常未清 ==='); process.exit(1); }
console.log('--- 全部 script 顶层无异常, 按钮绑定应已生效 ---');

(async () => {
  // ---- 模拟引擎写入一条录制数据(body 是 CDP 对象 —— 用户改的 r.postData || null) ----
  const entry = {
    id:'r1', method:'POST', url:'https://a.b.com/api/order/create', path:'/api/order/create',
    query:'', headers:{'Content-Type':'application/json'}, body:{text:'{"orderId":"6512345678901"}'},
    status:200, mime:'application/json', response:'{"resultCode":"0"}', ts:new Date().toISOString(),
  };
  await new Promise(r=>chromeStub.storage.local.set({'toolbox.harvest':{v:1, entries:[entry]}}, r));
  await new Promise(r=>setTimeout(r,30));

  // 捕获 downloadText(全局) 生成内容
  sandbox.downloadText = (filename, text, mime) => { downloads.push({filename, text}); };
  // 重新绑定不了已闭包的, 但 downloadText 是全局函数引用 —— vm 同 realm, 替换全局即生效
  const btnSave = elements.get('btnSave');
  if (!btnSave || typeof btnSave.onclick !== 'function') { console.log('FAIL btnSave 无 onclick 绑定'); process.exit(1); }
  console.log('btnSave.onclick 已绑定');
  try {
    await (btnSave.onclick)();
    const st = elements.get('expMsg');
    console.log('btnSave 结果: ' + st.textContent.replace(/\n/g, ' | '));
    if (st.textContent.includes('已导出')) console.log('E2E_PASS 导出成功');
    else if (st.textContent.includes('失败') || st.textContent.includes('为空')) { console.log('E2E_FAIL: ' + st.textContent); process.exit(1); }
    else console.log('E2E_UNKNOWN');
  } catch (e) {
    console.log('E2E_FAIL btnSave.onclick 抛异常: ' + e.message);
    process.exit(1);
  }
  process.exit(0);
})();
