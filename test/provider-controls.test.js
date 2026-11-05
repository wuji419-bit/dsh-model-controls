import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogCapability, isGptChatModel } from '../catalog.js';
import { decorateOriginal, modelControls, EMPTY_CATALOG } from '../provider-controls.js';
import { FakeAdapter, catalog, model, request, snapshotFor } from './helpers.js';

for (const provider of ['openai', 'arbitrary-api', 'sub2api', '中文服务', 'api/with:punctuation']) {
  test('uses the existing service config without requiring the name ' + provider, async () => {
    const snapshot = snapshotFor([provider]);
    const adapter = new FakeAdapter(snapshot);
    decorateOriginal(adapter, { catalog: () => catalog, speed: () => true });
    const result = await adapter.stream(request(provider, { reasoningEffort: 'ultra' }));
    assert.equal(result.payload.service_tier, 'priority');
    assert.equal(result.payload.reasoning.effort, 'ultra');
    assert.equal(result.descriptor.provider, provider);
    assert.equal(result.profile, snapshot.profiles.get(provider));
    assert.equal(result.descriptor.baseUrl, snapshot.models.getModel(provider, model).baseUrl);
  });
}

test('concurrent calls to the same GPT model keep each provider profile and speed', async () => {
  const adapter = new FakeAdapter();
  const original = adapter.current();
  const descriptor = original.models.getModel('arbitrary-api', model);
  decorateOriginal(adapter, { catalog: () => catalog, speed: (_session, provider) => provider === '另一个接入' });
  const [a, b] = await Promise.all([adapter.stream(request()), adapter.stream(request('另一个接入'))]);
  assert.equal(a.payload.service_tier, undefined);
  assert.equal(b.payload.service_tier, 'priority');
  assert.notEqual(a.profile.baseURL, b.profile.baseURL);
  assert.notEqual(a.profile.apiKeyEnv, b.profile.apiKeyEnv);
  assert.equal(adapter.current(), original);
  assert.equal(original.models.getModel('arbitrary-api', model), descriptor);
  assert.deepEqual(descriptor.thinkingLevelMap, { low: 'low', high: 'high' });
});

test('reasoning metadata is enhanced on all providers without changing context limits', () => {
  const adapter = new FakeAdapter();
  decorateOriginal(adapter, { catalog: () => catalog });
  for (const provider of adapter.current().profiles.keys()) {
    const info = adapter.modelInfo(adapter.current(), provider, model);
    assert.deepEqual(info.reasoning.efforts.map(level => level.id), ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
    assert.equal(info.context.contextWindow, 123456);
  }
});

test('non-GPT and image models keep original calls and never read the controls catalog', async () => {
  const adapter = new FakeAdapter();
  let reads = 0;
  decorateOriginal(adapter, { catalog: () => { reads++; return catalog; }, speed: () => true });
  for (const id of ['claude-sonnet', 'gpt-image-2']) {
    const result = await adapter.stream(request('arbitrary-api', { model: id }));
    assert.equal(result.payload.service_tier, undefined);
  }
  assert.equal(reads, 0);
});

test('unlisted GPT models keep original capabilities and are still recognized', async () => {
  const adapter = new FakeAdapter();
  decorateOriginal(adapter, { catalog: () => EMPTY_CATALOG, speed: () => true });
  const control = modelControls(adapter.current(), 'arbitrary-api', model, EMPTY_CATALOG);
  assert.ok(control);
  assert.equal(control.capability, undefined);
  const result = await adapter.stream(request());
  assert.equal(result.payload.service_tier, undefined);
  assert.equal(result.descriptor, adapter.current().models.getModel('arbitrary-api', model));
});

test('unsupported wire protocols are left to the original adapter', async () => {
  const snapshot = snapshotFor();
  snapshot.models.getModel('arbitrary-api', model).api = 'anthropic-messages';
  assert.equal(modelControls(snapshot, 'arbitrary-api', model, catalog), undefined);
  const adapter = new FakeAdapter(snapshot);
  decorateOriginal(adapter, { catalog: () => catalog, speed: () => true });
  const result = await adapter.stream(request());
  assert.equal(result.payload.service_tier, undefined);
});

test('Chat Completions receives reasoning_effort rather than Responses reasoning', async () => {
  const snapshot = snapshotFor();
  snapshot.models.getModel('arbitrary-api', model).api = 'openai-completions';
  const adapter = new FakeAdapter(snapshot);
  decorateOriginal(adapter, { catalog: () => catalog, speed: () => true });
  const result = await adapter.stream(request('arbitrary-api', { reasoningEffort: 'ultra' }));
  assert.equal(result.payload.reasoning_effort, 'ultra');
  assert.equal(result.payload.service_tier, 'priority');
  assert.equal(result.payload.reasoning, undefined);
});

test('prepared calls keep the old endpoint and capability snapshot after config changes', async () => {
  const adapter = new FakeAdapter();
  let currentCatalog = structuredClone(catalog);
  decorateOriginal(adapter, { catalog: () => currentCatalog });
  const prepared = await adapter.prepareCall('arbitrary-api', model);
  const oldProfile = adapter.current().profiles.get('arbitrary-api');
  adapter.snapshot = snapshotFor();
  adapter.snapshot.profiles.get('arbitrary-api').baseURL = 'https://example.invalid/new';
  currentCatalog = EMPTY_CATALOG;
  const result = await prepared.stream(request('arbitrary-api', { reasoningEffort: 'ultra' }));
  assert.equal(result.profile, oldProfile);
  assert.equal(result.payload.reasoning.effort, 'ultra');
});

test('existing onPayload hooks and tool/image input references survive transformation', async () => {
  const adapter = new FakeAdapter();
  adapter.payloadHook = payload => { payload.custom = 'original-hook'; };
  decorateOriginal(adapter, { catalog: () => catalog, speed: () => true });
  const messages = [{ type: 'input_image', image_url: 'data:image/png;base64,mock' }];
  const tools = [{ type: 'function', name: 'mock' }];
  const result = await adapter.stream(request('arbitrary-api', { messages, tools }));
  assert.equal(result.payload.custom, 'original-hook');
  assert.equal(result.payload.input, messages);
  assert.equal(result.payload.tools, tools);
  assert.equal(result.payload.reasoning.summary, 'auto');
});

test('unsupported reasoning is rejected before the original stream dispatch', () => {
  const adapter = new FakeAdapter();
  decorateOriginal(adapter, { catalog: () => catalog });
  assert.throws(() => adapter.stream(request('arbitrary-api', { reasoningEffort: 'bogus' })), /does not advertise/);
});

test('disposal restores inherited methods without leaving own-property overrides', () => {
  const adapter = new FakeAdapter();
  const original = adapter.modelInfo;
  const restore = decorateOriginal(adapter);
  assert.notEqual(adapter.modelInfo, original);
  restore(); restore();
  assert.equal(adapter.modelInfo, original);
  assert.equal(Object.hasOwn(adapter, 'modelInfo'), false);
});

test('disposal preserves a later decorator installed by someone else', () => {
  const adapter = new FakeAdapter();
  const restore = decorateOriginal(adapter);
  const later = () => 'later-plugin';
  adapter.modelInfo = later;
  restore();
  assert.equal(adapter.modelInfo, later);
});

test('partial installation rolls back when a host method cannot be decorated', () => {
  const adapter = new FakeAdapter();
  const original = adapter.modelInfo;
  Object.defineProperty(adapter, 'prepareCall', { value: adapter.prepareCall, configurable: false });
  assert.throws(() => decorateOriginal(adapter), TypeError);
  assert.equal(adapter.modelInfo, original);
  assert.equal(Object.hasOwn(adapter, 'modelInfo'), false);
});

test('GPT recognition is case-insensitive but does not include image/non-GPT models', () => {
  for (const id of ['gpt-4o', 'GPT-6.1-SOL']) assert.equal(isGptChatModel(id), true);
  for (const id of ['gpt-image-2', 'GPT-IMAGE-2', 'claude-sonnet', '', undefined]) assert.equal(isGptChatModel(id), false);
  assert.equal(catalogCapability(catalog, 'GPT-6.1-SOL').fast, true);
});
