import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { canDecorate, decorateOriginal, EMPTY_CATALOG, modelControls } from './provider-controls.js';
export { decorateOriginal } from './provider-controls.js';
export const name = 'model-controls';
export const inject = ['llm', 'connection'];

export function createCatalogLoader(path, warn = () => {}) {
  let previous, catalog, missing = false;
  return () => {
    let raw;
    try { raw = readFileSync(path, 'utf8'); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (!missing) warn('Model capability catalog is missing; keeping original model capabilities and disabling undeclared Fast mode.');
      missing = true;
      return EMPTY_CATALOG;
    }
    missing = false;
    if (raw !== previous) {
      const next = JSON.parse(raw);
      if (!Array.isArray(next.models)) throw new Error('catalog has no models array');
      catalog = next; previous = raw;
    }
    return catalog;
  };
}

const speedKey = (sessionId, provider, model) => JSON.stringify([sessionId, provider, model]);
export function apply(ctx, { catalogPath = join(homedir(), '.codex/cc-switch-model-catalog.json'),
  speedPath = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'plugins/model-controls/session-speed.json') } = {}) {
  const catalog = createCatalogLoader(catalogPath, message => ctx.logger?.warn?.(message));
  let choices = new Map();
  try {
    const stored = JSON.parse(readFileSync(speedPath, 'utf8'));
    // Legacy booleans do not identify a provider. Never silently enable a paid
    // tier on an arbitrary newly discovered service while migrating them.
    if (stored.version === 2 && stored.choices && typeof stored.choices === 'object' && !Array.isArray(stored.choices)) {
      choices = new Map(Object.entries(stored.choices).filter(([, fast]) => fast === true));
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const speed = (sessionId, provider, model) => choices.get(speedKey(sessionId, provider, model)) === true;
  const attached = new Map();
  let disposed = false;
  const attach = () => {
    if (disposed) return;
    // One adapter may own several provider IDs. Patch its object once, not once
    // per name, and restore it when it is removed/replaced or the plugin stops.
    const active = new Set([...ctx.llm.adapters.values()].map(record => record.adapter).filter(canDecorate));
    for (const [adapter, restore] of attached) {
      if (!active.has(adapter)) { restore(); attached.delete(adapter); }
    }
    for (const adapter of active) {
      if (!attached.has(adapter)) attached.set(adapter, decorateOriginal(adapter, { catalog, speed }));
    }
  };
  attach();
  ctx.on('llm/adapters-updated', attach);
  ctx.effect(() => () => {
    disposed = true;
    for (const restore of attached.values()) restore();
    attached.clear();
  });

  function selection(provider, model) {
    const adapter = ctx.llm.adapters.get(provider)?.adapter;
    if (!attached.has(adapter)) return undefined;
    return modelControls(adapter.current(), provider, model, catalog());
  }
  const result = (sessionId, provider, model, control) => ({
    supported: !!control,
    fastAvailable: control?.capability?.fast === true,
    fast: control?.capability?.fast === true && speed(sessionId, provider, model),
  });
  for (const op of ['get', 'set']) ctx.connection.fetch.register({
    path: '/api/model-speed.' + op, methods: ['POST'], requestBody: 'buffered',
    fetch: async request => {
      let envelope;
      try {
        envelope = await request.json();
        if (envelope?.type !== 'client-request' || envelope.method !== 'model-speed.' + op || typeof envelope.rpcId !== 'string') {
          throw new Error('Invalid request envelope');
        }
        const args = envelope.payload?.args ?? envelope.payload;
        for (const key of ['sessionId', 'provider', 'model']) {
          if (typeof args?.[key] !== 'string' || !args[key] || args[key].length > 512) throw new Error('Invalid ' + key);
        }
        const { sessionId, provider, model } = args;
        const control = selection(provider, model);
        if (op === 'set') {
          if (typeof args.fast !== 'boolean') throw new Error('Invalid fast choice');
          if (!control) throw new Error('Current model does not support GPT model controls');
          if (args.fast && !control.capability?.fast) throw new Error('Current model does not advertise Fast');
          const next = new Map(choices);
          const key = speedKey(sessionId, provider, model);
          if (args.fast) next.set(key, true); else next.delete(key);
          mkdirSync(dirname(speedPath), { recursive: true });
          writeFileSync(speedPath + '.tmp', JSON.stringify({ version: 2, choices: Object.fromEntries(next) }), { mode: 0o600 });
          renameSync(speedPath + '.tmp', speedPath);
          choices = next;
        }
        return Response.json({ type: 'server-response', rpcId: envelope.rpcId,
          result: { ok: true, value: result(sessionId, provider, model, control) } });
      } catch (error) {
        return Response.json({ type: 'server-response', rpcId: envelope?.rpcId ?? 'invalid-request',
          result: { ok: false, error: { code: 'model-speed/error', message: error.message } } });
      }
    },
  });
  ctx.llm.emitAdaptersUpdated();
}
