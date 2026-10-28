export const ROUTES = ['model-controls-api', 'model-controls-api-fast'];
export const NATIVE_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export const OFFERED_LEVELS = new Set([...NATIVE_LEVELS, 'ultra']);
export function capabilities(catalog, source) {
  if (!Array.isArray(catalog.models)) throw new Error('catalog has no models array');
  const configured = new Map(source.models.map(m => [m.id, m]));
  const seen = new Set();
  const entries = [];
  for (const entry of catalog.models) {
    if (!configured.has(entry.slug) || !/^gpt-/i.test(entry.slug) || /image/i.test(entry.slug)) continue;
    if (seen.has(entry.slug)) throw new Error('Duplicate catalog model: ' + entry.slug);
    seen.add(entry.slug);
    const levels = (entry.supported_reasoning_levels ?? []).map(l => ({id:l.effort, name:l.effort === 'xhigh' ? 'Extra High' : l.effort.charAt(0).toUpperCase()+l.effort.slice(1), ...(l.description ? {description:l.description} : {})}));
    if (levels.some(l => !OFFERED_LEVELS.has(l.id)) || new Set(levels.map(l => l.id)).size !== levels.length) throw new Error('Unsupported or duplicate reasoning level: ' + entry.slug);
    const def = entry.default_reasoning_level;
    if (def && !levels.some(l => l.id === def)) throw new Error('Invalid default reasoning level: ' + entry.slug);
    entries.push({id:entry.slug, name:configured.get(entry.slug).name ?? entry.display_name ?? entry.slug,
      levels, defaultEffort:def, fast:(entry.service_tiers ?? []).some(t => t.id === 'priority'),
      input:entry.input_modalities?.includes('image') ? ['text','image'] : ['text'],
      contextWindow:configured.get(entry.slug).contextWindow ?? positive(entry.context_window, source.defaultContextWindow ?? 262144),
      maxTokens:configured.get(entry.slug).maxTokens ?? Math.min(positive(entry.max_output_tokens, source.defaultMaxTokens ?? 65536), source.defaultMaxTokens ?? 65536)});
  }
  if (!entries.length) throw new Error('No configured GPT models found in catalog');
  return entries;
}
function positive(value, fallback) { return Number.isSafeInteger(value) && value > 0 ? value : fallback; }
export function validateSelection(entry, effort, fast) {
  if (fast && !entry.fast) throw new Error('model does not advertise Priority: ' + entry.id);
  if (effort !== undefined && !entry.levels.some(l => l.id === effort)) throw new Error('model does not advertise reasoning level: ' + effort);
}
export function transformPayload(payload, effort, fast) {
  const next = {...payload};
  if (effort !== undefined) next.reasoning = {...payload.reasoning, effort};
  if (fast) next.service_tier = 'priority';
  else delete next.service_tier;
  return next;
}
