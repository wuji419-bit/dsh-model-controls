window.__ModuleLoader__.load({ id: 'dsh-model-controls', factory: require => {
  const React = require('react'), h = React.createElement;
  async function rpc(op, sessionId, provider, model, fast) {
    const method = 'model-speed.' + op;
    const response = await fetch('/api/' + method, {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method,
        payload: { args: { sessionId, provider, model, ...(fast === undefined ? {} : { fast }) } } }),
    });
    const body = await response.json();
    if (!body.result?.ok) throw new Error(body.result?.error?.message ?? '速度设置失败');
    return body.result.value;
  }
  const initial = key => ({ key, token: null, fast: null, fastAvailable: true, supported: true, busy: false, error: '' });
  function Controls({ directory, sessionId }) {
    const state = React.useSyncExternalStore(directory.store.subscribe, directory.store.getSnapshot, directory.store.getSnapshot);
    const { provider, model } = state.current ?? {};
    const enabled = typeof provider === 'string' && !!provider && typeof model === 'string' && /^gpt-/i.test(model) && !/image/i.test(model);
    const key = JSON.stringify([sessionId, provider, model]);
    const [status, setStatus] = React.useState(initial(null));
    const view = status.key === key ? status : initial(key);
    React.useEffect(() => {
      const token = { live: true, pending: false };
      setStatus({ ...initial(key), token });
      if (enabled) rpc('get', sessionId, provider, model).then(value => {
        if (token.live) setStatus(previous => previous.token === token ? { ...previous,
          fast: value.fast, fastAvailable: value.fastAvailable !== false, supported: value.supported !== false } : previous);
      }, error => {
        if (token.live) setStatus(previous => previous.token === token ? { ...previous, error: error.message } : previous);
      });
      return () => { token.live = false; };
    }, [sessionId, provider, model, enabled]);
    React.useEffect(() => {
      let live = true;
      directory.load().catch(error => { if (live) setStatus(previous => ({ ...previous, error: error.message })); });
      return () => { live = false; };
    }, [directory]);
    if (!enabled || !view.supported) return null;
    async function toggle() {
      const { token } = view;
      if (!token?.live || token.pending || view.busy || view.fast === null || !view.fastAvailable) return;
      token.pending = true;
      setStatus(previous => previous.token === token ? { ...previous, busy: true, error: '' } : previous);
      try {
        const value = await rpc('set', sessionId, provider, model, !view.fast);
        if (token.live) setStatus(previous => previous.token === token ? { ...previous,
          fast: value.fast, fastAvailable: value.fastAvailable !== false, supported: value.supported !== false } : previous);
      } catch (error) {
        if (token.live) setStatus(previous => previous.token === token ? { ...previous, error: error.message } : previous);
      } finally {
        token.pending = false;
        if (token.live) setStatus(previous => previous.token === token ? { ...previous, busy: false } : previous);
      }
    }
    return h('span', { 'data-model-controls': '', style: { display: 'inline-flex', gap: 6, alignItems: 'center' } },
      h('button', { type: 'button', onClick: toggle, disabled: view.busy || view.fast === null || !view.fastAvailable,
        'aria-pressed': view.fast === true,
        'aria-label': !view.fastAvailable ? '当前模型未声明支持快速模式' : view.fast ? '快速模式已开启，切换为标准' : '标准模式，开启快速模式',
        title: !view.fastAvailable ? '当前模型未声明支持快速模式；保留服务原有模型和推理设置。' : '切换当前模型服务的速度；模型和推理等级不变。快速模式可能增加用量。',
        style: { font: 'inherit', fontSize: 12, border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8,
          padding: '2px 8px', background: 'transparent', color: 'inherit' } },
      view.busy ? '切换中…' : view.fast ? '⚡ 快速' : '⚡ 标准'),
      view.error ? h('span', { role: 'alert', style: { fontSize: 12, color: '#c53030' } }, view.error) : null);
  }
  function Seat(props) { return props.directory ? h(Controls, props) : null; }
  return { inject: ['slots', 'modelDirectories', 'sessions', 'remote', 'remote.session'], apply(ctx) {
    ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
      name: 'conversation.input.right', id: 'model-controls-api-speed', order: 10,
      inject: sessionId => ({ sessionId, directory: ctx.sessions.subagentAddress(sessionId) === undefined
        ? ctx.modelDirectories.directoryFor(sessionId) : undefined }),
    }, Seat));
  } };
} });
