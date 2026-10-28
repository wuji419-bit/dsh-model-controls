import {readFileSync,writeFileSync,renameSync,mkdirSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {buildProfiles,ModelControlsAdapter} from './runtime-v2.js';
import {hostImport} from './host-import.js';
const yaml=await hostImport('yaml');
export const name='model-controls';
export const inject=['llm','credentials','connection'];
export function mergedProfiles(source,catalog) {
 const legacy=buildProfiles(source,catalog);const p=legacy.get('model-controls-api');
 const models=p.piProvider.getModels().map(m=>({...m,provider:'sub2api'}));
 return new Map([['sub2api',{...p,displayName:source.displayName??'Configured provider',piProvider:{...p.piProvider,id:'sub2api',name:'Configured provider',getModels:()=>models}}]]);
}
export class MergedAdapter extends ModelControlsAdapter {
 constructor(config,speed){super(config);this.speed=speed;}
 streamWithSnapshot(options,snapshot){
  const fast=!!this.speed(options.sessionId,options.model);
  const profiles=new Map(snapshot.profiles);profiles.set('sub2api',{...profiles.get('sub2api'),fast});
  return super.streamWithSnapshot(options,{...snapshot,profiles});
 }
}
// This version-pinned decorator touches only the original adapter's sub2api GPT
// calls. All original models, registration ownership, credentials and endpoints
// remain with llm-pi-ai. Disposal restores exactly the previous methods.
export function decorateOriginal(original,enhanced){
 const saved=new Map();const patches={
  modelInfo(snapshot,provider,model){if(provider==='sub2api' && enhanced.current().profiles.get('sub2api').entries.has(model))return enhanced.modelInfo(enhanced.current(),provider,model);return saved.get('modelInfo').call(this,snapshot,provider,model);},
  prepareCall(provider,model,signal){if(provider==='sub2api' && enhanced.current().profiles.get('sub2api').entries.has(model))return enhanced.prepareCall(provider,model,signal);return saved.get('prepareCall').call(this,provider,model,signal);},
  streamWithSnapshot(options,snapshot){if(options.provider==='sub2api' && enhanced.current().profiles.get('sub2api').entries.has(options.model))return enhanced.stream(options);return saved.get('streamWithSnapshot').call(this,options,snapshot);}
 };
 for(const [key,value] of Object.entries(patches)){if(typeof original[key]!=='function')throw new Error('Unsupported DSH adapter contract: '+key);saved.set(key,original[key]);original[key]=value;}
 return ()=>{for(const [key,value]of saved)if(original[key]===patches[key])original[key]=value;};
}
export function apply(ctx){
 const home=process.env.DSH_HOME||join(homedir(),'.dsh');const profilePath=join(home,'profiles/desktop/cordis.patch.yml');const catalogPath=join(homedir(),'.codex/cc-switch-model-catalog.json');
 const speedPath=join(home,'plugins/model-controls/session-speed.json');
 let speed={};try{speed=JSON.parse(readFileSync(speedPath,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
 let fingerprint,profiles;
 const load=()=>{const raw=readFileSync(profilePath,'utf8'),cat=readFileSync(catalogPath,'utf8');if(fingerprint!==raw+'\0'+cat){const source=yaml.parse(raw).find(e=>e.id==='llm-pi-ai')?.config?.providers?.sub2api;const next=mergedProfiles(source,JSON.parse(cat));profiles=next;fingerprint=raw+'\0'+cat;}return profiles;};
 const fast=(sessionId,model)=>speed[String(sessionId)]===true && load().get('sub2api').entries.get(model)?.fast===true;
 const enhanced=new MergedAdapter({profiles:load,resolveApiKey:async(_p,p)=>{const hit=await ctx.credentials.resolve(p.apiKeyEnv);if(!hit?.value)throw new Error('Original Configured provider API credential unavailable');return hit.value;},resolveAttachments:()=>ctx.get('attachments'),resolveImageAccess:async(...args)=>{const llm=await hostImport('@deepseek-ai/dsh-llm');return llm.resolveImageAttachmentAccess(args[0],path=>ctx.get('fs')?.processPathFromHostPath(path),args[1]);}},fast);
 let attached,restore;
 const attach=()=>{const original=ctx.llm.adapters?.get('sub2api')?.adapter;if(!original)throw new Error('Original Configured provider adapter not registered');if(original===attached)return;restore?.();restore=decorateOriginal(original,enhanced);attached=original;};
 attach();ctx.effect(()=>()=>restore?.());ctx.on('llm/adapters-updated',()=>attach());
 for(const op of ['get','set'])ctx.connection.fetch.register({path:'/api/model-speed.'+op,methods:['POST'],requestBody:'buffered',fetch:async request=>{
  let envelope;try{envelope=await request.json();if(envelope.type!=='client-request'||envelope.method!=='model-speed.'+op||typeof envelope.rpcId!=='string')throw new Error('Invalid request envelope');const p=envelope.payload?.args??envelope.payload;if(typeof p.sessionId!=='string'||p.sessionId.length>256||!p.sessionId)throw new Error('Invalid session');const entry=load().get('sub2api').entries.get(p.model);if(!entry?.fast)throw new Error('Current Configured provider model does not advertise Fast');if(op==='set'){if(typeof p.fast!=='boolean')throw new Error('Invalid fast choice');const next={...speed};if(p.fast)next[p.sessionId]=true;else delete next[p.sessionId];mkdirSync(join(home,'plugins/model-controls'),{recursive:true});writeFileSync(speedPath+'.tmp',JSON.stringify(next),{mode:0o600});renameSync(speedPath+'.tmp',speedPath);speed=next;}return Response.json({type:'server-response',rpcId:envelope.rpcId,result:{ok:true,value:{fast:fast(p.sessionId,p.model)}}});}
  catch(e){return Response.json({type:'server-response',rpcId:envelope?.rpcId??'invalid-request',result:{ok:false,error:{code:'model-speed/error',message:e.message}}});}
 }});
 ctx.llm.emitAdaptersUpdated();
}
