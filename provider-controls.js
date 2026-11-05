import { catalogCapability, isGptChatModel, NATIVE_LEVELS, transformPayload, validateSelection } from './catalog.js';

const APIS = new Set(['openai-responses', 'openai-completions']);
export const EMPTY_CATALOG = Object.freeze({ models: Object.freeze([]) });
const METHODS = ['modelInfo', 'prepareCall', 'streamWithSnapshot'];

export function canDecorate(adapter) {
  if (!adapter || !['current', ...METHODS].every(key => typeof adapter[key] === 'function')) return false;
  try {
    const snapshot = adapter.current();
    return typeof snapshot?.profiles?.has === 'function' && typeof snapshot.models?.getModel === 'function'
      && typeof snapshot.models?.streamSimple === 'function';
  } catch { return false; }
}

// Read the host's resolved snapshot instead of guessing a provider name, profile
// location, endpoint, credential reference, protocol, or model configuration.
export function modelControls(snapshot, provider, model, catalog) {
  if (!isGptChatModel(model) || !snapshot?.profiles?.has(provider)
    || typeof snapshot.models?.getModel !== 'function') return undefined;
  const descriptor = snapshot.models?.getModel(provider, model);
  if (!descriptor || !APIS.has(descriptor.api)) return undefined;
  return { provider, model, descriptor, capability: catalogCapability(catalog, model) };
}

function controlledSnapshot(snapshot, control) {
  const capability = control.capability;
  if (!capability?.levels.length) return snapshot;
  const thinkingLevelMap = Object.fromEntries(NATIVE_LEVELS.map(level =>
    [level, capability.levels.some(value => value.id === level) ? level : null]));
  if (capability.levels.some(level => level.id === 'ultra')) thinkingLevelMap.max = 'max';
  const descriptor = { ...control.descriptor, reasoning: true, thinkingLevelMap };
  const models = Object.create(snapshot.models);
  models.getModel = (provider, model) => provider === control.provider && model === control.model
    ? descriptor : snapshot.models.getModel(provider, model);
  return { ...snapshot, models };
}

export function decorateOriginal(original, { catalog = () => EMPTY_CATALOG, speed = () => false } = {}) {
  if (!canDecorate(original)) throw new Error('Unsupported DSH adapter contract');
  const saved = new Map(METHODS.map(key => [key, { method: original[key], descriptor: Object.getOwnPropertyDescriptor(original, key) }]));
  const invoke = (key, self, ...args) => saved.get(key).method.call(self, ...args);

  function info(self, snapshot, provider, model, control) {
    const base = invoke('modelInfo', self, controlledSnapshot(snapshot, control), provider, model);
    const capability = control.capability;
    if (!capability?.levels.length) return base;
    const defaultEffort = snapshot.profiles.get(provider).reasoning ?? capability.defaultEffort;
    return { ...base, reasoning: { efforts: capability.levels.map(level => ({ ...level })),
      ...(defaultEffort === undefined ? {} : { defaultEffort }) } };
  }

  function stream(self, options, snapshot, control) {
    const capability = control.capability;
    // Without declared extra capabilities, use the original host behavior verbatim.
    if (!capability) return invoke('streamWithSnapshot', self, options, snapshot);
    const fast = capability.fast && speed(options.sessionId, options.provider, options.model);
    const effort = options.reasoningEffort ?? snapshot.profiles.get(control.provider).reasoning ?? capability.defaultEffort;
    validateSelection(capability, effort, fast);
    const controlled = controlledSnapshot(snapshot, control);
    const models = Object.create(controlled.models);
    models.streamSimple = (model, context, piOptions) => snapshot.models.streamSimple(model, context, {
      ...piOptions,
      onPayload: async (payload, ...args) => {
        const previous = piOptions.onPayload ? await piOptions.onPayload(payload, ...args) : undefined;
        return transformPayload(previous ?? payload, effort, capability.fast ? !!fast : undefined, control.descriptor.api);
      },
    });
    return invoke('streamWithSnapshot', self,
      { ...options, reasoningEffort: effort === 'ultra' ? 'max' : effort }, { ...controlled, models });
  }

  const patches = {
    modelInfo(snapshot, provider, model) {
      if (!isGptChatModel(model)) return invoke('modelInfo', this, snapshot, provider, model);
      const control = modelControls(snapshot, provider, model, catalog());
      return control ? info(this, snapshot, provider, model, control) : invoke('modelInfo', this, snapshot, provider, model);
    },
    prepareCall(provider, model, signal) {
      if (!isGptChatModel(model)) return invoke('prepareCall', this, provider, model, signal);
      const snapshot = this.current();
      const control = modelControls(snapshot, provider, model, catalog());
      if (!control) return invoke('prepareCall', this, provider, model, signal);
      // Capture both the host configuration and capability generation once. Do not
      // reroute a prepared call after a provider/model/catalog edit in the UI.
      return Promise.resolve({ model: info(this, snapshot, provider, model, control),
        stream: options => stream(this, options, snapshot, control) });
    },
    streamWithSnapshot(options, snapshot) {
      if (!isGptChatModel(options.model)) return invoke('streamWithSnapshot', this, options, snapshot);
      const control = modelControls(snapshot, options.provider, options.model, catalog());
      return control ? stream(this, options, snapshot, control) : invoke('streamWithSnapshot', this, options, snapshot);
    },
  };

  const restore = () => {
    for (const [key, prior] of saved) {
      if (original[key] !== patches[key]) continue;
      if (prior.descriptor) Object.defineProperty(original, key, prior.descriptor);
      else delete original[key];
    }
  };
  try {
    for (const [key, value] of Object.entries(patches)) {
      Object.defineProperty(original, key, { value, configurable: true, writable: true });
    }
  } catch (error) { restore(); throw error; }
  return restore;
}
