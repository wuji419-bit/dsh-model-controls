export const model = 'gpt-6.1-sol';
export const catalog = { models: [{ slug: model,
  supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map(effort => ({ effort })),
  default_reasoning_level: 'low', service_tiers: [{ id: 'priority' }] }] };

export function snapshotFor(providers = ['arbitrary-api', '另一个接入']) {
  const profiles = new Map();
  const descriptors = new Map();
  for (const [index, provider] of providers.entries()) {
    profiles.set(provider, { baseURL: 'https://example.invalid/' + index,
      apiKeyEnv: 'MOCK_REFERENCE_' + index, headers: { 'x-provider': provider } });
    for (const id of [model, 'gpt-without-catalog', 'gpt-image-2', 'claude-sonnet']) {
      descriptors.set(JSON.stringify([provider, id]), { id, provider, api: 'openai-responses',
        baseUrl: profiles.get(provider).baseURL, name: id, input: ['text', 'image'],
        reasoning: true, thinkingLevelMap: { low: 'low', high: 'high' }, contextWindow: 123456, maxTokens: 999 });
    }
  }
  return { profiles, descriptors, models: {
    getModel(provider, id) { return descriptors.get(JSON.stringify([provider, id])); },
    async streamSimple(descriptor, context, options) {
      const payload = { model: descriptor.id, input: context.messages, tools: context.tools,
        ...(descriptor.api === 'openai-completions' ? { reasoning_effort: options.reasoningEffort }
          : { reasoning: { effort: options.reasoningEffort, summary: 'auto' } }) };
      const transformed = await options.onPayload?.(payload, descriptor);
      return { payload: transformed ?? payload, descriptor, context, profile: options.profile };
    },
  } };
}

export class FakeAdapter {
  constructor(snapshot = snapshotFor()) { this.snapshot = snapshot; }
  current() { return this.snapshot; }
  modelInfo(snapshot, provider, id) {
    const descriptor = snapshot.models.getModel(provider, id);
    return { provider, id, name: descriptor.name, context: { contextWindow: descriptor.contextWindow },
      reasoning: { efforts: Object.entries(descriptor.thinkingLevelMap).filter(([, value]) => value !== null).map(([id]) => ({ id })) } };
  }
  prepareCall(provider, model) {
    const snapshot = this.current();
    return Promise.resolve({ model: this.modelInfo(snapshot, provider, model),
      stream: options => this.streamWithSnapshot(options, snapshot) });
  }
  stream(options) { return this.streamWithSnapshot(options, this.current()); }
  streamWithSnapshot(options, snapshot) {
    const descriptor = snapshot.models.getModel(options.provider, options.model);
    return snapshot.models.streamSimple(descriptor, { messages: options.messages ?? [], tools: options.tools ?? [] },
      { reasoningEffort: options.reasoningEffort, profile: snapshot.profiles.get(options.provider), onPayload: this.payloadHook });
  }
}
export const request = (provider = 'arbitrary-api', extra = {}) => ({ provider, model, sessionId: 'session', reasoningEffort: 'high', ...extra });
