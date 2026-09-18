// 验证链路重放 runChain 传 CDP 对象 body 到页面 fetch 的结果
const fs=require('fs'); const vm=require('vm'); const path=require('path');
const ROOT = require('path').resolve(__dirname, '..');
const html=fs.readFileSync(ROOT + '/sidepanel/sidepanel.html','utf8');
const all=[...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m=>m[1]).map(p=>path.resolve(ROOT + '/sidepanel',p));
const elements=new Map();
const mkEl=(id)=>{if(elements.has(id))return elements.get(id);const el={id,style:{},dataset:{},children:[],value:'',textContent:'',innerHTML:'',className:'',checked:true,disabled:false,classList:{add(){},remove(){},toggle(){},contains(){return false}},addEventListener(){},setAttribute(k,v){this[k==="aria-label"?"ariaLabel":k]=v;},appendChild(){},insertBefore(){},querySelector(){return mkEl(id+'_q')},querySelectorAll(){return[]},scrollIntoView(){},onclick:null};elements.set(id,el);return el;};
const documentObj={getElementById:(id)=>mkEl(id),createElement:()=>mkEl('a'+Math.random()),createDocumentFragment:()=>mkEl('f'),querySelectorAll:()=>[],body:mkEl('body')};
const storageData=new Map(); const changeListeners=[];
let lastExecArgs=null;
const chromeStub={storage:{local:{QUOTA_BYTES:10485760,
  get:(keys,cb)=>{const r={};for(const k of [].concat(keys))r[k]=storageData.get(k);const p=Promise.resolve(r);if(typeof cb==='function')setTimeout(()=>cb(r),0);return p;},
  set:(obj,cb)=>{for(const k of Object.keys(obj))storageData.set(k,obj[k]);const p=Promise.resolve();setTimeout(()=>cb&&cb(),0);return p;},
  remove:(keys,cb)=>{for(const k of [].concat(keys))storageData.delete(k);const p=Promise.resolve();setTimeout(()=>cb&&cb(),0);return p;}},
  onChanged:{addListener(L){changeListeners.push(L);}}},
  runtime:{sendMessage:async()=>({ok:true,recState:'idle',count:0,pending:0,attachedTabs:0,domains:[],unmatched:[],harvestCorrupt:false}),openOptionsPage(){}},
  tabs:{query:async()=>[{id:1,url:'https://a.b.com/x'}]},
  scripting:{executeScript:async(o)=>{lastExecArgs=o;return [{result:{status:200,ok:true,text:'{}'}}];}},
  sidePanel:{},permissions:{contains:async()=>false,request:async()=>true}};
const sandbox={console,setTimeout,setInterval:()=>0,clearInterval(){},URL,URLSearchParams,fetch:async()=>{throw new Error('nf')},
  navigator:{clipboard:{writeText:async()=>{}}},document:documentObj,chrome:chromeStub,performance:{now:()=>Date.now()}};
sandbox.window=sandbox;sandbox.globalThis=sandbox;vm.createContext(sandbox);
for(const f of all) new vm.Script(fs.readFileSync(f,'utf8'),{filename:f}).runInContext(sandbox);
const cd={id:'r1',method:'POST',url:'https://a.b.com/api/x',path:'/api/x',query:'',headers:{},body:{text:'{"a":1}'},status:200,mime:'',response:'{}',ts:''};
sandbox.__e=cd;
(async()=>{
  const run=vm.runInContext('runChain([__e], 1, {onProgress(){}})',sandbox);
  const results=await run.run();
  console.log('runChain executeScript args[3](body) =', JSON.stringify(lastExecArgs.args[3]));
  console.log('runChain verdict =', JSON.stringify(results.map(r=>({verdict:r.verdict,msg:r.msg}))));
})();
