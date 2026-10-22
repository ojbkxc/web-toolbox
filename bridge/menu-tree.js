(function(){
  var el=document.querySelector("#app");
  var vm=el.__vue__ || (el.firstElementChild && el.firstElementChild.__vue__);
  var pm=vm.$store.state.permission.permissionMenus;
  function walk(arr,prefix){
    var out=[];
    for(var i=0;i<arr.length;i++){
      var r=arr[i];
      var p=(prefix+"/"+(r.path||"")).replace(/\/+/g,"/");
      var node={path:p,name:r.name||"",title:(r.meta&&(r.meta.title||r.meta.name))||"",hidden:!!r.hidden};
      if(r.children&&r.children.length) node.children=walk(r.children,p);
      else node.leaf=true;
      out.push(node);
    }
    return out;
  }
  return JSON.stringify(walk(pm,""));
})()
