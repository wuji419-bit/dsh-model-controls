import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { hostImport } from './host-import.js';
import { capabilities, ROUTES, NATIVE_LEVELS, validateSelection, transformPayload } from './catalog.js';
const [{ PiAiAdapter }, llm, responses, yaml] = await Promise.all([
  hostImport('@deepseek-ai/dsh-llm-pi-ai'), hostImport('@deepseek-ai/dsh-llm'),
  hostImport('@earendil-works/pi-ai/api/openai-responses'), hostImport('yaml')
]);
export const name = 'model-controls';
export const inject = ['llm', 'credentials'];
const ZERO_COST = {input:0,output:0,cacheRead:0,cacheWrite:0};
// Profiles are isolated: never replace sub2api, mutate the host adapter, or copy keys.
export function buildProfiles(source, catalog) {
  if (source.api !== 'openai-responses') throw new Error('enhanced routes require openai-responses');
  const url = new URL(source.baseURL);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1','localhost','[::1]'].includes(url.hostname))) throw new Error('endpoint must use HTTPS (except localhost tests)');
  const entries = capabilities(catalog, source);
  const profiles = new Map();
  for (const route of ROUTES) {
    const fast = route.endsWith('-fast');
    const selected = entries.filter(e => !fast || e.fast);
    if (!selected.length) continue;
    const models = selected.map(e => {
      const map = Object.fromEntries(NATIVE_LEVELS.map(l => [l, e.levels.some(v => v.id === l) ? l : null]));
      // Ultra is privately transported via max only inside this call. The final
      // onPayload hook restores the exact original effort, never remaps user Max.
      if (e.levels.some(l => l.id === 'ultra')) map.max = 'max';
      return {id:e.id,name:e.name,api:'openai-responses',provider:route,baseUrl:source.baseURL,
        reasoning:e.levels.length > 0,thinkingLevelMap:map,input:e.input,cost:{...ZERO_COST},contextWindow:e.contextWindow,maxTokens:e.maxTokens};
    });
    profiles.set(route, {
      displayName:fast ? 'Configured provider · GPT ⚡ Fast' : 'Configured provider · GPT 全推理',
      apiKeyEnv:source.apiKeyEnv, headers:{...source.headers}, transport:'sse',
      streamIdleTimeoutMs:source.streamIdleTimeoutMs ?? 300000,
      maxRequestImageBytes:source.maxRequestImageBytes ?? 20*1024*1024,
      requestImagePixelBudget:source.requestImagePixelBudget ?? 4194304,
      requestImageMaxBytes:source.requestImageMaxBytes ?? 1024*1024,
      configuredMaxTokens:new Map(selected.map(e => [e.id,e.maxTokens])),modelErrors:new Map(),
      entries:new Map(selected.map(e => [e.id,e])), fast,
      piProvider:{id:route,name:route,baseUrl:source.baseURL,
        auth:{apiKey:{resolve:async ({credential}) => credential?.key ? {auth:{apiKey:credential.key},source:'DSH credential reference'} : undefined}},getModels:() => models,
        stream:(m,c,o) => responses.stream(m,c,o),streamSimple:(m,c,o) => responses.streamSimple(m,c,o)}
    });
  }
  return profiles;
}
export class ModelControlsAdapter extends PiAiAdapter {
  modelInfo(snapshot, provider, model) {
    const base = super.modelInfo(snapshot, provider, model);
    const entry = this.profileOf(snapshot, provider).entries.get(model);
    return {...base, ...(entry.levels.length ? {reasoning:{efforts:entry.levels.map(l => ({...l,id:llm.ReasoningEffortId(l.id)})),
      ...(entry.defaultEffort ? {defaultEffort:llm.ReasoningEffortId(entry.defaultEffort)} : {})}} : {})};
  }
  streamWithSnapshot(options, snapshot) {
    const profile = this.profileOf(snapshot, options.provider);
    const entry = profile.entries.get(options.model);
    if (!entry) throw new llm.LlmError('Unknown model', 'UNKNOWN_MODEL');
    const effort = options.reasoningEffort ?? entry.defaultEffort;
    validateSelection(entry, effort, profile.fast);
    // A per-request facade avoids races between concurrent sessions and keeps
    // frozen prepared calls bound to their original catalog/endpoint generation.
    const collection = Object.create(snapshot.models);
    collection.streamSimple = (model, context, piOptions) => snapshot.models.streamSimple(model, context, {
      ...piOptions,
      onPayload:async payload => transformPayload(payload, effort, profile.fast)
    });
    return super.streamWithSnapshot({...options,reasoningEffort:effort === 'ultra' ? 'max' : effort}, {...snapshot,models:collection});
  }
}
export function createProfileLoader(profilePath, catalogPath) {
  let previous, profiles;
  return () => {
    const rawProfile = readFileSync(profilePath, 'utf8');
    const rawCatalog = readFileSync(catalogPath, 'utf8');
    const fingerprint = rawProfile + '\0' + rawCatalog;
    if (fingerprint === previous) return profiles;
    const patch = yaml.parse(rawProfile);
    const source = patch.find(e => e.id === 'llm-pi-ai')?.config?.providers?.sub2api;
    if (!source) throw new Error('source provider sub2api is missing');
    const next = buildProfiles(source, JSON.parse(rawCatalog));
    previous = fingerprint;
    profiles = next;
    return profiles;
  };
}
export function apply(ctx) {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  const profilePath = join(home, 'profiles/desktop/cordis.patch.yml');
  const catalogPath = join(homedir(), '.codex/cc-switch-model-catalog.json');
  const profiles = createProfileLoader(profilePath, catalogPath);
  const initial = profiles();
  const adapter = new ModelControlsAdapter({profiles,
    resolveApiKey:async (_provider, profile) => {
      if (!profile.apiKeyEnv) throw new llm.LlmError('API credential reference is missing', 'MISSING_CREDENTIAL');
      const hit = await ctx.credentials.resolve(profile.apiKeyEnv);
      if (!hit?.value) throw new llm.LlmError('API credential is unavailable; configure the original Configured provider provider', 'MISSING_CREDENTIAL');
      return llm.assertUsableApiKey(hit.value, name, profile.apiKeyEnv);
    },
    resolveAttachments:() => ctx.get('attachments'),
    resolveImageAccess:(attachments, ref) => llm.resolveImageAttachmentAccess(attachments, hostPath => ctx.get('fs')?.processPathFromHostPath(hostPath), ref)
  });
  const registration = ctx.llm.registerAdapter([...initial.keys()], adapter);
  // Periodic metadata invalidation only; no network request, no credential read.
  // Model selection is persisted by the host's normal session model projection.
  let last = initial;
  ctx.effect(() => {
    const timer = setInterval(() => {
      try { const next = profiles(); if (next !== last) { registration.replace([...next.keys()]); last = next; } }
      catch (error) { ctx.logger.warn('model metadata refresh failed: ' + error.message); }
    }, 5000);
    timer.unref?.();
    return () => clearInterval(timer);
  });
  ctx.logger.info('GPT reasoning controls loaded (local catalog; no upstream request)');
}
