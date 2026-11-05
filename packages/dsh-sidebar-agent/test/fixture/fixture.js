(function () {
  const React = window.React;
  const ReactDOM = window.ReactDOM;
  const h = React.createElement;
  const definition = window.__SA_FIXTURE_DEFINITION__;
  if (definition === undefined) throw new Error('fixture: client module did not register');

  const primitives = {
    MarkdownText: function MarkdownText(props) {
      return h('div', { className: 'fx-md', 'data-md': '1' }, props.text);
    },
    StateDot: function StateDot(props) {
      return h('span', {
        className: 'fx-dot',
        'data-state': props.state,
        style: {
          width: props.size || 10,
          height: props.size || 10,
          color: props.state === 'ongoing' ? 'var(--dsw-alias-label-tertiary)' : 'var(--dsw-alias-state-idle-primary)',
        },
      });
    },
  };

  const client = definition.factory((name) => {
    if (name === 'react') return React;
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives;
    throw new Error(`fixture: unexpected module ${name}`);
  });
  const internals = client.__internals;

  const style = document.createElement('style');
  style.textContent = internals.CSS;
  document.head.append(style);

  const DICT = {
    title: 'Agent', transcript: 'Conversation', loading: 'Starting Agent\u2026',
    'error.start': 'The Agent could not start.', 'error.read': 'Could not read the Agent.',
    'error.file': 'Could not read that file.', 'error.fileSize': 'Files are limited to 10 MB.',
    'error.imageType': 'Paste a PNG, JPEG, WebP, or GIF image.',
    'error.send': 'Could not send the message.', 'action.retry': 'Retry', 'action.send': 'Send',
    'action.stop': 'Stop', 'action.attach': 'Attach files', 'action.remove': 'Remove {name}',
    'action.latest': 'Latest', 'action.latestNew': 'Latest (new content)',
    'state.running': 'Running', 'state.idle': 'Idle', 'state.stopped': 'Stopped',
    'report.open': 'Show delegation report', 'report.close': 'Hide delegation report',
    'report.done': 'Done', 'report.stopped': 'Stopped', 'report.failed': 'Failed',
    'report.blocked': 'Blocked', 'report.interrupted': 'Interrupted', earlier: 'Earlier messages omitted.',
    'tool.error': 'Failed', 'tool.detail': 'Show tool result', 'tool.hide': 'Hide tool result',
    'activity.show': 'Show {count} actions', 'activity.hide': 'Hide {count} actions',
    'activity.failed': '{count} failed', placeholder: 'Message', 'menu.model': 'Model',
    'menu.effort': 'Thinking', 'effort.default': 'Default', 'md.copy': 'Copy', 'md.copied': 'Copied',
    'md.code': 'Code', 'md.wrap': 'Wrap', 'md.unwrap': 'Unwrap', 'md.footnotes': 'Footnotes',
    'status.running': 'Agent running', 'status.stopped': 'Agent stopped', 'status.reply': 'Reply complete',
    'settings.open': 'Settings', 'settings.close': 'Close settings', 'settings.loading': 'Loading settings\u2026',
    'settings.title': 'Title', 'settings.cwd': 'Directory', 'settings.model': 'Model', 'settings.thinking': 'Thinking',
    'settings.save': 'Save', 'settings.saved': 'Saved', 'settings.error.read': 'Could not read settings.',
    'settings.error.save': 'Could not save settings.', 'settings.telegram': 'Telegram',
    'settings.telegram.status': 'Status', 'settings.telegram.target': 'Target', 'settings.telegram.binding': 'Binding',
    'settings.telegram.off': 'Off', 'settings.telegram.inactive': 'Inactive', 'settings.telegram.ready': 'On',
    'settings.telegram.error': 'Error', 'settings.telegram.none': 'None', 'settings.agent': 'Agent',
    'settings.telegram.dm': 'Private DM', 'settings.telegram.adopt': 'Adopt',
    'settings.telegram.adopted': 'Adopted', 'settings.error.adopt': 'Could not adopt that DM.',
  };
  const t = (key, values) => {
    let out = DICT[key] ?? key;
    if (values !== undefined) {
      for (const [name, value] of Object.entries(values)) out = out.split(`{${name}}`).join(String(value));
    }
    return out;
  };
  const ctx = {
    locale: {
      getSnapshot: () => ({ locale: 'en' }),
      subscribe: () => () => {},
      bind: () => t,
    },
  };

  const calls = { chat: [], stop: 0, setModel: [], image: 0, settingsRead: 0, saveSettings: [], telegramAdopt: [] };
  const listeners = new Set();
  const baseData = () => ({
    ready: true, title: 'Agent', online: true, running: false,
    model: { provider: 'fixture', model: 'model-a', reasoningEffort: 'high' },
    streaming: null, messages: [], reports: [], truncated: false, error: null,
  });
  let state = { status: 'ready', data: baseData(), error: null };
  const notify = () => { for (const listener of listeners) listener(); };
  const setState = (next) => { state = next; notify(); };
  const store = {
    getSnapshot: () => state,
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
  };
  const setData = (patch) => {
    setState({ status: 'ready', error: null, data: { ...baseData(), ...(state.data ?? {}), ...patch } });
  };

  let fixtureClock = 0;
  const tick = () => { fixtureClock += 1; return fixtureClock; };
  const user = (id, text) => ({ id, role: 'user', source: 'user', text, time: tick() });
  const assistant = (id, text) => ({ id, role: 'assistant', text, time: tick() });
  const tool = (id, name, summary, result, isError) => ({ id, role: 'tool', name, summary, result, isError: isError === true, time: tick() });

  const longMessages = () => {
    const messages = [];
    for (let index = 0; index < 14; index += 1) {
      messages.push(user(`u${index}`, `Request ${index + 1}: please inspect the fixture transcript.`));
      messages.push(assistant(`a${index}`, `Answer ${index + 1}. This paragraph is deliberately long so the transcript can be scrolled while it is being read. It has several sentences and wraps at the conversation measure.`));
      messages.push(tool(`t${index}-1`, 'bash', 'npm test', 'ok', false));
      messages.push(tool(`t${index}-2`, 'read', 'client.js', 'read 751 lines', false));
      messages.push(tool(`t${index}-3`, 'mcp__playwright-mcp__browser_click', '{"target":"e1"}', 'clicked', false));
    }
    return messages;
  };

  const longText = (prefix, count) => Array.from({ length: count }, (_, index) =>
    `${prefix} ${index + 1}. ${'This sentence exists to make the body tall enough to need its own scroll region. '.repeat(3)}`).join('\n\n');

  const scenarios = {
    empty: () => setData({ messages: [], reports: [], streaming: null, running: false }),
    idle: () => setData({ messages: [user('u1', 'Hello fixture'), assistant('a1', 'Hello. This is the isolated fixture.')], reports: [], streaming: null, running: false }),
    running: () => setData({
      messages: [
        user('u1', 'Run the checks'),
        assistant('a1', 'I will run the checks.'),
        tool('t1', 'bash', 'npm test', '14 passing', false),
        tool('t2', 'read', 'client.js', 'read', false),
        tool('t3', 'grep', 'pattern', '4 matches', true),
      ],
      streaming: 'Streaming fixture reply\u2026', running: true,
    }),
    long: () => setData({ messages: longMessages(), reports: [], streaming: null, running: false }),
    longReport: () => setData({
      messages: [user('u1', 'Read the long report'), assistant('a1', longText('Context paragraph', 12))],
      reports: [{ id: 'report:long', role: 'user', source: 'delegation', text: `[delegation session-long "Long delegation" in ai-stack ended: done]\n${longText('Report paragraph', 60)}`, time: 3 }],
      streaming: null, running: false,
    }),
    longActivity: () => setData({
      messages: [user('u1', 'Run many reads'), ...Array.from({ length: 40 }, (_, index) =>
        tool(`lt${index}`, 'read', `file-${index}.js`, `${'Result text '.repeat(80)}end-${index}`, index === 7))],
      reports: [], streaming: null, running: false,
    }),
    report: () => setData({
      messages: [],
      reports: [{ id: 'report:1', role: 'user', source: 'delegation', text: '[delegation session-abc "Fixture delegation" in ai-stack ended: done]\n## Result\n\nAll checks passed.', time: 2 }],
      streaming: null, running: false,
    }),
    failed: () => { window.__fx.failSend = true; setData({ messages: [user('u1', 'Try again')], reports: [], streaming: null, running: false }); },
    timeline: () => setData({
      messages: [
        { id: 'timeline-last', role: 'assistant', text: 'Last answer.', time: 500 },
        { id: 'timeline-assistant', role: 'assistant', text: 'Second answer.', time: 200 },
        { id: 'timeline-tool', role: 'tool', name: 'read', summary: 'a.js', result: 'read', time: 120 },
        { id: 'timeline-user', role: 'user', text: 'First request.', time: 100 },
      ],
      reports: [
        { id: 'report:repeat', role: 'user', source: 'delegation', text: '[delegation session-a "Repeat" in ai-stack ended: done at 400]\nSame body, later end.', time: 400 },
        { id: 'report:early', role: 'user', source: 'delegation', text: '[delegation session-a "Early" in ai-stack ended: done at 150]\nEarly done.', time: 150 },
        { id: 'report:later', role: 'user', source: 'delegation', text: '[delegation session-b "Later" in ai-stack ended: done at 300]\nLater done.', time: 300 },
      ],
      streaming: null, running: false,
    }),
    loading: () => setState({ status: 'loading', data: null, error: null }),
    error: () => setState({ status: 'error', data: null, error: 'Fixture start failure.' }),
    ready: () => setData({ messages: [], reports: [], streaming: null, running: false }),
  };

  async function chat(request) {
    calls.chat.push(request);
    await new Promise((resolve) => setTimeout(resolve, 10));
    if (window.__fx.failSend) return { ok: false, error: { message: 'Fixture send failed.' } };
    return { ok: true, value: { messageId: `local-${calls.chat.length}` } };
  }
  async function stop() {
    calls.stop += 1;
    return { ok: true, value: { stopped: true } };
  }
  async function catalog() {
    return { ok: true, value: { groups: [{ id: 'fixture', name: 'Fixture provider', models: [
      { id: 'model-a', name: 'Fixture Model A', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } },
      { id: 'model-b', name: 'Fixture Model B', reasoning: null },
    ] }] } };
  }
  async function setModel(request) {
    calls.setModel.push(request);
    setData({ model: { ...request } });
    return { ok: true, value: { model: request } };
  }
  async function image() {
    calls.image += 1;
    return { ok: true, value: { mediaType: 'image/gif', base64: 'R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==' } };
  }

  let settingsRevision = 4;
  function settingsData() {
    return {
      ready: true,
      ns: 'include:sidebar-agent',
      revision: settingsRevision,
      schema: { type: 'object', properties: { title: { type: 'string' }, cwd: { type: 'string' } } },
      values: {
        title: state?.data?.title ?? 'Agent',
        cwd: '/fixture/agent',
        model: state?.data?.model ?? { provider: 'fixture', model: 'model-a', reasoningEffort: 'high' },
      },
      agent: { sessionId: 'agent-fixture', running: false },
      telegram: window.__fx.telegramActive
        ? {
          state: 'ready', enabled: true,
          binding: window.__fx.telegramAdopted ? { kind: 'agent', chatId: 42, threadId: 0 } : { kind: 'none' },
          candidates: window.__fx.telegramAdopted ? [] : [{ key: 'dm:777:42:42', chatId: 42 }],
        }
        : { state: 'off', enabled: false, binding: { kind: 'none' }, candidates: [] },
    };
  }
  async function settings() {
    calls.settingsRead += 1;
    if (window.__fx.failSettingsRead) return { ok: false, error: { message: 'Fixture settings read failed.' } };
    return { ok: true, value: settingsData() };
  }
  async function telegramAdopt(request) {
    calls.telegramAdopt.push(request);
    if (window.__fx.failTelegramAdopt) return { ok: false, error: { message: 'Fixture adoption failed.' } };
    window.__fx.telegramAdopted = true;
    return { ok: true, value: { adopted: true, key: request?.key, chatId: 42 } };
  }
  async function saveSettings(request) {
    calls.saveSettings.push(request);
    if (window.__fx.failSettingsSave) return { ok: false, error: { message: 'Fixture settings save failed.' } };
    if (request.title !== undefined) setData({ title: request.title });
    if (request.provider !== undefined) {
      setData({ model: { provider: request.provider, model: request.model, ...(request.reasoningEffort ? { reasoningEffort: request.reasoningEffort } : {}) } });
    }
    settingsRevision += 1;
    return { ok: true, value: settingsData() };
  }

  function useChat(selector) {
    return selector(React.useSyncExternalStore(store.subscribe, store.getSnapshot));
  }

  let generation = 0;
  const mount = () => root.render(h(internals.AgentChat, {
    key: generation,
    useChat,
    refresh: () => {},
    chat,
    catalog,
    setModel,
    image,
    stop,
    settings,
    saveSettings,
    telegramAdopt,
    ctx,
  }));

  window.__fx = {
    calls, store, scenarios, setData,
    setScenario: (name) => {
      const scenario = scenarios[name];
      if (scenario === undefined) throw new Error(`fixture: unknown scenario ${name}`);
      scenario();
      generation += 1;
      mount();
    },
    reset: () => {
      calls.chat.length = 0; calls.stop = 0; calls.setModel.length = 0; calls.image = 0;
      calls.settingsRead = 0; calls.saveSettings.length = 0; calls.telegramAdopt.length = 0;
      window.__fx.failSend = false;
      window.__fx.failSettingsRead = false;
      window.__fx.failSettingsSave = false;
      window.__fx.failTelegramAdopt = false;
      window.__fx.telegramActive = false;
      window.__fx.telegramAdopted = false;
      settingsRevision = 4;
      setState({ status: 'ready', data: baseData(), error: null });
      generation += 1;
      mount();
    },
    failSend: false,
    failSettingsRead: false,
    failSettingsSave: false,
    failTelegramAdopt: false,
    telegramActive: false,
    telegramAdopted: false,
  };

  const root = ReactDOM.createRoot(document.getElementById('panel'));
  mount();
})();
