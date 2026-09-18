// CDP 对象 body({text}|{params})在各下游环节的归一化行为:
//   录制入口 normalizeEntry 已统一转字符串, 但旧数据/直调路径仍可能喂对象 ——
//   aiSanitize/scrubLong/diffJsonBodies/escHtml/applyDynamics 每个环节都要能自处,
//   且行为须与字符串 body 对照一致(对照场景来自原 check_ai_body2)。
const fs=require('fs'); const vm=require('vm'); const path=require('path');
const ROOT = require('path').resolve(__dirname, '..');
const html=fs.readFileSync(ROOT + '/sidepanel/sidepanel.html','utf8');
const all=[...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m=>m[1]).map(p=>path.resolve(ROOT + '/sidepanel',p));
const elements=new Map();
const mkEl=(id)=>{if(elements.has(id))return elements.get(id);const el={id,style:{},dataset:{},children:[],value:'',textContent:'',innerHTML:'',className:'',checked:true,disabled:false,classList:{add(){},remove(){},toggle(){},contains(){return false}},addEventListener(){},setAttribute(k,v){this[k==="aria-label"?"ariaLabel":k]=v;},appendChild(){},insertBefore(){},querySelector(){return mkEl(id+'_q')},querySelectorAll(){return[]},scrollIntoView(){},onclick:null};elements.set(id,el);return el;};
const documentObj={getElementById:(id)=>mkEl(id),createElement:()=>mkEl('a'+Math.random()),createDocumentFragment:()=>mkEl('f'),querySelectorAll:()=>[],body:mkEl('body')};
const storageData=new Map(); const changeListeners=[];
const chromeStub={storage:{local:{QUOTA_BYTES:10485760,
  get:(keys,cb)=>{const r={};for(const k of [].concat(keys))r[k]=storageData.get(k);const p=Promise.resolve(r);if(typeof cb==='function')setTimeout(()=>cb(r),0);return p;},
  set:(obj,cb)=>{for(const k of Object.keys(obj))storageData.set(k,obj[k]);const p=Promise.resolve();setTimeout(()=>cb&&cb(),0);return p;},
  remove:(keys,cb)=>{for(const k of [].concat(keys))storageData.delete(k);const p=Promise.resolve();setTimeout(()=>cb&&cb(),0);return p;}},
  onChanged:{addListener(L){changeListeners.push(L);}}},
  runtime:{sendMessage:async()=>({ok:true,recState:'idle',count:0,pending:0,attachedTabs:0,domains:[],unmatched:[],harvestCorrupt:false}),openOptionsPage(){}},
  tabs:{query:async()=>[{id:1,url:'https://a.b.com/x'}]},scripting:{executeScript:async()=>[{result:{status:200,ok:true,text:'{}'}}]},
  sidePanel:{},permissions:{contains:async()=>false,request:async()=>true}};
const sandbox={console,setTimeout,setInterval:()=>0,clearInterval(){},URL,URLSearchParams,fetch:async()=>{throw new Error('nf')},
  navigator:{clipboard:{writeText:async()=>{}}},document:documentObj,chrome:chromeStub,performance:{now:()=>Date.now()}};
sandbox.window=sandbox;sandbox.globalThis=sandbox;vm.createContext(sandbox);
for(const f of all) new vm.Script(fs.readFileSync(f,'utf8'),{filename:f}).runInContext(sandbox);

let pass=0, fail=0;
const ok=(cond,msg)=>{if(cond){pass++;console.log('  OK '+msg);}else{fail++;console.log('  ✗ FAIL '+msg);}};

// 对象 body({text}) vs 字符串 body —— 真实链路级验证:
// 读取层 loadHarvestEntries/normalizeEntry 负责归一化(对象→字符串), AI 层不重复做;
// 断言分两层: a) 直喂对象时 AI 层降级为 [object Object](记录现状, 不炸);
//            b) 经 normalizeEntry 后(真实链路形态)与字符串条目产出一致。
const mk=(body)=>({id:'r1',method:'POST',url:'https://a.b.com/api/x',path:'/api/x',query:'',headers:{},body,status:200,mime:'',response:'{}',ts:''});
sandbox.__obj=mk({text:'{"a":1}'});
sandbox.__str=mk('{"a":1}');
sandbox.__objN=mk(JSON.parse('{"a":1}') && '{"a":1}');
// normalizeEntry 在 sandbox 里可用(common.js)
sandbox.__objN.body={text:'{"a":1}'};
vm.runInContext('__objN = normalizeEntry(__objN)',sandbox);

const r1o=vm.runInContext('aiSanitizeEntry(__obj)',sandbox);
const r1s=vm.runInContext('aiSanitizeEntry(__str)',sandbox);
const r1n=vm.runInContext('aiSanitizeEntry(__objN)',sandbox);
ok(r1o.body==='[object Object]','aiSanitizeEntry 直喂对象: 降级 [object Object] 不炸(记录现状)');
ok(r1n.body===r1s.body,'aiSanitizeEntry 经 normalizeEntry: 与字符串条目产出一致 ('+JSON.stringify(r1n.body)+')');

const r2o=vm.runInContext('scrubLong(__obj.body)',sandbox);
const r2s=vm.runInContext('scrubLong(__str.body)',sandbox);
ok(r2o!==r2s,'scrubLong 直喂对象: 产出可区分(AI 层不做对象归一化, 分层如此)');

const r3o=vm.runInContext('diffJsonBodies([__obj.body, __str.body])',sandbox);
ok(r3o===null || JSON.stringify(r3o)==='[]','diffJsonBodies: 对象 vs 字符串同值 → 无差异 ('+JSON.stringify(r3o)+')');

// applyDynamics: v1.0.6 加了对象兜底(对象 .text 归一化后再替换) —— 不再静默无效
const r6=vm.runInContext('applyDynamics(__obj.body, [{path:"a",values:["1","2"],replace:"${V}"}])',sandbox);
ok(r6==='{"a": "${V}"}','applyDynamics: 对象 body 经兜底归一化后正确替换 ('+JSON.stringify(r6)+')');

// 空串动态值(v1.0.69, #162 方向④): 同一字段一次录制有时间戳、一次是空串(可选字段)时,
// d.values 含 ''。三个替换分支对空串全部退化:
//   JSON: inner='' 让正则变 0 宽(`"ts"\s*:\s*("|)\1`)→ 对前一轮替换结果再叠一次 → body 损坏不可 parse;
//   表单/query: split(leaf+'=') 分隔符退化 → 'ts=&x=' 整体被换 + 'counts='(含 'ts=' 子串)误伤。
// 修复 = v==='' 跳过该值(空字段保持空是正确语义, 替换成 ${__time()} 反而错);
// 纯空格值 split('ts=   ') 无退化、超长数字无特殊字符 —— 均安全无需处理。
const r7=vm.runInContext('applyDynamics(\'{"ts":1730000000000,"x":1}\', [{path:"ts",values:["1730000000000",""],replace:"${__time()}"}])',sandbox);
ok(r7==='{"ts": "${__time()}","x":1}','applyDynamics: 空串值不叠加替换(JSON 不损坏): '+JSON.stringify(r7));
try{JSON.parse(r7);ok(true,'修复后 body 仍可 JSON.parse');}catch(e){ok(false,'修复后 body 仍可 JSON.parse: '+e.message);}
const r8=vm.runInContext('applyDynamics(\'ts=1730000000000&x=1\', [{path:"ts",values:["1730000000000",""],replace:"${__time()}"}])',sandbox);
ok(r8==='ts=${__time()}&x=1','applyDynamics 表单: 空串值不误伤(不翻倍): '+JSON.stringify(r8));
const r9=vm.runInContext('applyDynamicsToQuery("?ts=1730000000000&counts=5", [{path:"Q_ts",values:["1730000000000",""],replace:"${__time()}"}])',sandbox);
ok(r9==='?ts=${__time()}&counts=5','applyDynamicsToQuery: 空串值不误伤 counts(含 ts= 子串): '+JSON.stringify(r9));
const r10=vm.runInContext('applyDynamics(\'{"ts":"","x":2}\', [{path:"ts",values:["1730000000000",""],replace:"${__time()}"}])',sandbox);
ok(r10==='{"ts":"","x":2}','applyDynamics: 空串字段保持空语义(不被 ${__time()} 替换): '+JSON.stringify(r10));

// escHtml: 对象走 String() → [object Object](展示层降级但不炸)
const r5=vm.runInContext('escHtml(__obj.body)',sandbox);
ok(r5==='[object Object]','escHtml: 对象降级为 [object Object] 不炸');

console.log(fail?`\n=== CDP 对象 body 走查 FAIL: ${fail} ===`:`\n=== CDP 对象 body 走查 PASS ===`);
process.exit(fail?1:0);
