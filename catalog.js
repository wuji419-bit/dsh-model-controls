export const ROUTES = ['model-controls-api', 'model-controls-api-fast'];
export const NATIVE_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export const OFFERED_LEVELS = new Set([...NATIVE_LEVELS, 'ultra']);

export function isGptChatModel(model) {
  return typeof model === 'string' && /^gpt-/i.test(model) && !/image/i.test(model);
}

// An absent catalog entry is not evidence for extra reasoning levels or Priority.
export function catalogCapability(catalog, model) {
  if (!Array.isArray(catalog.models)) throw new Error('catalog has no models array');
  const matches = catalog.models.filter(entry =>
    typeof entry.slug === 'string' && entry.slug.toLowerCase() === model.toLowerCase());
  if (matches.length > 1) throw new Error('Duplicate catalog model: ' + model);
  const entry = matches[0];
  if (!entry) return undefined;
  const levels = (entry.supported_reasoning_levels ?? []).map(level => {
    const effort = level.effort;
    if (!OFFERED_LEVELS.has(effort)) throw new Error('Unsupported reasoning level: ' + model);
    return { id: effort, name: effort === 'xhigh' ? 'Extra High' : effort.charAt(0).toUpperCase() + effort.slice(1),
      ...(level.description ? { description: level.description } : {}) };
  });
  if (new Set(levels.map(level => level.id)).size !== levels.length) {
    throw new Error('Unsupported or duplicate reasoning level: ' + model);
  }
  const defaultEffort = entry.default_reasoning_level;
  if (defaultEffort && !levels.some(level => level.id === defaultEffort)) {
    throw new Error('Invalid default reasoning level: ' + model);
  }
  return { id: model, levels, defaultEffort,
    fast: (entry.service_tiers ?? []).some(tier => tier.id === 'priority'), entry };
}

export function capabilities(catalog, source) {
  if (!Array.isArray(catalog.models)) throw new Error('catalog has no models array');
  const entries = [];
  for (const configured of source.models) {
    if (!isGptChatModel(configured.id)) continue;
    const capability = catalogCapability(catalog, configured.id);
    if (!capability) continue;
    const { entry, ...controls } = capability;
    entries.push({ ...controls, name: configured.name ?? entry.display_name ?? configured.id,
      input: entry.input_modalities?.includes('image') ? ['text', 'image'] : ['text'],
      contextWindow: configured.contextWindow ?? positive(entry.context_window, source.defaultContextWindow ?? 262144),
      maxTokens: configured.maxTokens ?? Math.min(positive(entry.max_output_tokens, source.defaultMaxTokens ?? 65536), source.defaultMaxTokens ?? 65536) });
  }
  if (!entries.length) throw new Error('No configured GPT models found in catalog');
  return entries;
}
function positive(value, fallback) { return Number.isSafeInteger(value) && value > 0 ? value : fallback; }
export function validateSelection(entry, effort, fast) {
  if (fast && !entry.fast) throw new Error('model does not advertise Priority: ' + entry.id);
  if (effort !== undefined && !entry.levels.some(level => level.id === effort)) {
    throw new Error('model does not advertise reasoning level: ' + effort);
  }
}
export function transformPayload(payload, effort, fast, api = 'openai-responses') {
  const next = { ...payload };
  if (effort !== undefined) {
    if (api === 'openai-completions') next.reasoning_effort = effort;
    else next.reasoning = { ...payload.reasoning, effort };
  }
  if (fast === true) next.service_tier = 'priority';
  else if (fast === false) delete next.service_tier;
  return next;
}
