window.__ModuleLoader__.load({
  id: '@local/dsh-backlog',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const ID = '@local/dsh-backlog';
    const codec = { mode: 'strict', typeSymbol: `${ID}#JSON`, create: () => ({ parse: (value) => value }) };
    function contribution() {
      return { package: ID, descriptors: [{
        id: `${ID}#run`, service: 'backlog', namespace: 'backlog', method: 'run',
        invocation: { kind: 'direct' },
        parameters: [{ name: 'request', wire: 'request', source: 'json', codec }], result: codec,
      }] };
    }
    function unwrap(result) {
      if (result?.ok === true) return result.value;
      throw new Error(result?.message || result?.details?.message || 'Backlog request failed. Try refreshing.');
    }
    function formatIdea(item) {
      return `\n\nFollow-up idea (backlog ${item.id}; captured ${item.createdAt}; origin session ${item.originSessionId}):\n${item.text}\n\n`;
    }
    // A selection is not permission to replace it. Collapse to its end before inserting.
    function insertIdea(inputActions, item, span = inputActions.captureInsertion(), onInserted = () => {}) {
      if (!inputActions.insertText(formatIdea(item), { ...span, start: span.end })) {
        throw new Error('Draft is locked or changed. Idea is still held; try pulling again.');
      }
      onInserted();
      inputActions.persistDraft();
    }
    function createModel(call) {
      function receipts(id, values) {
        try {
          const key = `dsh-backlog:inserted:${id}`;
          if (values) globalThis.sessionStorage?.setItem(key, JSON.stringify(values));
          else {
            const parsed = JSON.parse(globalThis.sessionStorage?.getItem(key) || '[]');
            return Array.isArray(parsed) ? parsed.filter((value) => typeof value === 'string') : [];
          }
        } catch { /* In-memory receipts still protect this tab if browser storage is unavailable. */ }
        return [];
      }
      const entries = new Map();
      function get(id) {
        if (!entries.has(id)) entries.set(id, {
          state: { items: [], loaded: false, open: false, capture: false, text: '', captureId: null,
            all: false, history: false, editing: null, editText: '', editRevision: null,
            insertedIds: receipts(id), busy: false, error: '', notice: '' },
          listeners: new Set(),
        });
        return entries.get(id);
      }
      function patch(id, changes) {
        const entry = get(id);
        entry.state = { ...entry.state, ...changes };
        for (const notify of entry.listeners) notify();
      }
      function recordInsertion(id, itemId, active) {
        const ids = get(id).state.insertedIds.filter((value) => value !== itemId);
        if (active) ids.push(itemId);
        receipts(id, ids);
        patch(id, { insertedIds: ids });
      }
      async function request(id, operation, done) {
        if (get(id).state.busy) return false;
        patch(id, { busy: true, error: '', notice: '' });
        try {
          const value = await call({ ...operation, sessionId: id });
          patch(id, { items: value.items, loaded: true, ...(done || {}) });
          return true;
        } catch (error) {
          patch(id, { error: error.message || String(error) });
          return false;
        } finally { patch(id, { busy: false }); }
      }
      return {
        get: (id) => get(id).state, patch,
        subscribe(id, notify) { get(id).listeners.add(notify); return () => get(id).listeners.delete(notify); },
        refresh: (id) => request(id, { op: 'list' }),
        refreshAll: () => Promise.all([...entries.keys()].map((id) => request(id, { op: 'list' }))),
        async save(id) {
          const state = get(id).state;
          if (!state.text.trim() || state.busy) return;
          const itemId = state.captureId || globalThis.crypto.randomUUID();
          patch(id, { captureId: itemId });
          return request(id, { op: 'add', id: itemId, text: state.text },
            { text: '', captureId: null, capture: false, notice: 'Parked. The agent was not interrupted.' });
        },
        edit(id, item) {
          return request(id, { op: 'edit', id: item.id, revision: get(id).state.editRevision, text: get(id).state.editText }, { editing: null, editRevision: null });
        },
        async state(id, item, state) {
          const saved = await request(id, { op: 'state', id: item.id, revision: item.revision, state });
          if (saved) recordInsertion(id, item.id, false);
          return saved;
        },
        async pull(id, item, inputActions) {
          if (get(id).state.busy) return;
          if (get(id).state.insertedIds.includes(item.id)) {
            patch(id, { error: 'This idea was already inserted. Use Mark pulled to retry its status without inserting again.' });
            return;
          }
          // Keep the click-time insertion revision while checking freshness asynchronously.
          const span = inputActions.captureInsertion();
          let inserted = false;
          patch(id, { busy: true, error: '', notice: '' });
          try {
            const latest = await call({ op: 'list', sessionId: id });
            patch(id, { items: latest.items, loaded: true });
            const current = latest.items.find((entry) => entry.id === item.id);
            if (!current || current.revision !== item.revision || current.state !== 'held') {
              throw new Error('Idea changed elsewhere. The list was refreshed; review it before pulling.');
            }
            insertIdea(inputActions, current, span, () => {
              inserted = true;
              recordInsertion(id, item.id, true);
            });
            const saved = await call({ op: 'state', sessionId: id, id: item.id, revision: item.revision, state: 'pulled' });
            recordInsertion(id, item.id, false);
            patch(id, { items: saved.items, notice: 'Added to draft only. Review and send when ready.' });
          } catch (error) {
            patch(id, { error: inserted
              ? 'Added to draft, but could not mark as pulled. Do not pull again; refresh and check the draft.'
              : error.message || String(error) });
          } finally { patch(id, { busy: false }); }
        },
      };
    }
    const S = {
      button: { cursor: 'pointer', border: '1px solid var(--border-color, #8885)', borderRadius: 7,
        padding: '4px 9px', background: 'transparent', color: 'inherit', font: 'inherit', fontSize: 12 },
      panel: { border: '1px solid var(--border-color, #8885)', borderRadius: 10, padding: 12, marginBottom: 8,
        background: 'var(--background-color, Canvas)', color: 'var(--text-color, CanvasText)', fontSize: 13 },
      row: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 7 },
      field: { display: 'block', width: '100%', boxSizing: 'border-box', minHeight: 70, resize: 'vertical',
        margin: '8px 0', padding: 8, border: '1px solid #8886', borderRadius: 6,
        background: 'transparent', color: 'inherit', font: 'inherit' },
      muted: { opacity: 0.65, fontSize: 11 },
    };
    function useModel(model, sessionId) {
      const subscribe = React.useCallback((notify) => model.subscribe(sessionId, notify), [model, sessionId]);
      const snapshot = React.useCallback(() => model.get(sessionId), [model, sessionId]);
      return React.useSyncExternalStore(subscribe, snapshot);
    }
    function button(label, onClick, disabled, extra = {}) {
      return h('button', { type: 'button', style: S.button, onClick, disabled, ...extra }, label);
    }
    function Controls({ model, sessionId }) {
      const state = useModel(model, sessionId);
      React.useEffect(() => {
        model.refresh(sessionId);
        const refresh = () => model.refresh(sessionId);
        window.addEventListener('focus', refresh);
        return () => window.removeEventListener('focus', refresh);
      }, [model, sessionId]);
      const count = state.items.filter((item) => item.state === 'held').length;
      return h('span', { style: S.row, 'data-plugin': ID },
        button('Park', () => model.patch(sessionId, { capture: !state.capture, error: '', notice: '' }), false,
          { title: 'Save an idea without sending a message', 'aria-expanded': state.capture }),
        button(`Backlog · ${state.loaded ? count : '…'}`, () => {
          model.patch(sessionId, { open: !state.open });
          if (!state.open) model.refresh(sessionId);
        }, false, { 'aria-expanded': state.open, title: 'Held workspace ideas — never auto-sent' }),
      );
    }
    function Capture({ model, sessionId, state }) {
      const ref = React.useRef(null);
      React.useEffect(() => { ref.current?.focus(); }, []);
      return h('div', null,
        h('strong', null, 'Park an idea'),
        h('textarea', { ref, style: S.field, 'aria-label': 'Idea to park', placeholder: 'A thought for later…',
          value: state.text, maxLength: 20000, disabled: state.busy,
          onChange: (event) => model.patch(sessionId, { text: event.target.value, captureId: null }),
          onKeyDown: (event) => {
            event.stopPropagation();
            if (event.nativeEvent?.isComposing || event.isComposing || event.keyCode === 229) return;
            if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); model.save(sessionId); }
            if (event.key === 'Escape') { event.preventDefault(); model.patch(sessionId, { capture: false }); }
          },
        }),
        h('div', { style: S.row },
          button(state.busy ? 'Saving…' : 'Save idea', () => model.save(sessionId), state.busy || !state.text.trim()),
          button('Cancel', () => model.patch(sessionId, { capture: false }), state.busy),
        ),
      );
    }
    function Idea({ model, sessionId, state, item, inputActions }) {
      const editing = state.editing === item.id;
      return h('article', { style: { borderTop: '1px solid #8884', padding: '10px 0' }, 'data-backlog-id': item.id },
        h('div', { style: S.muted }, `${item.state} · ${new Date(item.createdAt).toLocaleString()} · ${item.originSessionId === sessionId ? 'this session' : `session ${item.originSessionId}`}`),
        editing ? h('textarea', { style: S.field, 'aria-label': 'Edit idea', value: state.editText,
          maxLength: 20000, disabled: state.busy, onChange: (e) => model.patch(sessionId, { editText: e.target.value }),
          onKeyDown: (e) => { e.stopPropagation(); if (e.key === 'Escape') model.patch(sessionId, { editing: null }); },
        }) : h('div', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: '6px 0' } }, item.text),
        h('div', { style: S.row }, ...(editing ? [
          button('Save edit', () => model.edit(sessionId, item), state.busy || !state.editText.trim()),
          button('Cancel edit', () => model.patch(sessionId, { editing: null }), state.busy),
        ] : [
          item.state === 'held'
            ? (state.insertedIds.includes(item.id)
              ? button('Mark pulled', () => model.state(sessionId, item, 'pulled'), state.busy)
              : button('Pull into draft', () => model.pull(sessionId, item, inputActions), state.busy))
            : button('Restore to backlog', () => model.state(sessionId, item, 'held'), state.busy),
          button('Edit', () => model.patch(sessionId, { editing: item.id, editText: item.text, editRevision: item.revision }), state.busy),
          item.state !== 'dismissed' ? button('Dismiss', () => model.state(sessionId, item, 'dismissed'), state.busy) : null,
        ])),
      );
    }
    function Dock({ model, sessionId, inputActions }) {
      const state = useModel(model, sessionId);
      if (!state.capture && !state.open && !state.error && !state.notice) return null;
      const visible = state.items.filter((item) => (state.all || item.originSessionId === sessionId) && (state.history || item.state === 'held'));
      return h('section', { style: S.panel, 'data-plugin': ID, 'aria-label': 'Session backlog',
        // Never let Park's Enter/Escape bubble to composer handlers.
        onKeyDown: (e) => e.stopPropagation(),
      },
        state.error ? h('div', { role: 'alert', style: { color: 'var(--color-error, #d65c5c)', marginBottom: 8 } }, state.error,
          button('Refresh', () => model.refresh(sessionId), state.busy)) : null,
        state.notice ? h('div', { role: 'status', style: { marginBottom: 8 } }, state.notice,
          button('Close notice', () => model.patch(sessionId, { notice: '' }), false)) : null,
        state.capture ? h(Capture, { key: sessionId, model, sessionId, state }) : null,
        state.open ? h('div', { style: { marginTop: state.capture ? 12 : 0 } },
          h('div', { style: S.row }, h('strong', null, 'Backlog'),
            h('label', null, h('input', { type: 'checkbox', checked: state.all,
              'aria-label': 'All workspace ideas', onChange: (e) => model.patch(sessionId, { all: e.target.checked, editing: null }) }), ' Workspace'),
            h('label', null, h('input', { type: 'checkbox', checked: state.history,
              'aria-label': 'Include pulled / dismissed', onChange: (e) => model.patch(sessionId, { history: e.target.checked, editing: null }) }), ' History'),
            button('Refresh list', () => model.refresh(sessionId), state.busy),
            button('Close backlog', () => model.patch(sessionId, { open: false }), false),
          ),
          h('div', { style: { maxHeight: 'min(42vh, 360px)', overflowY: 'auto', marginTop: 8 } },
            visible.length ? visible.map((item) => h(Idea, { key: item.id, model, sessionId, state, item, inputActions }))
              : h('p', { style: S.muted }, state.loaded ? 'No ideas.' : 'Loading…'),
          ),
        ) : null,
      );
    }
    function apply(ctx) {
      let remote;
      const model = createModel(async (request) => {
        if (!remote) throw new Error('Backlog is connecting. Try refreshing in a moment.');
        return unwrap(await remote.run(request));
      });
      ctx.effect(() => {
        let disposed = false;
        let face;
        Promise.resolve(ctx.remote.$mount(contribution())).then(() => {
          if (disposed) return;
          face = ctx.inject(['remote.backlog'], (scoped) => {
            remote = scoped.remote.backlog;
            model.refreshAll();
          });
        }).catch((error) => console.error('Backlog remote mount failed', error));
        return () => { disposed = true; remote = undefined; face?.dispose?.(); };
      }, 'backlog: remote');
      ctx.effect(() => ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
        name: 'conversation.input.left', id: 'backlog-controls', order: 45,
      }, (props) => h(Controls, { ...props, model }))), 'backlog: controls');
      ctx.effect(() => ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
        name: 'conversation.input.dock', id: 'backlog-dock', order: 25,
      }, (props) => h(Dock, { ...props, model }))), 'backlog: dock');
    }
    return { inject: ['slots', 'remote'], apply, __internals: { contribution, unwrap, formatIdea, insertIdea, createModel } };
  },
});
