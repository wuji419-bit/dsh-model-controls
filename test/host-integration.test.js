import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { hostImport } from '../host-import.js';
import { buildProfiles } from '../runtime-v2.js';
import { decorateOriginal } from '../provider-controls.js';
import { catalog, model } from './helpers.js';
const { PiAiAdapter } = await hostImport('@deepseek-ai/dsh-llm-pi-ai');
const { createUserMessage } = await hostImport('@deepseek-ai/dsh-llm');
const completions = await hostImport('@earendil-works/pi-ai/api/openai-completions');

function reply(res, path) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  if (path.endsWith('/chat/completions')) {
    for (const chunk of [
      { choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } },
    ]) res.write('data: ' + JSON.stringify({ id: 'mock-chat', object: 'chat.completion.chunk', created: 0, model, ...chunk }) + '\n\n');
    res.end('data: [DONE]\n\n'); return;
  }
  const output = [{ id: 'msg_mock', type: 'message', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: 'ok', annotations: [] }] }];
  const response = { id: 'resp_mock', object: 'response', status: 'completed', model, output,
    usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
  for (const event of [
    { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...output[0], status: 'in_progress', content: [] } },
    { type: 'response.content_part.added', item_id: 'msg_mock', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
    { type: 'response.output_text.delta', item_id: 'msg_mock', output_index: 0, content_index: 0, delta: 'ok' },
    { type: 'response.output_item.done', output_index: 0, item: output[0] },
    { type: 'response.completed', response },
  ]) res.write('event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n');
  res.end();
}

async function mockServer(t) {
  const captured = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    captured.push({ path: req.url, payload: JSON.parse(raw), headers: req.headers });
    reply(res, req.url);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { captured, url: 'http://127.0.0.1:' + server.address().port };
}

function profile(provider, baseURL, api = 'openai-responses') {
  const source = { api: 'openai-responses', baseURL, apiKeyEnv: 'MOCK_' + provider,
    headers: { 'x-original-provider': provider }, models: [{ id: model }] };
  const legacy = buildProfiles(source, catalog).get('model-controls-api');
  const models = legacy.piProvider.getModels().map(descriptor => ({ ...descriptor, provider, api }));
  return { ...legacy, piProvider: { ...legacy.piProvider, id: provider, name: provider, getModels: () => models,
    ...(api === 'openai-completions' ? { stream: completions.stream, streamSimple: completions.streamSimple } : {}) } };
}

function makeAdapter(profiles) {
  return new PiAiAdapter({ profiles, resolveApiKey: async provider => 'mock-key-for-' + provider });
}
function options(provider, effort = 'ultra') {
  return { provider, model, sessionId: provider + '-session', reasoningEffort: effort, maxTokens: 32,
    messages: [createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })] };
}
async function consume(iterable) {
  const chunks = []; for await (const chunk of iterable) chunks.push(chunk);
  const finish = chunks.find(chunk => chunk.type === 'finish');
  assert.ok(finish, JSON.stringify(chunks));
  assert.notEqual(finish.reason.kind, 'error', JSON.stringify(chunks));
}

test('real host: two arbitrary providers keep their own HTTP URL, credential and headers', async t => {
  const { captured, url } = await mockServer(t);
  const profiles = new Map([
    ['my-company-api', profile('my-company-api', url + '/first/v1')],
    ['personal-gateway', profile('personal-gateway', url + '/second/v1')],
  ]);
  const adapter = makeAdapter(() => profiles);
  t.after(decorateOriginal(adapter, { catalog: () => catalog, speed: (_session, provider) => provider === 'personal-gateway' }));
  await Promise.all([consume(adapter.stream(options('my-company-api'))), consume(adapter.stream(options('personal-gateway')))]);
  assert.equal(captured.length, 2);
  for (const [provider, pathname, fast] of [['my-company-api', '/first/v1/responses', false], ['personal-gateway', '/second/v1/responses', true]]) {
    const sent = captured.find(item => item.path === pathname);
    assert.ok(sent);
    assert.equal(sent.headers.authorization, 'Bearer mock-key-for-' + provider);
    assert.equal(sent.headers['x-original-provider'], provider);
    assert.equal(sent.payload.model, model);
    assert.equal(sent.payload.reasoning.effort, 'ultra');
    assert.equal(sent.payload.service_tier, fast ? 'priority' : undefined);
  }
});

test('real host: generic Chat Completions GPT routes receive protocol-correct speed and effort', async t => {
  const { captured, url } = await mockServer(t);
  const profiles = new Map([['renamed-chat-service', profile('renamed-chat-service', url + '/v1', 'openai-completions')]]);
  const adapter = makeAdapter(() => profiles);
  t.after(decorateOriginal(adapter, { catalog: () => catalog, speed: () => true }));
  await consume(adapter.stream(options('renamed-chat-service')));
  assert.equal(captured.length, 1);
  assert.equal(captured[0].path, '/v1/chat/completions');
  assert.equal(captured[0].payload.reasoning_effort, 'ultra');
  assert.equal(captured[0].payload.reasoning, undefined);
  assert.equal(captured[0].payload.service_tier, 'priority');
  assert.equal(captured[0].headers.authorization, 'Bearer mock-key-for-renamed-chat-service');
});

test('real host: prepared GPT calls stay pinned across provider and catalog edits', async t => {
  const { captured, url } = await mockServer(t);
  let profiles = new Map([['custom-api', profile('custom-api', url + '/original/v1')]]);
  let currentCatalog = catalog;
  const adapter = makeAdapter(() => profiles);
  t.after(decorateOriginal(adapter, { catalog: () => currentCatalog }));
  const prepared = await adapter.prepareCall('custom-api', model);
  profiles = new Map([['custom-api', profile('custom-api', url + '/changed/v1')]]);
  currentCatalog = { models: [] };
  await consume(prepared.stream(options('custom-api')));
  assert.equal(captured[0].path, '/original/v1/responses');
  assert.equal(captured[0].payload.reasoning.effort, 'ultra');
});
