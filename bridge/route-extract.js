(function(){
  var el=document.querySelector("#app");
  var vm=el.__vue__ || (el.firstElementChild && el.firstElementChild.__vue__);
  if(!vm||!vm.$router) return JSON.stringify({error:"no-router"});
  var routes=(vm.$router.options&&vm.$router.options.routes)||[];
  var flat=[];
  function walk(arr,prefix){
    prefix=prefix||"";
    for(var i=0;i<arr.length;i++){
      var r=arr[i];
      var p=(prefix+"/"+(r.path||"")).replace(/\/+/g,"/");
      var leaf={path:p,name:r.name||"",title:(r.meta&&(r.meta.title||r.meta.name))||""};
      if(r.children&&r.children.length){ walk(r.children,p); }
      else { flat.push(leaf); }
    }
  }
  walk(routes,"");
  return JSON.stringify(flat);
})()
