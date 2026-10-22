(function(){
  // 菜单数据源: Vuex store 里的 resources/navTabs 比 DOM 更可靠
  var el=document.querySelector("#app");
  var vm=el.__vue__ || (el.firstElementChild && el.firstElementChild.__vue__);
  var st=vm.$store.state;
  function pick(o,keys){ for(var i=0;i<keys.length;i++){ if(o&&o[keys[i]]!=null) return o[keys[i]]; } return null; }
  var res = pick(st,["resources","navTabs","permission"]);
  var out = {};
  out.resourceKeys = res && typeof res==="object" ? Object.keys(res).slice(0,15) : String(res).slice(0,80);
  // 尝试菜单树
  var menu = null;
  try { menu = st.resources.menuTrees || st.resources.menu || st.resources.routes; } catch(e){}
  out.menuType = menu ? (Array.isArray(menu)?"array":typeof menu) : "none";
  return JSON.stringify(out);
})()
