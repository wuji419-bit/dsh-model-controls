import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const ok = value => ({ result: { ok: true, value } });

// Only the hooks used by the client are simulated; effects run after render,
// preserve their dependencies, and clean up on dependency changes/unmount.
function setup({ current = { provider: 'sub2api', model: 'gpt-6.1-high' },
  respond = () => ok({ fast: false }), load = async () => {}, child = false } = {}) {
  let cursor = 0, tree, props, component, dirty = false, uuid = 0;
  const states = [], effects = [], pending = [], requests = [], slots = [];
  const snapshot = { current };
  const subscribe = () => () => {};
  const getSnapshot = () => snapshot;
  const directory = { store: { subscribe, getSnapshot }, load };
  let directoryLookups = 0, loads = 0;
  directory.load = () => { loads++; return load(); };
  const React = {
    createElement(type, attributes, ...children) {
      return { type, props: attributes ?? {}, children };
    },
    useSyncExternalStore(sub, get, serverGet) {
      assert.equal(sub, subscribe);
      assert.equal(get, getSnapshot);
      assert.equal(serverGet, getSnapshot);
      return get();
    },
    useState(initial) {
      const index = cursor++;
      if (!(index in states)) states[index] = initial;
      return [states[index], value => {
        states[index] = typeof value === 'function' ? value(states[index]) : value;
        dirty = true;
      }];
    },
    useEffect(callback, deps) {
      const index = cursor++;
      const old = effects[index];
      if (!old || deps.some((dep, i) => !Object.is(dep, old.deps[i]))) {
        pending.push(() => {
          old?.cleanup?.();
          effects[index] = { deps, cleanup: callback() };
        });
      }
    },
  };
  let plugin, moduleId;
  vm.runInNewContext(source, {
    window: { __ModuleLoader__: { load({ id, factory }) {
      moduleId = id;
      plugin = factory(name => { assert.equal(name, 'react'); return React; });
    } } },
    crypto: { randomUUID: () => 'test-rpc-' + ++uuid },
    fetch: async (url, options) => {
      const request = { url, ...plain(options), body: JSON.parse(options.body) };
      requests.push(request);
      const body = await respond(request, requests.length);
      return { json: async () => body };
    },
  }, { filename: 'client.js' });
  const ctx = {
    slots: {
      inject(name, callback) { slots.push({ kind: 'inject', name }); callback(); },
      register(config, Seat) { slots.push({ kind: 'register', config, Seat }); },
    },
    sessions: { subagentAddress: () => child ? { parentSessionId: 'parent' } : undefined },
    modelDirectories: { directoryFor(id) {
      assert.equal(id, 'session-1'); directoryLookups++; return directory;
    } },
  };
  plugin.apply(ctx);
  const registration = slots.find(slot => slot.kind === 'register');
  props = registration.config.inject('session-1');
  const seat = registration.Seat(props);
  component = seat?.type;
  function render() {
    if (!component) return tree = null;
    cursor = 0; dirty = false;
    tree = component(props);
    pending.splice(0).forEach(effect => effect());
    return tree;
  }
  async function settle() {
    for (let i = 0; i < 4; i++) {
      await new Promise(resolve => setImmediate(resolve));
      if (dirty) render();
    }
    return tree;
  }
  return {
    moduleId, plugin, slots, registration, props, directory, requests, render, settle,
    get tree() { return tree; }, get loads() { return loads; },
    get directoryLookups() { return directoryLookups; },
    button: () => tree?.children[0], alert: () => tree?.children[1],
    unmount() { effects.forEach(effect => effect?.cleanup?.()); },
    changeCurrent(value) { snapshot.current = value; render(); },
  };
}

function assertRpc(request, operation, fast) {
  assert.equal(request.url, '/api/model-speed.' + operation);
  assert.equal(request.method, 'POST');
  assert.equal(request.credentials, 'same-origin');
  assert.deepEqual(request.headers, { 'content-type': 'application/json' });
  assert.deepEqual(request.body, {
    type: 'client-request', rpcId: request.body.rpcId, method: 'model-speed.' + operation,
    payload: { args: { sessionId: 'session-1', model: 'gpt-6.1-high',
      ...(fast === undefined ? {} : { fast }) } },
  });
  assert.match(request.body.rpcId, /^test-rpc-\d+$/);
}

test('registers the current conversation speed-control slot', () => {
  const app = setup();
  assert.equal(app.moduleId, 'dsh-model-controls');
  assert.deepEqual(plain(app.plugin.inject), ['slots', 'modelDirectories', 'sessions', 'remote', 'remote.session']);
  assert.equal(app.slots[0].name, 'conversation.input.right');
  assert.equal(app.registration.config.name, 'conversation.input.right');
  assert.equal(app.registration.config.id, 'model-controls-api-speed');
  assert.equal(app.registration.config.order, 10);
  assert.equal(app.props.directory, app.directory);
  assert.equal(app.props.sessionId, 'session-1');
});

test('initial load disables the control until the get RPC resolves', async () => {
  const reply = deferred();
  const app = setup({ respond: () => reply.promise });
  app.render();
  assert.equal(app.loads, 1);
  assert.equal(app.button().props.disabled, true);
  await app.button().props.onClick();
  assert.equal(app.requests.length, 1);
  assertRpc(app.requests[0], 'get');
  reply.resolve(ok({ fast: false }));
  await app.settle();
  assert.equal(app.button().props.disabled, false);
  assert.equal(app.button().props['aria-pressed'], false);
  assert.equal(app.button().children[0], '⚡ 标准');
  assert.equal(app.loads, 1);
});

test('initial fast state is displayed from the RPC response', async () => {
  const app = setup({ respond: () => ok({ fast: true }) });
  app.render(); await app.settle();
  assert.equal(app.button().props['aria-pressed'], true);
  assert.equal(app.button().children[0], '⚡ 快速');
});

test('standard/fast toggles use speed RPCs without changing model or reasoning tier', async () => {
  const current = Object.freeze({ provider: 'sub2api', model: 'gpt-6.1-high', reasoningEffort: 'high' });
  const app = setup({ current, respond: request => ok({ fast: request.body.payload.args.fast ?? false }) });
  app.render(); await app.settle();
  await app.button().props.onClick(); await app.settle();
  assert.equal(app.button().props['aria-pressed'], true);
  assert.match(app.button().props['aria-label'], /快速模式已开启/);
  await app.button().props.onClick(); await app.settle();
  assert.equal(app.button().props['aria-pressed'], false);
  assert.match(app.button().props['aria-label'], /标准模式/);
  assert.equal(app.requests.length, 3);
  assertRpc(app.requests[0], 'get'); assertRpc(app.requests[1], 'set', true); assertRpc(app.requests[2], 'set', false);
  assert.equal(new Set(app.requests.map(request => request.body.rpcId)).size, 3);
  assert.deepEqual(current, { provider: 'sub2api', model: 'gpt-6.1-high', reasoningEffort: 'high' });
});

test('pending toggle shows busy state and prevents additional requests', async () => {
  const reply = deferred();
  const app = setup({ respond: (_request, count) => count === 1 ? ok({ fast: false }) : reply.promise });
  app.render(); await app.settle();
  const switching = app.button().props.onClick();
  app.render();
  assert.equal(app.button().props.disabled, true);
  assert.equal(app.button().children[0], '切换中…');
  await app.button().props.onClick();
  assert.equal(app.requests.length, 2);
  reply.resolve(ok({ fast: true }));
  await switching; await app.settle();
  assert.equal(app.button().props.disabled, false);
});

test('get RPC errors are shown as alerts', async () => {
  const app = setup({ respond: () => ({ result: { ok: false, error: { message: '无法读取速度' } } }) });
  app.render(); await app.settle();
  assert.equal(app.alert().props.role, 'alert');
  assert.equal(app.alert().children[0], '无法读取速度');
  assert.equal(app.button().props.disabled, true);
});

test('failed toggle keeps the previous speed, shows an error, and permits retry', async () => {
  const app = setup({ respond: (_request, count) => {
    if (count === 2) throw new Error('网络中断');
    return ok({ fast: count > 2 });
  } });
  app.render(); await app.settle();
  await app.button().props.onClick(); await app.settle();
  assert.equal(app.alert().children[0], '网络中断');
  assert.equal(app.button().props['aria-pressed'], false);
  assert.equal(app.button().props.disabled, false);
  await app.button().props.onClick(); await app.settle();
  assert.equal(app.alert(), null);
  assert.equal(app.button().props['aria-pressed'], true);
});

test('malformed RPC failure uses the client fallback error', async () => {
  const app = setup({ respond: () => ({}) });
  app.render(); await app.settle();
  assert.equal(app.alert().children[0], '速度设置失败');
});

test('directory load errors are shown', async () => {
  const app = setup({ load: async () => { throw new Error('目录不可用'); } });
  app.render(); await app.settle();
  assert.equal(app.alert().children[0], '目录不可用');
});

for (const [name, current] of [
  ['unsupported provider', { provider: 'openai', model: 'gpt-6.1-high' }],
  ['unsupported model', { provider: 'sub2api', model: 'claude-sonnet' }],
  ['image model', { provider: 'sub2api', model: 'gpt-image-1' }],
  ['case-insensitive image model', { provider: 'sub2api', model: 'GPT-IMAGE-2' }],
  ['missing current selection', undefined],
  ['missing model', { provider: 'sub2api' }],
]) {
  test(name + ' hides controls and makes no speed RPC', async () => {
    // Explicitly replace the default selection for the undefined case.
    const app = setup({ current });
    if (current === undefined) app.changeCurrent(undefined);
    else app.render();
    await app.settle();
    assert.equal(app.tree, null);
    assert.equal(app.requests.length, 0);
    assert.equal(app.loads, 1);
  });
}

test('subsessions hide the Seat without loading a directory or issuing RPCs', async () => {
  const app = setup({ child: true });
  assert.equal(app.props.directory, undefined);
  assert.equal(app.directoryLookups, 0);
  app.render(); await app.settle();
  assert.equal(app.tree, null);
  assert.equal(app.loads, 0);
  assert.equal(app.requests.length, 0);
});

test('stale initial response is ignored after switching to an unsupported provider', async () => {
  const reply = deferred();
  const app = setup({ respond: () => reply.promise });
  app.render();
  app.changeCurrent({ provider: 'openai', model: 'gpt-6.1-high' });
  reply.resolve(ok({ fast: true }));
  await app.settle();
  assert.equal(app.tree, null);
  assert.equal(app.requests.length, 1);
  app.unmount();
});
