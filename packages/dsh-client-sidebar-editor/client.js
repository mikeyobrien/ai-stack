window.__ModuleLoader__.load({
  id: '@local/dsh-client-sidebar-editor',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'sidebarEditor';
    const KIND = 'editor';
    const ID = '@local/dsh-client-sidebar-editor';
    const ADDRESS_PREFIX = 'dsh-resource://file/';

    /** Visible copy; every string the reader renders comes from here, never a literal in the tree. */
    const DICT = {
      'type.label': 'File',
      'empty.title': 'Nothing to show',
      'empty.body': 'This tab has no file address.',
      'loading': 'Opening…',
      'truncated': 'Showing the first screenful of lines only. Open the file in a full editor for the rest.',
      'error.title': 'Could not open this file',
      'error.binary': 'This is not a text file, so there is nothing to show here.',
      'error.tooLarge': 'This file is too large to open in the sidebar.',
      'retry': 'Try again',
      'edit.start': 'Edit',
      'edit.preview': 'Back to preview',
      'edit.save': 'Save',
      'edit.cancel': 'Cancel',
      'edit.saving': 'Saving…',
      'edit.unavailable': 'Saving is unavailable: the write path did not mount.',
      'edit.conflict': 'This file changed on disk while you were editing. Reload it, or keep your text and save again.',
      'edit.failed': 'Could not save this file.',
      'edit.outside': 'This file is outside the session workspace, so it cannot be saved from here.',
      'error.notFile': 'This path is not a file, so there is nothing to open.',
      'note.add': 'Add note',
      'note.placeholder': 'What should change here?',
      'note.stage': 'Stage for next message',
      'note.cancel': 'Cancel',
      'note.staged': 'Note staged',
      'note.dismiss': 'Dismiss',
      'note.singular': 'note',
      'note.plural': 'notes',
      'note.selected': '{n} lines selected',
      'note.fromChat': 'Note the selection',
      'note.chatHint': 'Staged as a note about this message.',
      'note.message': 'message',
    };
    const PAGE_LINES = 5000;
    const RENDER_LINES = 1500;

    /**
     * The file path an address names: the segment after the scope (`session/<id>` or `absolute`) is the
     * path the Remote resolves against the Session's workspace.
     * @param address - a `dsh-resource://file/...` address.
     * @returns the decoded path, or an empty string when the address names no file.
     */
    function pathOf(address) {
      if (typeof address !== 'string' || !address.startsWith(ADDRESS_PREFIX)) return '';
      const parts = address.slice(ADDRESS_PREFIX.length).split('/');
      const scope = parts[0];
      // `session/<sessionId>/<relative path>` reads against that Session's root; `absolute/<path>`
      // names the file directly, and the leading separator is part of the name.
      const rest =
        scope === 'session' ? parts.slice(2).join('/')
        : scope === 'absolute' ? `/${parts.slice(1).join('/')}`
        : parts.slice(1).join('/');
      const path = rest.replace(/\/+$/, '');
      if (!path || path === '/') return '';
      try {
        return decodeURIComponent(path);
      } catch {
        return path;
      }
    }

    /** The last path segment, used as the chip text. */
    function basename(path) {
      const slash = path.lastIndexOf('/');
      return slash < 0 ? path : path.slice(slash + 1);
    }

    /** One readable sentence out of whatever the Remote rejected with. */
    function messageOf(error) {
      if (error && typeof error.message === 'string' && error.message) return error.message;
      if (error && error.details && typeof error.details === 'object') {
        const detail = Object.values(error.details)[0];
        if (typeof detail === 'string') return detail;
      }
      return String(error);
    }

    /**
     * Which copy a rejected read earns. The Remote reports both cases as typed codes, so the panel can
     * say what happened instead of echoing a wire message.
     * @param error - whatever the read rejected with.
     * @returns the dictionary key for the notice.
     */
    function errorKey(error) {
      const code = (error && (error.code || error.type)) || '';
      if (/too-large/.test(code)) return 'error.tooLarge';
      if (/not-text/.test(code)) return 'error.binary';
      if (/not-regular-file/.test(code)) return 'error.notFile';
      return 'error.title';
    }

    /**
     * Unwrap one Remote outcome.
     *
     * Every Remote call resolves to an envelope — `{ok: true, value}` or a failure — so a caller that
     * reads the business value directly would treat a successful save as a failure.
     * @param outcome - the envelope the Remote returned.
     * @returns the business value.
     */
    function unwrap(outcome) {
      if (outcome && outcome.ok === true) return outcome.value;
      const failure = new Error(
        (outcome && outcome.message) || (outcome && outcome.details && outcome.details.message) || 'remote call failed',
      );
      failure.code = outcome && (outcome.code || (outcome.details && outcome.details.code));
      failure.details = outcome && outcome.details;
      throw failure;
    }

    /**
     * Which notice a rejected save earns.
     *
     * A stale write is the interesting one: the Host refused because the file moved under the editor,
     * and the user needs a reload-or-keep choice rather than a generic failure.
     * @param error - whatever the save rejected with.
     * @returns the dictionary key for the banner.
     */
    function saveErrorKey(error) {
      const code = (error && (error.code || error.type)) || '';
      const details = error && error.details ? JSON.stringify(error.details) : '';
      const message = `${messageOf(error)} ${details}`;
      if (/stale|version/i.test(code) || /stale|version/i.test(message)) return 'edit.conflict';
      if (/outside-workspace/.test(message)) return 'edit.outside';
      return 'edit.failed';
    }

    const MAX_DOCUMENTS = 24;

    /**
     * The document cache: one entry per resource address, shared by every view of it.
     *
     * A view subscribes; the entry loads once and keeps its result after the last view leaves, so a
     * remount, a hidden tab or a second pane never refetches or disagrees about the content. The cache
     * evicts the least-recently-opened unsubscribed entry past `MAX_DOCUMENTS`, which bounds memory
     * without ever dropping a document someone is looking at.
     * @returns the store: `watch` for views, `peek`/`size` for tests and diagnostics.
     */
    function createDocuments() {
      const entries = new Map();

      function touch(entry) {
        entries.delete(entry.address);
        entries.set(entry.address, entry);
      }

      function evict() {
        for (const entry of entries.values()) {
          if (entries.size <= MAX_DOCUMENTS) return;
          if (entry.listeners.size === 0) entries.delete(entry.address);
        }
      }

      function publish(entry) {
        for (const listener of entry.listeners) listener(entry.state);
      }

      function load(entry, signal) {
        entry.controller = new AbortController();
        const abort = () => entry.controller && entry.controller.abort();
        if (signal) signal.addEventListener('abort', abort, { once: true });
        entry.state = { status: 'loading' };
        publish(entry);
        Promise.resolve()
          .then(() => entry.read(entry.path, entry.controller.signal))
          // Reads resolve to the same Remote envelope saves do; the page is inside `value`.
          .then(unwrap)
          .then(
            (page) => {
              if (entry.controller.signal.aborted) return;
              entry.state = { status: 'ready', text: page.text, lines: page.lines, eof: page.eof, version: page.version };
              publish(entry);
            },
            (error) => {
              if (entry.controller.signal.aborted) return;
              entry.state = { status: 'error', key: errorKey(error), message: messageOf(error) };
              publish(entry);
            },
          );
      }

      return {
        /**
         * Subscribe one view to one address.
         * @param address - the resource address, also the cache key.
         * @param read - how to fetch it, bound to the tab's session.
         * @param path - the path the read takes.
         * @param onState - called with the current state now and on every change.
         * @returns disposer dropping this view; the entry survives it.
         */
        watch(address, path, read, onState) {
          let entry = entries.get(address);
          if (!entry) {
            entry = { address, path, read, state: { status: 'loading' }, listeners: new Set(), controller: null };
            entries.set(address, entry);
            touch(entry);
            load(entry, null);
          }
          entry.listeners.add(onState);
          onState(entry.state);
          evict();
          return () => {
            entry.listeners.delete(onState);
            if (entry.listeners.size === 0 && entry.controller) entry.controller.abort();
          };
        },
        /** The entry's current state, or `undefined` when the address was never opened. */
        peek(address) {
          const entry = entries.get(address);
          return entry ? entry.state : undefined;
        },
        /** Replace one address's state in place, keeping the entry (used after a save lands). */
        adopt(address, next) {
          const entry = entries.get(address);
          if (!entry) return;
          entry.state = next;
          publish(entry);
        },
        /** Re-open a cached address, bypassing the cache (a manual retry). */
        reload(address) {
          const entry = entries.get(address);
          if (entry) load(entry, null);
        },
        get size() {
          return entries.size;
        },
      };
    }

    /**
     * Declare the Client's view of the Host write path.
     *
     * The namespace is ours and the wire is JSON both ways, so the descriptor is written by hand with
     * `src-json` codecs instead of being generated from a TypeScript face.
     * @returns the mounted contribution's disposer.
     */
    function jsonCodec(typeSymbol) {
      // The Client refuses to mount a contribution whose inputs have no strict codec, so the codec is
      // declared strict and parses JSON as JSON: this face's wire is our own object, and the Host side
      // does the meaningful validation (version required, containment, staleness).
      return { mode: 'strict', typeSymbol, create: () => ({ parse: (value) => value }) };
    }

    function saveContribution() {
      return {
        package: ID,
        descriptors: [
          {
            id: `${ID}#save`,
            service: 'sidebarEditor',
            namespace: 'sidebarEditor',
            method: 'save',
            invocation: { kind: 'direct' },
            parameters: [
              { name: 'request', wire: 'request', source: 'json', codec: jsonCodec(`${ID}#SaveRequest`) },
            ],
            result: jsonCodec(`${ID}#SaveResult`),
          },
        ],
      };
    }

    /** How much of the selection travels inside the note; the rest stays in the file. */
    const MAX_QUOTE = 600;

    /**
     * One staged note: what it points at, the quote it carries, and what the user wants done.
     *
     * A note is a snapshot, never a live reference. The quote travels with it so the message is correct
     * even if the file changed under the note; the anchor is metadata for reopening, not for resolution.
     * @param input - the captured selection and the note body.
     * @returns the note record.
     */
    function makeNote(input) {
      const { sessionId, kind = 'file', address, path, anchor, startLine, endLine, quote, body } = input;
      return {
        id: `note-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        sessionId,
        kind,
        address,
        path,
        anchor,
        startLine,
        endLine,
        quote,
        body,
        createdAt: Date.now(),
      };
    }

    /**
     * Render one note as the text that goes into the draft.
     * @param note - the staged note.
     * @returns a markdown blockquote plus the ask, which the model reads as ordinary message text.
     */
    /**
     * Human-readable provenance for a chat note. Row keys look like `14:assistant-step20:8`
     * (turn, role, internal step); only the turn and role mean anything to a reader or the model.
     */
    function messageWhere(anchor) {
      const match = /^(\d+):(user|assistant)/.exec(String(anchor ?? ''));
      if (!match) return 're: a message in this conversation';
      return `re: the ${match[2] === 'user' ? 'user' : 'assistant'} message in turn ${match[1]}`;
    }

    /**
     * Where a note points, in words a model reads without guessing.
     *
     * A rendered preview (markdown, HTML) has no source lines to name, so its notes say `selection in`
     * rather than inventing a range.
     * @param note - the staged note.
     * @returns the provenance line.
     */
    function noteWhere(note) {
      if (note.kind === 'message') return messageWhere(note.anchor);
      if (note.startLine == null || note.endLine == null) return `selection in ${note.path}`;
      return note.startLine === note.endLine
        ? `line ${note.startLine} of ${note.path}`
        : `lines ${note.startLine}-${note.endLine} of ${note.path}`;
    }

    function formatNote(note) {
      const where = noteWhere(note);
      const quoted = note.quote
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n');
      return `${where}\n${quoted}\n\nnote: ${note.body}`;
    }

    /**
     * The session-scoped note tray: the panel writes, the composer reads.
     *
     * Both halves live in this one plugin, so a shared object is enough; the store only has to notify
     * subscribers so a controlled component re-renders when a note arrives from the other surface.
     * @returns the store: `add`, `remove`, `list`, `subscribe`.
     */
    function createNotes() {
      const bySession = new Map();
      const listeners = new Set();
      function bucket(sessionId) {
        let list = bySession.get(sessionId);
        if (!list) {
          list = [];
          bySession.set(sessionId, list);
        }
        return list;
      }
      function publish(sessionId) {
        for (const listener of listeners) listener(sessionId);
      }
      return {
        add(note) {
          bucket(note.sessionId).push(note);
          publish(note.sessionId);
          return note;
        },
        remove(sessionId, id) {
          const list = bucket(sessionId);
          const index = list.findIndex((note) => note.id === id);
          if (index < 0) return false;
          list.splice(index, 1);
          publish(sessionId);
          return true;
        },
        list(sessionId) {
          return bucket(sessionId).slice();
        },
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
    }

    /**
     * The pending text selection, from anywhere in the page.
     *
     * The transcript belongs to the shell, so the capture is a document listener that only accepts a
     * selection inside a chat row (the shell marks rows with `data-chat-anchor-key`). The same tray and
     * the same staging path then serve both surfaces.
     * @returns the selection store.
     */
    function createSelection() {
      const listeners = new Set();
      let current = null;
      const publish = () => {
        for (const listener of listeners) listener(current);
      };
      return {
        get: () => current,
        set(next) {
          current = next;
          publish();
        },
        clear() {
          if (current === null) return;
          current = null;
          publish();
        },
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
    }

    /** Anchor a compact popover to the selection; flip and clamp at viewport edges. */
    function popoverPosition(rect, width, height, viewportWidth, viewportHeight) {
      const gap = 8;
      const top = rect.bottom + gap + height <= viewportHeight - gap
        ? rect.bottom + gap : Math.max(gap, rect.top - height - gap);
      return {
        left: Math.max(gap, Math.min(rect.left, viewportWidth - width - gap)),
        top,
      };
    }

    /** The popover body: quote, note field, Add. Rendered by whichever surface owns the selection. */
    function NotePopover(props) {
      const { pending, sessionId, notes, selections } = props;
      const [body, setBody] = React.useState('');
      const [expanded, setExpanded] = React.useState(false);
      const ref = React.useRef(null);
      const input = React.useRef(null);
      const returnFocus = React.useRef(null);

      React.useEffect(() => {
        setBody('');
        setExpanded(false);
      }, [pending]);
      React.useEffect(() => {
        if (expanded) input.current?.focus({ preventScroll: true });
      }, [expanded]);
      React.useEffect(() => {
        const outside = (event) => {
          if (!ref.current?.contains(event.target)) selections.clear();
        };
        const escape = (event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          selections.clear();
          returnFocus.current?.focus?.({ preventScroll: true });
        };
        const scroll = (event) => {
          if (!ref.current?.contains(event.target)) selections.clear();
        };
        document.addEventListener('pointerdown', outside, true);
        document.addEventListener('keydown', escape, true);
        document.addEventListener('scroll', scroll, true);
        window.addEventListener('resize', selections.clear);
        return () => {
          document.removeEventListener('pointerdown', outside, true);
          document.removeEventListener('keydown', escape, true);
          document.removeEventListener('scroll', scroll, true);
          window.removeEventListener('resize', selections.clear);
        };
      }, [selections]);

      if (!pending || !pending.rect) return null;
      const width = expanded ? Math.min(304, window.innerWidth - 16) : 112;
      const position = popoverPosition(pending.rect, width, expanded ? 188 : 36, window.innerWidth, window.innerHeight);
      const stage = () => {
        if (!body.trim()) return;
        notes.add(makeNote({ ...pending, sessionId, body: body.trim() }));
        selections.clear();
        setBody('');
      };
      const ghost = {
        border: 0, borderRadius: 'var(--dsw-radius-sm)', background: 'transparent',
        color: 'var(--dsw-alias-label-primary)', cursor: 'pointer',
        font: 'inherit', padding: '4px 8px',
      };
      const primary = {
        ...ghost, height: 28, padding: '0 12px', borderRadius: 'var(--dsw-radius-md)',
        background: 'var(--dsw-alias-button-primary-fill)',
        color: 'var(--dsw-alias-label-primary-foreground)', fontWeight: 500,
      };
      return h('div', {
        ref, 'data-sidebar-note-popover': '', role: expanded ? 'dialog' : 'toolbar',
        'aria-label': expanded ? 'Add a note about the selection' : 'Selection actions',
        style: {
          position: 'fixed', ...position, zIndex: 1000, width, boxSizing: 'border-box',
          padding: expanded ? 10 : 2, borderRadius: 'var(--dsw-radius-lg)',
          border: '0.5px solid var(--dsw-alias-border-l2)',
          background: 'var(--dsw-alias-bg-overlay)', color: 'var(--dsw-alias-label-primary)',
          boxShadow: '0 6px 24px color-mix(in srgb, var(--dsw-alias-border-l3) 60%, transparent)',
          fontFamily: 'var(--dsw-font-family)', fontSize: 13, lineHeight: '20px',
        },
      }, expanded ? h(React.Fragment, null,
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 } },
          h('span', { style: { fontWeight: 500 } }, 'Note'),
          h('button', { type: 'button', 'aria-label': 'Dismiss note', title: 'Dismiss (Esc)',
            onClick: () => { selections.clear(); returnFocus.current?.focus?.({ preventScroll: true }); },
            style: { ...ghost, padding: '0 6px', color: 'var(--dsw-alias-label-secondary)', fontSize: 15 } }, '\u00d7')),
        h('div', { style: { borderLeft: '2px solid var(--dsw-alias-border-l3)', paddingLeft: 8,
          marginBottom: 8, color: 'var(--dsw-alias-label-secondary)', overflow: 'hidden',
          whiteSpace: 'nowrap', textOverflow: 'ellipsis', fontSize: 12,
          fontFamily: 'var(--dsw-font-mono, var(--dsw-font-family))' } }, pending.quote),
        h('textarea', { ref: input, rows: 2, value: body, 'aria-label': 'Note', placeholder: 'What should change?',
          onChange: (event) => setBody(event.target.value),
          onKeyDown: (event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) { event.preventDefault(); stage(); } },
          style: { width: '100%', boxSizing: 'border-box', resize: 'none',
            borderRadius: 'var(--dsw-radius-md)', border: '0.5px solid var(--dsw-alias-border-l1)',
            padding: '7px 8px', font: 'inherit', color: 'var(--dsw-alias-label-primary)',
            background: 'var(--dsw-alias-bg-layer-1)', outline: 'none' } }),
        h('div', { style: { display: 'flex', justifyContent: 'flex-end', marginTop: 8 } },
          h('button', { type: 'button', disabled: !body.trim(), onClick: stage,
            style: { ...primary, opacity: body.trim() ? 1 : 0.45, cursor: body.trim() ? 'pointer' : 'default' } }, 'Add')),
      ) : h('button', {
        type: 'button', onClick: () => { returnFocus.current = document.activeElement; setExpanded(true); },
        style: { ...ghost, width: '100%', fontWeight: 500 },
      }, '+ Add note'));
    }

    /** Subscribe one host to the pending selection. */
    function usePendingSelection(selections) {
      const [pending, setPending] = React.useState(() => selections.get());
      React.useEffect(() => selections.subscribe(setPending), [selections]);
      return pending;
    }

    /** Chat selections: the composer dock, which is where a chat note belongs. */
    function NoteComposer(props) {
      const { sessionId, selections, notes } = props;
      const pending = usePendingSelection(selections);
      if (!pending || pending.kind !== 'message' || !pending.rect) return null;
      if (pending.sessionId && pending.sessionId !== sessionId) return null;
      return h(NotePopover, { pending, sessionId, notes, selections });
    }

    /** File selections: the preview's own toolbar, which is mounted in fullscreen too. */
    function PreviewNoteHost(props) {
      const { sessionId, selections, notes } = props;
      const pending = usePendingSelection(selections);
      if (!pending || pending.kind !== 'file' || !pending.rect) return null;
      return h(NotePopover, { pending, sessionId, notes, selections });
    }

    const S = {
      root: { display: 'flex', flexDirection: 'column', height: '100%', minWidth: 0, minHeight: 0 },
      header: {
        flex: '1 1 auto', minWidth: 0,
        font: 'var(--dsw-font-family)', fontSize: 13,
        color: 'var(--dsw-alias-label-secondary)',
        fontFamily: 'var(--dsw-font-family-code, var(--dsw-font-family))',
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', direction: 'rtl', textAlign: 'left',
      },
      body: { flex: '1 1 auto', overflow: 'auto', minHeight: 0, minWidth: 0, padding: '4px 0 12px' },
      notice: {
        margin: '8px 16px', padding: '10px 12px', borderRadius: 'var(--dsw-radius-md)',
        background: 'var(--dsw-alias-bg-layer-1)',
        font: 'var(--dsw-font-family)', fontSize: 13, lineHeight: 1.5, color: 'var(--dsw-alias-label-secondary)',
      },
      code: {
        fontFamily: 'var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
        fontSize: 'var(--dsh-content-font-size-secondary, 13px)',
        lineHeight: '1.5', tabSize: 4, margin: 0,
      },
      row: { display: 'flex', alignItems: 'flex-start' },
      num: {
        flex: '0 0 auto', width: '3.5ch', textAlign: 'right', padding: '0 8px 0 6px',
        color: 'var(--dsw-alias-label-caption)', userSelect: 'none',
        fontVariantNumeric: 'tabular-nums',
      },
      line: { flex: '1 1 auto', minWidth: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', wordBreak: 'break-word' },
      stageButton: {
        display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: 999,
        cursor: 'pointer', border: '0.5px solid var(--dsw-alias-border-l2)',
        background: 'transparent', color: 'var(--dsw-alias-label-primary)',
        font: 'var(--dsw-font-family)', fontSize: 13, lineHeight: '20px',
      },
      composer: {
        flex: '0 0 auto', borderTop: '0.5px solid var(--dsw-alias-border-l1)',
        padding: '10px 16px', display: 'flex', flexDirection: 'column', gap: 8,
        font: 'var(--dsw-font-family)', fontSize: 13,
      },
      composerHint: { color: 'var(--dsw-alias-label-secondary)' },
      composerRow: { display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'flex-end' },
      textarea: {
        width: '100%', resize: 'vertical', minHeight: 44, boxSizing: 'border-box', padding: '8px 10px',
        borderRadius: 'var(--dsw-radius-md)', border: '0.5px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)',
        font: 'inherit', outline: 'none',
      },
      // Host primary button: brand fill, foreground label, md radius, 36px tall.
      primary: {
        boxSizing: 'border-box', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        height: 36, padding: '0 16px', borderRadius: 'var(--dsw-radius-md)',
        border: '1px solid transparent', cursor: 'pointer', fontWeight: 500,
        background: 'var(--dsw-alias-button-primary-fill)',
        color: 'var(--dsw-alias-label-primary-foreground)',
        fontFamily: 'var(--dsw-font-family)', fontSize: 14, lineHeight: '22px',
      },
      // Host secondary button: same geometry, l2 hairline, no fill.
      secondary: {
        boxSizing: 'border-box', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        height: 36, padding: '0 14px', borderRadius: 'var(--dsw-radius-md)',
        border: '0.5px solid var(--dsw-alias-border-l2)', cursor: 'pointer',
        background: 'transparent', color: 'var(--dsw-alias-label-primary)',
        fontFamily: 'var(--dsw-font-family)', fontSize: 14, lineHeight: '22px',
      },
      headerRow: {
        flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 8, paddingLeft: 16, paddingRight: 8,
        borderBottom: '0.5px solid var(--dsw-alias-border-l1)',
      },
      actions: { flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto', padding: '6px 0' },
      editor: {
        flex: '1 1 auto', minHeight: 0, width: '100%', boxSizing: 'border-box', resize: 'none',
        padding: '10px 16px', border: 'none', outline: 'none',
        background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)',
        fontFamily: 'var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
        fontSize: 'var(--dsh-content-font-size-secondary, 13px)', lineHeight: 1.5, tabSize: 4, whiteSpace: 'pre-wrap',
      },
      retry: {
        boxSizing: 'border-box', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        height: 36, padding: '0 14px', borderRadius: 'var(--dsw-radius-md)',
        border: '0.5px solid var(--dsw-alias-border-l2)', cursor: 'pointer',
        background: 'transparent', color: 'var(--dsw-alias-label-primary)',
        fontFamily: 'var(--dsw-font-family)', fontSize: 14, lineHeight: '22px',
      },
    };

    function Notice({ children }) {
      return h('div', { style: S.notice }, children);
    }

    /** The seat's tab record, whichever way the slot offers it. */
    function tabOf(props) {
      if (typeof props.useTabInfo === 'function') {
        const info = props.useTabInfo();
        if (info && info.tab) return info.tab;
      }
      return props.tab;
    }

    /** Fallbacks so a seat that omits a prop degrades to an empty panel rather than a thrown render. */
    const FALLBACK_DOCUMENTS = createDocuments();
    const FALLBACK_NOTES = createNotes();

    function Body(props) {
      try {
        return BodyView(props);
      } catch (error) {
        console.error('sidebar-editor body failed :: ' + String(error && error.stack ? error.stack : error).replace(/\n/g, ' | '));
        return h(Notice, null, `Reader failed: ${error && error.message ? error.message : error}`);
      }
    }

    function BodyView(props) {
      const readFile = typeof props.readFile === 'function' ? props.readFile : async () => ({ text: '', lines: 0, eof: true });
      const documents = props.documents && typeof props.documents.peek === 'function' ? props.documents : FALLBACK_DOCUMENTS;
      const notes = props.notes && typeof props.notes.list === 'function' ? props.notes : FALLBACK_NOTES;
      const t = typeof props.t === 'function' ? props.t : (key) => DICT[key] || key;
      const saveFile = props.transport && props.transport.save;
      const tab = tabOf(props);
      const address = tab && tab.contentId ? tab.contentId : '';
      const path = pathOf(address);
      const [state, setState] = React.useState(() => documents.peek(address) || { status: 'loading' });
      const [editing, setEditing] = React.useState(false);
      const [draft, setDraft] = React.useState('');
      const [saving, setSaving] = React.useState(false);
      const [saveError, setSaveError] = React.useState(null);
      const [pending, setPending] = React.useState(null);
      const [body, setBody] = React.useState('');
      const readRef = React.useRef(readFile);
      readRef.current = readFile;
      const started = React.useRef(null);
      React.useEffect(() => {
        if (started.current === address || state.status !== 'ready' || !saveFile) return;
        started.current = address;
        setDraft(state.text);
        setEditing(true);
      }, [address, state, saveFile]);

      // A selection inside the code area becomes a candidate note: the line range and the quote are
      // snapshotted here, so later edits to the file cannot move what the note points at.
      const beginEdit = () => {
        if (!saveFile || state.status !== 'ready') return;
        setDraft(state.text);
        setSaveError(null);
        setEditing(true);
      };

      const cancelEdit = () => {
        setEditing(false);
        setDraft('');
        setSaveError(null);
      };

      const save = () => {
        if (!saveFile || saving) return;
        setSaving(true);
        setSaveError(null);
        saveFile({ sessionId: props.sessionId, path, text: draft, version: state.version })
          .then(unwrap)
          .then((result) => {
            setSaving(false);
            setEditing(false);
            documents.adopt(address, { status: 'ready', text: result.after, lines: 0, eof: true, version: result.version });
          })
          .catch((error) => {
            setSaving(false);
            setSaveError(saveErrorKey(error));
          });
      };

      const onSelect = () => {
        const selection = window.getSelection && window.getSelection();
        if (!selection || selection.isCollapsed) return;
        const text = selection.toString();
        if (!text.trim()) return;
        const rows = [];
        for (let index = 0; index < selection.rangeCount; index += 1) {
          const range = selection.getRangeAt(index);
          const rowOf = (node) => {
            const element = node && (node.nodeType === 1 ? node : node.parentElement);
            return element && element.closest ? element.closest('[data-line]') : null;
          };
          const start = rowOf(range.startContainer);
          const end = rowOf(range.endContainer);
          if (start) rows.push(Number(start.getAttribute('data-line')) || 0);
          if (end) rows.push(Number(end.getAttribute('data-line')) || 0);
        }
        if (rows.length === 0) return;
        setPending({
          startLine: Math.min(...rows),
          endLine: Math.max(...rows),
          quote: text.length > MAX_QUOTE ? `${text.slice(0, MAX_QUOTE)}\n…` : text,
        });
        setBody('');
      };

      const stage = () => {
        if (!pending || !body.trim()) return;
        notes.add(makeNote({
          sessionId: props.sessionId,
          address,
          path,
          startLine: pending.startLine,
          endLine: pending.endLine,
          quote: pending.quote,
          body: body.trim(),
        }));
        setPending(null);
        setBody('');
      };

      React.useEffect(() => {
        if (!path) return undefined;
        // The cache owns the fetch: a second view of this address joins it instead of reading again.
        return documents.watch(address, path, (target, signal) => readRef.current(target, signal), setState);
      }, [address, path, documents]);

      let content;
      if (!path) {
        content = h(Notice, null, h('strong', null, t('empty.title')), h('div', null, t('empty.body')));
      } else if (state.status === 'loading') {
        content = h(Notice, null, t('loading'));
      } else if (state.status === 'error') {
        content = h(
          Notice,
          null,
          h('strong', null, t(state.key || 'error.title')),
          h('div', { style: { marginTop: 4 } }, state.message),
          h('button', {
            type: 'button',
            onClick: () => documents.reload(address),
            style: S.retry,
          }, t('retry')),
        );
      } else {
        const lines = state.text.split('\n');
        const shown = lines.length > RENDER_LINES ? lines.slice(0, RENDER_LINES) : lines;
        content = [
          h(
            'pre',
            { key: 'code', style: S.code },
            shown.map((line, index) =>
              h(
                'div',
                { key: index, style: S.row },
                h('span', { style: S.num, 'aria-hidden': true }, String(index + 1)),
                h('span', { style: S.line }, line.length ? line : ' '),
              ),
            ),
          ),
          !state.eof || lines.length > RENDER_LINES
            ? h(Notice, { key: 'truncated' }, t('truncated'))
            : null,
        ];
      }

      const composer = pending
        ? h(
            'div',
            { style: S.composer },
            h('div', { style: S.composerHint }, t('note.selected').replace('{n}', String(pending.endLine - pending.startLine + 1))),
            h('textarea', {
              style: S.textarea,
              value: body,
              rows: 2,
              placeholder: t('note.placeholder'),
              onChange: (event) => setBody(event.target.value),
            }),
            h(
              'div',
              { style: S.composerRow },
              h('button', { type: 'button', style: S.secondary, onClick: () => { setPending(null); setBody(''); } }, t('note.cancel')),
              h('button', { type: 'button', style: { ...S.primary, opacity: body.trim() ? 1 : 0.45 }, onClick: stage, disabled: !body.trim() }, t('note.stage')),
            ),
          )
        : null;

      return h(
        'div',
        { style: S.root },
        path
          ? h(
              'div',
              { style: S.headerRow },
              h('div', { style: S.header, title: path }, path),
              h(
                'div',
                { style: S.actions },
                editing
                  ? [
                      h('button', { key: 'cancel', type: 'button', style: S.secondary, onClick: cancelEdit }, t('edit.cancel')),
                      h('button', { key: 'save', type: 'button', style: S.primary, onClick: save, disabled: saving }, t(saving ? 'edit.saving' : 'edit.save')),
                    ]
                  : [
                      h('button', { key: 'edit', type: 'button', style: S.retry, onClick: beginEdit, disabled: !saveFile || state.status !== 'ready' }, t('edit.start')),
                      props.backToPreview ? h('button', { key: 'preview', type: 'button', style: S.retry, onClick: () => props.backToPreview(address) }, t('edit.preview')) : null,
                    ],
              ),
            )
          : null,
        saveError ? h(Notice, null, h('strong', null, t(saveError)), saveError === 'edit.unavailable' ? null : null) : null,
        editing
          ? h('textarea', {
              style: S.editor,
              value: draft,
              spellCheck: false,
              onChange: (event) => setDraft(event.target.value),
              onKeyDown: (event) => {
                if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
                  event.preventDefault();
                  save();
                }
                if (event.key === 'Escape') {
                  event.preventDefault();
                  cancelEdit();
                }
              },
            })
          : h('div', { style: S.body, onMouseUp: onSelect }, content),
        composer,
      );
    }

    /**
     * The composer-side half: it is the only surface that can reach the draft, so it turns staged
     * notes into message text at the caret. It renders nothing while the tray is empty.
     */
    function NoteStager(props) {
      const { sessionId, inputActions, notes } = props;
      const t = typeof props.t === 'function' ? props.t : (key) => key;
      const [items, setItems] = React.useState(() => notes.list(sessionId));

      React.useEffect(
        () => notes.subscribe((changed) => {
          if (!changed || changed === sessionId) setItems(notes.list(sessionId));
        }),
        [notes, sessionId],
      );

      const stage = React.useCallback(() => {
        const pending = notes.list(sessionId);
        if (pending.length === 0) return;
        const span = inputActions.captureInsertion();
        const block = pending.map(formatNote).join('\n\n') + '\n\n';
        if (!inputActions.insertText(block, span)) return;
        for (const note of pending) notes.remove(sessionId, note.id);
      }, [notes, sessionId, inputActions]);

      // Staging means "rides the next message": move every staged note into the draft as soon as it
      // lands, so sending without an extra click still carries it. The chip below only remains when
      // the composer refused the insert (e.g. locked mid-submit), as a manual retry.
      React.useEffect(() => {
        if (items.length > 0) stage();
      }, [items, stage]);

      if (items.length === 0) return null;

      const label = items.length === 1 ? t('note.singular') : t('note.plural');
      return h(
        'button',
        {
          type: 'button',
          style: S.stageButton,
          onClick: stage,
          title: t('note.stage'),
        },
        `${items.length} ${label}`,
      );
    }

    function Title(props) {
      const tab = tabOf(props);
      const address = tab && tab.contentId ? tab.contentId : '';
      const name = basename(pathOf(address));
      return h('span', null, name || props.t('type.label'));
    }

    /**
     * The tab type: an outside-product reader, so it outranks the shipped preview for file addresses
     * (the registry's `extension` band) and any address it does not veto still reaches that preview.
     */
    /** Extensions the shipped preview renders better than a text reader ever will. */
    const NOT_TEXT = /\.(pdf|png|jpe?g|gif|webp|avif|bmp|ico|svg|mp4|webm|mov|mp3|wav|ogg|flac|zip|gz|tar|tgz|br|7z|rar|docx?|xlsx?|pptx?|odt|ods|odp|woff2?|ttf|otf|eot|wasm|exe|dll|so|dylib|class|jar|bin|dat|sqlite|db)$/i;

    function definition(t) {
      return {
        id: ID,
        kind: KIND,
        // Never replace the shipped document viewer (including its syntax highlighting).
        // Its fallback file URI pattern is more specific than '*', so it wins default opens.
        // This editor remains a candidate for explicit "Open with" selection.
        priority: 'fallback',
        patterns: ['*'],
        // Keep binaries out even when this editor is explicitly chosen.
        canOpen: (address) => !NOT_TEXT.test(pathOf(address)),
        title: (address) => basename(pathOf(address)) || t('type.label'),
      };
    }

    const inject = ['slots', 'locale', 'sidebarRightTabs', 'sidebarRight', 'remote', 'remote.workspaceFiles'];

    /** Open an editor explicitly, without taking over default preview routing. */
    function editAddress(absolutePath) {
      if (typeof absolutePath !== 'string' || !absolutePath.startsWith('/')) return '';
      return `${ADDRESS_PREFIX}absolute/${absolutePath.slice(1).split('/').map(encodeURIComponent).join('/')}`;
    }

    function PreviewEditButton(props) {
      const address = editAddress(props.absolutePath);
      if (!address || NOT_TEXT.test(props.absolutePath)) return null;
      return h('button', {
        type: 'button', 'aria-label': 'Edit file', title: 'Edit file',
        onClick: () => props.openEditor(address, props.sessionId),
        style: {
          boxSizing: 'border-box', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          height: 26, padding: '0 10px', borderRadius: 'var(--dsw-radius-md)', cursor: 'pointer',
          border: '0.5px solid var(--dsw-alias-border-l3)', background: 'transparent',
          color: 'var(--dsw-alias-label-primary)',
          fontFamily: 'var(--dsw-font-family)', fontSize: 13, lineHeight: '18px', whiteSpace: 'nowrap',
        },
      }, props.t ? props.t('edit.start') : 'Edit');
    }

    function apply(ctx) {
      const t = ctx.locale.bind(NS);
      const documents = createDocuments();
      const notes = createNotes();
      const selections = createSelection();
      // The Client's typed view of the Host write path arrives asynchronously; the holder means a
      // reader that renders before it lands simply shows the Edit action disabled.
      const transport = { save: undefined };
      ctx.effect(() => {
        let disposed = false;
        let face = null;
        Promise.resolve(ctx.remote.$mount(saveContribution()))
          .then(() => {
            if (disposed) return;
            // Cordis refuses to read a service a fiber has not injected, so the namespace is read
            // inside a derived context that declares it — the mount, not the plugin, brings it into
            // existence.
            face = ctx.inject(['remote.sidebarEditor'], (scoped) => {
              transport.save = (request) => scoped.remote.sidebarEditor.save(request);
            });
          })
          .catch(() => {
            transport.save = undefined;
          });
        return () => {
          disposed = true;
          transport.save = undefined;
          if (face && typeof face.dispose === 'function') face.dispose();
        };
      }, 'sidebar-editor: remote face');

      ctx.effect(() => ctx.locale.register(NS, 'en', DICT), 'sidebar-editor: copy');
      ctx.effect(() => ctx.sidebarRightTabs.register(definition(t)), 'sidebar-editor: type registration');
      const openEditor = (address, sessionId) => {
        if (ctx.sidebarRight.mounted.getSnapshot() !== sessionId) return;
        ctx.sidebarRight.openResource(address, { kind: KIND });
      };
      ctx.effect(() => ctx.slots.inject('sidebar.right.tab.document.actions', () =>
        ctx.slots.register({ name: 'sidebar.right.tab.document.actions', id: 'sidebar-editor-edit', order: 10, locale: NS },
          (props) => h(React.Fragment, null,
            h(PreviewEditButton, { ...props, openEditor }),
            // The toolbar is mounted wherever the preview is, fullscreen included, so the note
            // popover for file selections lives here rather than in the composer dock.
            h(PreviewNoteHost, { sessionId: props.sessionId, selections, notes })))),
        'sidebar-editor: preview edit button');
      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.right.pane.tab', () =>
            ctx.slots.register({ name: 'sidebar.right.pane.tab', key: ID, locale: NS, inject: readFace(ctx, documents, notes, transport) }, Body),
          ),
        'sidebar-editor: tab body',
      );
      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.right.pane.tab.title', () =>
            ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: ID, locale: NS }, Title),
          ),
        'sidebar-editor: tab title',
      );
      // The transcript is the shell's DOM: capture selections with one document listener, and keep
      // only the ones that land inside a chat row.
      ctx.effect(() => {
        if (typeof document === 'undefined') return () => {};
        const clip = (text) => (text.length > MAX_QUOTE ? `${text.slice(0, MAX_QUOTE)}\n…` : text);
        const elementOf = (node) => (node && (node.nodeType === 1 ? node : node.parentElement));

        /** A selection inside one chat row: the row's anchor is the note's provenance. */
        const chatCapture = (selection, text) => {
          const element = elementOf(selection.anchorNode);
          const row = element?.closest?.('[data-chat-anchor-key]');
          if (!row) return null;
          // Do not misattribute a selection spanning multiple messages to the first row.
          if (elementOf(selection.focusNode)?.closest('[data-chat-anchor-key]') !== row) return null;
          const sessionId = row.closest('[data-conversation-session]')?.getAttribute('data-conversation-session');
          if (!sessionId) return null;
          return { sessionId, kind: 'message', anchor: row.getAttribute('data-chat-anchor-key'), quote: clip(text) };
        };

        /**
         * A selection inside a shipped preview.
         *
         * The preview carries its own address on `data-textpreview-url`, so a note points at the file
         * without asking which tab is active. Plain text exposes `data-textpreview-line` (0-based);
         * a rendered preview (markdown, HTML) has no source lines, so the note says `selection in`.
         */
        const previewCapture = (selection, text) => {
          const preview = elementOf(selection.anchorNode)?.closest?.('[data-textpreview-url]');
          if (!preview) return null;
          if (elementOf(selection.focusNode)?.closest('[data-textpreview-url]') !== preview) return null;
          const address = preview.getAttribute('data-textpreview-url') || '';
          const path = pathOf(address);
          if (!path) return null;
          const lineOf = (node) => {
            const row = elementOf(node)?.closest?.('[data-textpreview-line]');
            if (!row) return null;
            const number = Number(row.getAttribute('data-textpreview-line'));
            return Number.isFinite(number) ? number + 1 : null;
          };
          const range = selection.getRangeAt(0);
          const startLine = lineOf(range.startContainer);
          const endLine = lineOf(range.endContainer);
          const lines = startLine != null && endLine != null
            ? { startLine: Math.min(startLine, endLine), endLine: Math.max(startLine, endLine) }
            : { startLine: null, endLine: null };
          return { sessionId: null, kind: 'file', address, path, ...lines, quote: clip(text) };
        };

        const sameSelection = (a, b) =>
          a.kind === b.kind && a.quote === b.quote &&
          a.anchor === b.anchor && a.address === b.address &&
          a.startLine === b.startLine && a.endLine === b.endLine;

        const onSelection = () => {
          const selection = window.getSelection && window.getSelection();
          if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
          const text = selection.toString().trim();
          if (!text) return;
          if (elementOf(selection.anchorNode)?.closest?.('[data-sidebar-note-popover]')) return;
          const next = chatCapture(selection, text) || previewCapture(selection, text);
          if (!next) return;
          const bounds = selection.getRangeAt(0).getBoundingClientRect();
          if (!bounds.width && !bounds.height) return;
          next.rect = { left: bounds.left, top: bounds.top, bottom: bounds.bottom };
          const current = selections.get();
          if (current && sameSelection(current, next)) return;
          selections.set(next);
        };
        document.addEventListener('mouseup', onSelection);
        document.addEventListener('keyup', onSelection);
        return () => {
          document.removeEventListener('mouseup', onSelection);
          document.removeEventListener('keyup', onSelection);
        };
      }, 'sidebar-editor: chat selection');

      ctx.effect(
        () =>
          ctx.slots.inject('conversation.input.dock', () =>
            ctx.slots.register(
              { name: 'conversation.input.dock', id: 'sidebar-editor-note-composer', order: 20, locale: NS },
              (props) => NoteComposer({ ...props, selections, notes }),
            ),
          ),
        'sidebar-editor: note composer',
      );

      ctx.effect(
        () =>
          ctx.slots.inject('conversation.input.left', () =>
            // The composer seat projects no inject face, so the tray is closed over here instead.
            ctx.slots.register(
              { name: 'conversation.input.left', id: 'sidebar-editor-notes', order: 40, locale: NS },
              (props) => NoteStager({ ...props, notes }),
            ),
          ),
        'sidebar-editor: note stager',
      );
    }

    /** Bind the reader's one Remote call to the Session that owns the tab. */
    function readFace(ctx, documents, notes, transport) {
      return (sessionId) => ({
        documents,
        notes,
        transport,
        backToPreview: (address) => {
          if (ctx.sidebarRight.mounted.getSnapshot() !== sessionId) return;
          ctx.sidebarRight.openResource(address);
        },
        readFile: (path, signal) => ctx.remote.workspaceFiles.read(sessionId, path, { offset: 1, limit: PAGE_LINES }, signal),
      });
    }

    return { inject, apply, __internals: { createDocuments, createNotes, makeNote, formatNote, saveContribution, saveErrorKey, unwrap, pathOf, basename, errorKey, popoverPosition, editAddress, PreviewEditButton, noteWhere } };
  },
});