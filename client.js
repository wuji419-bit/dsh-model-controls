window.__ModuleLoader__.load({id:'dsh-model-controls',factory:(require)=>{
 const React=require('react'),h=React.createElement;
 async function rpc(op,sessionId,model,fast){const method='model-speed.'+op;const r=await fetch('/api/'+method,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:crypto.randomUUID(),method,payload:{args:{sessionId,model,...(fast===undefined?{}:{fast})}}})});const b=await r.json();if(!b.result?.ok)throw new Error(b.result?.error?.message??'速度设置失败');return b.result.value;}
 function Controls({directory,sessionId}){
  const state=React.useSyncExternalStore(directory.store.subscribe,directory.store.getSnapshot,directory.store.getSnapshot);
  const [speed,setSpeed]=React.useState(null),[busy,setBusy]=React.useState(false),[error,setError]=React.useState('');
  const current=state.current;const model=current?.model;const enabled=current?.provider==='sub2api'&&/^gpt-/i.test(model??'')&&!/image/i.test(model??'');
  React.useEffect(()=>{let live=true;setSpeed(null);setError('');if(enabled)rpc('get',sessionId,model).then(v=>{if(live)setSpeed(v.fast);},e=>{if(live)setError(e.message);});return()=>{live=false;};},[sessionId,model,enabled]);
  React.useEffect(()=>{directory.load().catch(e=>setError(e.message));},[directory]);
  if(!enabled)return null;
  async function toggle(){if(busy||speed===null)return;setBusy(true);setError('');try{const v=await rpc('set',sessionId,model,!speed);setSpeed(v.fast);}catch(e){setError(e.message);}finally{setBusy(false);}}
  return h('span',{'data-model-controls':'',style:{display:'inline-flex',gap:6,alignItems:'center'}},h('button',{type:'button',onClick:toggle,disabled:busy||speed===null,'aria-pressed':speed===true,'aria-label':speed?'快速模式已开启，切换为标准':'标准模式，开启快速模式',title:'切换当前模型服务的速度；模型和推理等级不变。快速模式可能增加用量。',style:{font:'inherit',fontSize:12,border:'1px solid var(--dsw-alias-border-l2)',borderRadius:8,padding:'2px 8px',background:'transparent',color:'inherit'}},busy?'切换中…':speed?'⚡ 快速':'⚡ 标准'),error?h('span',{role:'alert',style:{fontSize:12,color:'#c53030'}},error):null);
 }
 function Seat(props){return props.directory?h(Controls,props):null;}
 return {inject:['slots','modelDirectories','sessions','remote','remote.session'],apply(ctx){ctx.slots.inject('conversation.input.right',()=>ctx.slots.register({name:'conversation.input.right',id:'model-controls-api-speed',order:10,inject:sessionId=>({sessionId,directory:ctx.sessions.subagentAddress(sessionId)===undefined?ctx.modelDirectories.directoryFor(sessionId):undefined})},Seat));}};
}});
