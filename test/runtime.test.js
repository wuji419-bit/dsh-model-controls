import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { apply, createCatalogLoader } from '../merged-runtime.js';
import { FakeAdapter, catalog, model } from './helpers.js';

function fixture(t, { legacy, empty = false, missingCatalog = false, adapter = new FakeAdapter() } = {}) {
  const prefix = resolve(tmpdir(), 'dsh-model-controls-test-');
  const root = mkdtempSync(prefix);
  const catalogPath = join(root, 'catalog.json'), speedPath = join(root, 'state/session-speed.json');
  if (!missingCatalog) writeFileSync(catalogPath, JSON.stringify(catalog));
  if (legacy) {
    mkdirSync(join(root, 'state')); writeFileSync(speedPath, JSON.stringify(legacy));
  }
  const handlers = new Map(), events = new Map(), cleanups = [], warnings = [];
  const adapters = new Map(empty ? [] : [...adapter.current().profiles.keys()].map(provider => [provider, { adapter }]));
  const ctx = {
    llm: { adapters, emitAdaptersUpdated: () => events.get('llm/adapters-updated')?.() },
    connection: { fetch: { register: entry => handlers.set(entry.path, entry.fetch) } },
    on: (event, listener) => events.set(event, listener),
    effect: callback => cleanups.push(callback()), logger: { warn: message => warnings.push(message) },
  };
  const start = () => apply(ctx, { catalogPath, speedPath });
  const stop = () => cleanups.splice(0).forEach(cleanup => cleanup());
  start();
  t.after(() => {
    stop();
    const target = realpathSync(root);
    assert.ok(target.startsWith(prefix), 'cleanup must stay within the dedicated test prefix');
    assert.equal(resolve(target, '..') + sep, resolve(tmpdir()) + sep);
    rmSync(target, { recursive: true, force: true });
  });
  async function rpc(op, args = {}, envelope = {}) {
    const handler = handlers.get('/api/model-speed.' + op);
    const response = await handler({ json: async () => ({ type: 'client-request', rpcId: 'test-rpc', method: 'model-speed.' + op,
      payload: { args: { sessionId: 'session', provider: 'arbitrary-api', model, ...args } }, ...envelope }) });
    return (await response.json()).result;
  }
  return { ctx, adapter, rpc, root, catalogPath, speedPath, start, stop, warnings,
    emit: () => ctx.llm.emitAdaptersUpdated() };
}

// The fixtures never read a user's DSH profile, credentials, or speed settings.
import * as fixtureFs from 'node:fs';
const setup = fixture;

test('arbitrary providers are detected without any provider config path or fixed ID', async t => {
  const app = setup(t);
  for (const provider of ['arbitrary-api', '另一个接入']) {
    assert.deepEqual(await app.rpc('get', { provider }), { ok: true, value: { supported: true, fastAvailable: true, fast: false } });
  }
  assert.equal(existsSync(app.speedPath), false);
});

test('speed choices are isolated by session, provider, and model', async t => {
  const app = setup(t);
  assert.equal((await app.rpc('set', { fast: true })).value.fast, true);
  for (const args of [{ provider: '另一个接入' }, { sessionId: 'other-session' }, { model: 'gpt-without-catalog' }]) {
    assert.equal((await app.rpc('get', args)).value.fast, false);
  }
  assert.equal((await app.rpc('get')).value.fast, true);
  assert.equal((await app.rpc('set', { fast: false })).value.fast, false);
});

test('provider-specific state persists through restart and contains no credentials or endpoints', async t => {
  const app = setup(t);
  await app.rpc('set', { fast: true });
  const raw = readFileSync(app.speedPath, 'utf8');
  assert.equal(JSON.parse(raw).version, 2);
  assert.doesNotMatch(raw, /apiKey|MOCK_REFERENCE|baseURL|example\.invalid/);
  app.stop(); app.start();
  assert.equal((await app.rpc('get')).value.fast, true);
  assert.equal((await app.rpc('get', { provider: '另一个接入' })).value.fast, false);
});

test('legacy provider-less fast records do not activate Fast on arbitrary services', async t => {
  const app = setup(t, { legacy: { session: true } });
  assert.equal((await app.rpc('get')).value.fast, false);
  await app.rpc('set', { provider: '另一个接入', fast: true });
  assert.equal((await app.rpc('get')).value.fast, false);
  assert.equal(JSON.parse(readFileSync(app.speedPath, 'utf8')).version, 2);
});

test('models not listed in the catalog are detected but cannot enable undeclared Fast', async t => {
  const app = setup(t);
  const args = { model: 'gpt-without-catalog' };
  assert.deepEqual((await app.rpc('get', args)).value, { supported: true, fastAvailable: false, fast: false });
  assert.equal((await app.rpc('set', { ...args, fast: true })).ok, false);
  assert.equal(existsSync(app.speedPath), false);
});

test('missing capability catalog preserves GPT recognition and only warns once', async t => {
  const app = setup(t, { missingCatalog: true });
  for (let i = 0; i < 2; i++) assert.deepEqual((await app.rpc('get')).value, { supported: true, fastAvailable: false, fast: false });
  assert.equal(app.warnings.length, 1);
  writeFileSync(app.catalogPath, JSON.stringify(catalog));
  assert.equal((await app.rpc('get')).value.fastAvailable, true);
});

test('one shared adapter is patched once and restored on disposal', t => {
  const adapter = new FakeAdapter();
  const original = adapter.streamWithSnapshot;
  const app = setup(t, { adapter });
  const patched = adapter.streamWithSnapshot;
  app.emit(); app.emit();
  assert.notEqual(patched, original);
  assert.equal(adapter.streamWithSnapshot, patched);
  app.stop(); app.emit();
  assert.equal(adapter.streamWithSnapshot, original);
  assert.equal(Object.hasOwn(adapter, 'streamWithSnapshot'), false);
});

test('providers registered after plugin startup are picked up without restarting it', async t => {
  const app = setup(t, { empty: true });
  assert.equal((await app.rpc('get')).value.supported, false);
  app.ctx.llm.adapters.set('arbitrary-api', { adapter: app.adapter }); app.emit();
  assert.equal((await app.rpc('get')).value.supported, true);
});

test('adapter replacement restores the old object and decorates the new object', async t => {
  const app = setup(t);
  const old = app.adapter, replacement = new FakeAdapter();
  for (const provider of [...app.ctx.llm.adapters.keys()]) app.ctx.llm.adapters.set(provider, { adapter: replacement });
  app.emit();
  assert.equal(Object.hasOwn(old, 'streamWithSnapshot'), false);
  assert.equal(Object.hasOwn(replacement, 'streamWithSnapshot'), true);
  assert.equal((await app.rpc('get')).value.supported, true);
});

for (const args of [{ provider: '' }, { provider: undefined }, { model: null }, { sessionId: '' }, { provider: 'x'.repeat(513) }]) {
  test('invalid RPC selection is rejected: ' + JSON.stringify(args), async t => {
    const app = setup(t);
    assert.equal((await app.rpc('get', args)).ok, false);
    assert.equal(existsSync(app.speedPath), false);
  });
}

for (const args of [{ provider: 'does-not-exist' }, { model: 'claude-sonnet' }, { model: 'gpt-image-2' }]) {
  test('unknown provider or non-GPT model cannot change speed: ' + JSON.stringify(args), async t => {
    const app = setup(t);
    assert.equal((await app.rpc('get', args)).value.supported, false);
    assert.equal((await app.rpc('set', { ...args, fast: true })).ok, false);
    assert.equal(existsSync(app.speedPath), false);
  });
}

test('non-boolean fast choices and mismatched RPC envelopes are rejected', async t => {
  const app = setup(t);
  assert.equal((await app.rpc('set', { fast: 'true' })).ok, false);
  assert.equal((await app.rpc('set', { fast: true }, { method: 'other-method' })).ok, false);
  assert.equal(existsSync(app.speedPath), false);
});

test('failed persistence leaves the previous in-memory speed choice unchanged', async t => {
  const app = setup(t);
  await app.rpc('set', { fast: true });
  fixtureFs.mkdirSync(app.speedPath + '.tmp');
  assert.equal((await app.rpc('set', { fast: false })).ok, false);
  assert.equal((await app.rpc('get')).value.fast, true);
});

test('catalog loader validates JSON and models and refreshes by content', t => {
  const app = setup(t);
  const load = createCatalogLoader(app.catalogPath);
  const first = load();
  assert.equal(load(), first);
  writeFileSync(app.catalogPath, JSON.stringify({ models: [] }));
  assert.notEqual(load(), first);
  writeFileSync(app.catalogPath, '{}'); assert.throws(load, /models array/);
  writeFileSync(app.catalogPath, '{'); assert.throws(load, SyntaxError);
});
