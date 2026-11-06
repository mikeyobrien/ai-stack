window.__ModuleLoader__.load({
  id: '@local/dsh-artifact-library',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const ID = '@local/dsh-artifact-library';
    const NS = 'artifact-library';
    const PANEL_ID = 'library';
    const EN = {
      meta: { title: 'Artifact Library', description: 'Find and read research, designs, reports and their HTML editions across projects, with pinned items, local search, revisions and origin links.' },
      panel: 'Artifact Library',
      title: 'Library',
      loading: 'Loading…',
      empty: 'Nothing here yet.',
      'error.read': 'The Library could not be read.',
      'error.notfound': 'This artifact is not in the Library.',
      'error.session': 'That session is not available.',
      'action.refresh': 'Refresh',
      'action.refreshing': 'Refreshing…',
      'action.pin': 'Pin',
      'action.unpin': 'Unpin',
      'section.pinned': 'Pinned',
      'section.expected': 'Expected outputs',
      'section.origin': 'Origin',
      'availability.original': 'Original',
      'availability.snapshot': 'Saved copy',
      'availability.missing': 'Original deleted; showing the saved copy',
      'expected.delivered': 'Delivered',
      'expected.notdelivered': 'Not delivered',
      'kind.report': 'Report',
      'kind.design': 'Design',
      'kind.research': 'Research',
      'kind.html': 'HTML',
      'kind.text': 'Text',
      'hint.search': 'Search',
      'hint.project': 'Project',
      'hint.all': 'All projects',
    };

    /**
     * The CSP the reader puts at the top of the sandboxed document. The
     * sandbox itself grants nothing; this policy repeats the refusal so an
     * artifact cannot fetch a remote image, stylesheet, font, frame or script.
     * Data images are allowed because saved HTML reports embed their evidence
     * inline; `style-src` allows the report's own inline presentation only.
     */
    const HTML_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'none'; object-src 'none'; frame-src 'none'; connect-src 'none'; font-src 'none'; media-src 'none'; form-action 'none'; base-uri 'none'";

    const CSP_META = `<meta http-equiv="Content-Security-Policy" content="${HTML_CSP}">`;

    /**
     * Put the CSP in the document head before any artifact markup.
     *
     * The body of an HTML artifact is untrusted, so a regex over a user's
     * `<head>` is not enough: a comment or a malformed document could hide the
     * real head. The reader always opens its own head first (after a doctype,
     * when there is one) and puts the CSP meta there. The browser merges the
     * user's later head into that head, so the report's title and inline styles
     * still work while the policy is guaranteed to be parsed before any user
     * element.
     *
     * @param html - the artifact's saved HTML.
     * @returns the document to hand to `iframe.srcdoc`.
     */
    function sandboxDocument(html) {
      const source = typeof html === 'string' ? html : '';
      const doctype = /^\s*<!doctype[^>]*>/i.exec(source);
      const offset = doctype === null ? 0 : doctype.index + doctype[0].length;
      const prefix = doctype === null ? '' : doctype[0];
      return `${prefix}<head>${CSP_META}</head>${source.slice(offset)}`;
    }

    /** The app's own deep-link form for one session. */
    function sessionHref(sessionId) {
      return `?session=${encodeURIComponent(sessionId)}`;
    }

    /**
     * Refresh the native Session catalog, then open the exact source Session.
     * A missing target throws so the reader can surface the failure instead of
     * silently reopening whichever chat was already selected.
     */
    async function navigateToSession(ctx, sessionId) {
      const sessions = ctx && ctx.sessions;
      const workspace = ctx && ctx.uiWorkspace;
      if (!sessions || typeof sessions.refresh !== 'function') {
        throw new Error('artifact-library: session refresh is unavailable');
      }
      if (!workspace || typeof workspace.openSession !== 'function') {
        throw new Error('artifact-library: session navigation is unavailable');
      }
      await sessions.refresh();
      const snapshot = sessions.list && typeof sessions.list.getSnapshot === 'function' ? sessions.list.getSnapshot() : null;
      const listed = snapshot !== null && Array.isArray(snapshot.ids) && snapshot.ids.includes(sessionId);
      const indexed = snapshot !== null && snapshot.byId !== null && typeof snapshot.byId === 'object' && snapshot.byId[sessionId] !== undefined;
      if (!listed && !indexed) throw new Error(`artifact-library: session ${sessionId} is not available`);
      workspace.openSession(sessionId);
    }

    const codec = { mode: 'strict', typeSymbol: ID + '#JSON', create: () => ({ parse: (value) => value }) };

    function contribution() {
      return {
        package: ID,
        descriptors: [
          { id: ID + '#library', service: 'artifactLibrary', namespace: 'artifactLibrary', method: 'library', invocation: { kind: 'direct' }, parameters: [], result: codec },
          { id: ID + '#search', service: 'artifactLibrary', namespace: 'artifactLibrary', method: 'search', invocation: { kind: 'direct' }, parameters: [{ name: 'request', wire: 'request', source: 'json', codec }], result: codec },
          { id: ID + '#artifact', service: 'artifactLibrary', namespace: 'artifactLibrary', method: 'artifact', invocation: { kind: 'direct' }, parameters: [{ name: 'request', wire: 'request', source: 'json', codec }], result: codec },
          { id: ID + '#setPinned', service: 'artifactLibrary', namespace: 'artifactLibrary', method: 'setPinned', invocation: { kind: 'direct' }, parameters: [{ name: 'request', wire: 'request', source: 'json', codec }], result: codec },
          { id: ID + '#register', service: 'artifactLibrary', namespace: 'artifactLibrary', method: 'register', invocation: { kind: 'direct' }, parameters: [{ name: 'request', wire: 'request', source: 'json', codec }], result: codec },
        ],
      };
    }

    function useTranslate(ctx) {
      const [snapshot, setSnapshot] = React.useState(ctx.locale.getSnapshot());
      React.useEffect(() => ctx.locale.subscribe(() => setSnapshot(ctx.locale.getSnapshot())), [ctx]);
      const t = ctx.locale.bind(NS);
      return (key, values) => {
        void snapshot;
        return values === undefined ? t(key) : t(key, values);
      };
    }

    /**
     * The kind label for an artifact, localized.
     * @param t - the translator.
     * @param artifact - the artifact or search row.
     */
    function kindLabel(t, artifact) {
      const kind = artifact?.kind ?? 'report';
      if (kind === 'design') return t('kind.design');
      if (kind === 'research') return t('kind.research');
      if (artifact?.format === 'html') return t('kind.html');
      if (artifact?.format === 'text' || kind === 'text') return t('kind.text');
      return t('kind.report');
    }

    /**
     * The availability badge for an artifact.
     * @param t - the translator.
     * @param availability - 'original' | 'snapshot' | 'missing'.
     */
    function availabilityLabel(t, availability) {
      if (availability === 'snapshot') return t('availability.snapshot');
      if (availability === 'missing') return t('availability.missing');
      return t('availability.original');
    }

    const styles = {
      page: { boxSizing: 'border-box', height: '100%', color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-base)', fontSize: 14, lineHeight: 1.55, overflow: 'auto' },
      content: { padding: '20px clamp(16px,4vw,40px) 40px' },
      heading: { display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 14 },
      title: { margin: 0, fontSize: 20, fontWeight: 500, lineHeight: '28px' },
      button: { height: 30, padding: '0 12px', borderRadius: 15, border: '0.5px solid var(--dsw-alias-border-l2)', background: 'transparent', color: 'var(--dsw-alias-label-primary)', font: 'inherit', fontSize: 13, cursor: 'pointer' },
      controls: { display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 },
      input: { boxSizing: 'border-box', flex: '1 1 140px', minWidth: 140, height: 30, padding: '0 10px', borderRadius: 8, border: '0.5px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)', font: 'inherit', fontSize: 13 },
      select: { height: 30, padding: '0 10px', borderRadius: 8, border: '0.5px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)', font: 'inherit', fontSize: 13, cursor: 'pointer' },
      section: { margin: '0 0 22px' },
      sectionTitle: { margin: '0 0 6px', color: 'var(--dsw-alias-label-secondary)', fontSize: 13, fontWeight: 500 },
      list: { listStyle: 'none', margin: 0, padding: 0 },
      row: { display: 'flex', alignItems: 'center', gap: 8, padding: '7px 0', borderBottom: '0.5px solid var(--dsw-alias-border-l1)', cursor: 'pointer' },
      rowMain: { flex: 1, minWidth: 0 },
      rowTitle: { display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 500 },
      rowMeta: { display: 'block', color: 'var(--dsw-alias-label-secondary)', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      badge: { flexShrink: 0, padding: '2px 8px', borderRadius: 10, fontSize: 11, color: 'var(--dsw-alias-label-secondary)', border: '0.5px solid var(--dsw-alias-border-l2)' },
      pinned: { flexShrink: 0, color: 'var(--dsw-alias-brand-primary)' },
      back: { background: 'none', border: 'none', color: 'var(--dsw-alias-brand-primary)', font: 'inherit', fontSize: 13, cursor: 'pointer', padding: 0, margin: '0 0 10px' },
      banner: { padding: '8px 10px', borderRadius: 8, border: '0.5px solid var(--dsw-alias-border-l2)', color: 'var(--dsw-alias-label-secondary)', fontSize: 13, margin: '0 0 14px', display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
      origin: { color: 'var(--dsw-alias-brand-primary)', textDecoration: 'none', fontSize: 13 },
      metaLine: { color: 'var(--dsw-alias-label-secondary)', fontSize: 13, margin: '0 0 16px' },
      markdown: { maxWidth: 820, lineHeight: 1.65, overflowWrap: 'break-word' },
      pre: { background: 'var(--dsw-alias-bg-layer-1)', padding: 12, borderRadius: 8, overflow: 'auto', fontFamily: 'ui-monospace, monospace', fontSize: 13 },
      frame: { width: '100%', height: '70vh', border: '0.5px solid var(--dsw-alias-border-l2)', borderRadius: 8 },
      muted: { color: 'var(--dsw-alias-label-secondary)', fontSize: 13, margin: 0 },
      failure: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 13, margin: '0 0 16px' },
      expectedRow: { display: 'flex', alignItems: 'baseline', gap: 8, padding: '6px 0', borderBottom: '0.5px solid var(--dsw-alias-border-l1)' },
    };

    /** A single artifact row in the list. */
    function ArtifactRow({ t, item, onOpen, onTogglePin }) {
      const pinned = item.pinned === true;
      return h('li', { key: item.id, style: styles.row, 'data-artifact': item.id, onClick: () => onOpen(item) },
        h('span', { style: styles.rowMain },
          h('span', { style: styles.rowTitle }, item.title || item.id),
          h('span', { style: styles.rowMeta }, [kindLabel(t, item), availabilityLabel(t, item.availability), item.project].filter(Boolean).join(' · '))),
        pinned ? h('span', { style: styles.pinned, 'aria-label': t('action.unpin'), title: t('action.unpin'), onClick: (event) => { event.stopPropagation(); onTogglePin(item); } }, '★') : null,
        h('button', { type: 'button', 'data-pin': item.id, style: { height: 24, padding: '0 8px', borderRadius: 12, border: '0.5px solid var(--dsw-alias-border-l2)', background: 'transparent', color: 'var(--dsw-alias-label-secondary)', font: 'inherit', fontSize: 12, cursor: 'pointer' }, onClick: (event) => { event.stopPropagation(); onTogglePin(item); } },
          pinned ? t('action.unpin') : t('action.pin')));
    }

    /** A section: one collection with its artifacts and expected outputs. */
    function CollectionBlock({ t, collection, onOpen, onTogglePin }) {
      const rows = (Array.isArray(collection.artifacts) ? collection.artifacts : []).map((artifact) => ({ ...artifact, collectionId: collection.id, project: artifact.project ?? collection.project }));
      const expected = Array.isArray(collection.expectedOutputs) ? collection.expectedOutputs : [];
      const hasExpected = expected.length > 0;
      const hasRows = rows.length > 0;
      if (!hasRows && !hasExpected) return null;
      return h('section', { style: styles.section, 'aria-label': collection.title ?? collection.project ?? collection.id, 'data-collection': collection.id },
        h('h2', { style: { margin: '0 0 6px', fontSize: 15, fontWeight: 500 } }, collection.title ?? collection.project ?? collection.id),
        hasRows ? h('ul', { style: styles.list }, rows.map((item) => h(ArtifactRow, { key: item.id, t, item, onOpen, onTogglePin }))) : null,
        hasExpected ? (h('div', null,
          h('h3', { style: styles.sectionTitle }, t('section.expected')),
          h('ul', { style: styles.list }, expected.map((expectedItem) => {
            const delivered = expectedItem.state === 'delivered';
            return h('li', { key: expectedItem.id ?? expectedItem.title, style: styles.expectedRow },
              h('span', { style: styles.rowMain }, expectedItem.title || expectedItem.id),
              h('span', { style: styles.badge }, delivered ? t('expected.delivered') : t('expected.notdelivered')));
          })))) : null);
    }

    /**
     * The page: search, project filter, pinned section, collections, and the
     * reader for one selected artifact. Selection and query state live here,
     * inside the registered React component, never in `apply`.
     */
    function LibraryPage({ useLibrary, useArtifact, refresh, togglePin, search, ctx }) {
      const t = useTranslate(ctx);
      const [selected, setSelected] = React.useState(null);
      const [query, setQuery] = React.useState('');
      const [project, setProject] = React.useState('');
      const [searchResults, setSearchResults] = React.useState(null);
      const { library, error, busy } = useLibrary((value) => value);

      const searchActive = query !== '' || project !== '';
      React.useEffect(() => {
        let cancelled = false;
        if (!searchActive) {
          setSearchResults(null);
          return () => { cancelled = true; };
        }
        setSearchResults(null);
        Promise.resolve(search({ query, project: project === '' ? null : project }))
          .then((matches) => { if (!cancelled) setSearchResults(matches); })
          .catch(() => { if (!cancelled) setSearchResults(null); });
        return () => { cancelled = true; };
      }, [query, project, search, searchActive]);

      if (selected !== null) {
        return h(ReaderPage, {
          key: selected,
          t,
          useArtifact,
          artifactId: selected,
          ctx,
          onBack: () => setSelected(null),
        });
      }

      if (library === null) {
        if (error !== null) {
          return h('section', { style: styles.page, 'aria-label': t('title'), 'data-plugin': ID },
            h('div', { style: styles.content }, h('p', { style: styles.failure, role: 'alert' }, error)));
        }
        return h('section', { style: styles.page, 'aria-label': t('title'), 'data-plugin': ID },
          h('p', { style: { margin: 20, color: 'var(--dsw-alias-label-secondary)' } }, t('loading')));
      }

      const projects = Array.isArray(library.projects) ? library.projects : [];
      const collections = Array.isArray(library.collections) ? library.collections : [];
      const pinnedRows = collections.flatMap((collection) => (Array.isArray(collection.artifacts) ? collection.artifacts : [])
        .filter((artifact) => artifact.pinned === true)
        .map((artifact) => ({ ...artifact, collectionId: collection.id })));
      const visibleCollections = collections.filter((collection) => project === '' || collection.project === project);
      const searchRows = searchResults === null ? null : searchResults.map((match) => {
        const collection = collections.find((candidate) => candidate.id === match.collectionId);
        const artifact = collection && Array.isArray(collection.artifacts)
          ? collection.artifacts.find((candidate) => candidate.id === match.id)
          : null;
        return { ...match, pinned: artifact?.pinned === true, availability: artifact?.availability };
      });

      return h('section', { style: styles.page, 'aria-label': t('title'), 'data-plugin': ID },
        h('div', { style: styles.content },
          h('div', { style: styles.heading },
            h('h1', { style: styles.title, tabIndex: -1 }, t('title')),
            h('button', { type: 'button', style: styles.button, onClick: refresh, disabled: busy }, busy ? t('action.refreshing') : t('action.refresh'))),
          h('div', { style: styles.controls },
            h('input', { type: 'text', style: styles.input, placeholder: t('hint.search'), 'aria-label': t('hint.search'), value: query, onChange: (event) => setQuery(event.target.value) }),
            h('select', { style: styles.select, 'aria-label': t('hint.project'), value: project, onChange: (event) => setProject(event.target.value) },
              h('option', { key: 'all', value: '' }, t('hint.all')),
              projects.map((name) => h('option', { key: name, value: name }, name)))),
          error !== null ? h('p', { style: styles.failure, role: 'alert' }, error) : null,
          pinnedRows.length > 0
            ? h('section', { style: styles.section },
                h('h2', { style: { margin: '0 0 6px', fontSize: 15, fontWeight: 500 } }, t('section.pinned'), ' ', h('span', { style: styles.pinned }, '★')),
                h('ul', { style: styles.list }, pinnedRows.map((item) => h(ArtifactRow, { key: `pin:${item.collectionId}:${item.id}`, t, item, onOpen: (row) => setSelected(row.id), onTogglePin: togglePin }))))
            : null,
          h('div', null,
            searchRows !== null
              ? h('section', { style: styles.section, key: 'search' },
                  h('h2', { style: { margin: '0 0 6px', fontSize: 15, fontWeight: 500 } }, t('panel')),
                  searchRows.length === 0
                    ? h('p', { style: styles.muted }, t('empty'))
                    : h('ul', { style: styles.list }, searchRows.map((item) => h(ArtifactRow, { key: `${item.collectionId}:${item.id}`, t, item, onOpen: (row) => setSelected(row.id), onTogglePin: togglePin }))))
              : visibleCollections.map((collection) => h(CollectionBlock, { key: collection.id, t, collection, onOpen: (item) => setSelected(item.id), onTogglePin: togglePin })),
            searchRows === null && pinnedRows.length === 0 && visibleCollections.length === 0
              ? h('p', { style: styles.muted }, t('empty'))
              : null)));
    }

    /** The reader page for one artifact. */
    function ReaderPage({ t, useArtifact, artifactId, onBack, ctx }) {
      const { doc, error } = useArtifact((value) => value, artifactId);
      const [originError, setOriginError] = React.useState(null);
      if (error !== null) return h('section', { style: styles.page, 'data-plugin': ID }, h('div', { style: styles.content }, h('button', { type: 'button', 'data-back': '', style: styles.back, onClick: onBack }, '← ', t('title')), h('p', { style: styles.failure, role: 'alert' }, error)));
      if (doc === null) return h('section', { style: styles.page, 'data-plugin': ID }, h('div', { style: styles.content }, h('button', { type: 'button', 'data-back': '', style: styles.back, onClick: onBack }, '← ', t('title')), h('p', { style: styles.muted }, t('loading'))));

      const openOrigin = (event) => {
        event.preventDefault();
        setOriginError(null);
        void navigateToSession(ctx, doc.sourceSessionId).catch(() => {
          setOriginError(t('error.session'));
        });
      };

      const isHtml = doc.mode === 'html';
      const isSnapshot = doc.source === 'snapshot';
      const missing = doc.source === 'missing';
      const related = typeof doc.relatedArtifactId === 'string' && doc.relatedArtifactId !== '';
      const meta = [h('span', { key: 'kind' }, kindLabel(t, doc))];
      if (typeof doc.project === 'string' && doc.project !== '') meta.push(h('span', { key: 'project' }, doc.project));
      if (typeof doc.sourceSessionId === 'string' && doc.sourceSessionId !== '') {
        meta.push(h('a', {
          key: 'origin',
          className: 'lib-origin',
          style: styles.origin,
          href: sessionHref(doc.sourceSessionId),
          onClick: openOrigin,
        }, t('section.origin')));
      }

      return h('section', { style: styles.page, 'aria-label': doc.title, 'data-plugin': ID, 'data-artifact': doc.id },
        h('div', { style: { maxWidth: 900, margin: '0 auto', padding: '20px clamp(16px,4vw,40px) 40px' } },
          h('button', { type: 'button', 'data-back': '', style: styles.back, onClick: onBack }, '← ', t('title')),
          isSnapshot ? h('div', { style: styles.banner }, t('availability.snapshot'), ' — ', h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, 'original deleted')) : null,
          missing ? h('div', { style: styles.banner }, t('availability.missing')) : null,
          h('div', { style: styles.metaLine }, meta.map((node, index) => h(React.Fragment, { key: node.key ?? index }, index > 0 ? ' · ' : null, node))),
          originError !== null ? h('p', { style: styles.failure, role: 'alert' }, originError) : null,
          related ? h('p', { style: styles.metaLine }, t('section.origin'), ' → ', h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, doc.relatedArtifactId)) : null,
          isHtml
            ? h('iframe', {
                title: doc.title,
                style: styles.frame,
                sandbox: '',
                referrerPolicy: 'no-referrer',
                srcDoc: sandboxDocument(doc.html),
                'data-html-reader': '',
              })
            : h('div', { style: styles.markdown, className: 'lib-markdown', dangerouslySetInnerHTML: { __html: doc.html || `<p>${t('availability.missing')}</p>` } })));
    }

    function LibraryPanelIcon({ size, active }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true,
        stroke: active ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
        strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
      }, [
        h('path', { key: 'a', d: 'M4 5.5A1.5 1.5 0 0 1 5.5 4H11v16H5.5A1.5 1.5 0 0 1 4 18.5z' }),
        h('path', { key: 'b', d: 'M13 4h5.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H13' }),
        h('path', { key: 'c', d: 'M16 9h1.5M16 13h1.5' }),
      ]);
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { en: EN }), 'artifact-library: locale');
      const t = ctx.locale.bind(NS);
      let remote;
      let store = { library: null, error: null, busy: false };
      const listeners = new Set();
      const publish = (changes) => {
        store = { ...store, ...changes };
        for (const notify of listeners) notify();
      };
      let inFlight = false;
      const load = async () => {
        if (inFlight) return;
        inFlight = true;
        publish({ error: null, busy: true });
        try {
          if (!remote) throw new Error(t('error.read'));
          const result = await remote.library();
          if (!result || result.ok !== true) {
            publish({ error: t('error.read'), busy: false });
            return;
          }
          publish({ library: result.value, error: null, busy: false });
        } catch {
          publish({ error: t('error.read'), busy: false });
        } finally {
          inFlight = false;
        }
      };
      const useLibrary = (selector) => {
        const [, force] = React.useReducer((value) => value + 1, 0);
        React.useEffect(() => {
          listeners.add(force);
          if (listeners.size === 1 && !inFlight) load();
          return () => {
            listeners.delete(force);
          };
        }, []);
        return selector(store);
      };
      const artifactCache = new Map();
      const artifactListeners = new Map();
      const artifactBusy = new Set();
      const useArtifact = (selector, artifactId) => {
        const [, force] = React.useReducer((value) => value + 1, 0);
        React.useEffect(() => {
          if (!artifactId) return () => {};
          const key = artifactId;
          if (!artifactListeners.has(key)) artifactListeners.set(key, new Set());
          const set = artifactListeners.get(key);
          set.add(force);
          const cached = artifactCache.get(key);
          if (!cached && !artifactBusy.has(key) && remote) {
            artifactBusy.add(key);
            Promise.resolve(remote.artifact({ id: artifactId }))
              .then((result) => {
                artifactBusy.delete(key);
                if (result && result.ok === true && result.value && result.value.ok !== false) {
                  artifactCache.set(key, { doc: result.value, error: null });
                } else {
                  const detail = typeof result?.value?.error === 'string' ? result.value.error : t('error.read');
                  artifactCache.set(key, { doc: null, error: detail });
                }
                for (const notify of set) notify();
              })
              .catch(() => {
                artifactBusy.delete(key);
                artifactCache.set(key, { doc: null, error: t('error.read') });
                for (const notify of set) notify();
              });
          }
          return () => {
            set.delete(force);
          };
        }, [artifactId]);
        const cached = artifactId ? artifactCache.get(artifactId) : null;
        return selector(cached ? { doc: cached.doc, error: cached.error } : { doc: null, error: null });
      };
      const togglePin = async (item) => {
        if (!remote || !item || typeof item.id !== 'string') return;
        const request = { artifactId: item.id, pinned: item.pinned !== true };
        if (typeof item.collectionId === 'string' && item.collectionId !== '') request.collectionId = item.collectionId;
        try {
          const result = await remote.setPinned(request);
          if (!result || result.ok !== true || result.value?.ok === false) return;
          if (listeners.size > 0) load();
        } catch {
          // A pin failure is non-fatal; the row stays as it was.
        }
      };
      const search = async (request) => {
        if (!remote) return null;
        try {
          const result = await remote.search({ ...request, includeBody: true });
          if (!result || result.ok !== true) return null;
          return Array.isArray(result.value?.matches) ? result.value.matches : [];
        } catch {
          return null;
        }
      };
      ctx.effect(() => {
        let disposed = false;
        let face;
        Promise.resolve(ctx.remote.$mount(contribution())).then(() => {
          if (disposed) return;
          face = ctx.inject(['remote.artifactLibrary'], (scoped) => {
            remote = scoped.remote.artifactLibrary;
            if (listeners.size > 0 && store.library === null && !inFlight) load();
          });
        }).catch(() => {});
        return () => { disposed = true; face?.dispose?.(); };
      }, 'artifact-library: remote');
      ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main', key: PANEL_ID, locale: NS,
        inject: () => ({ useLibrary, useArtifact, refresh: load, togglePin, search, ctx }),
      }, LibraryPage)), 'artifact-library: page');
      ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist', id: PANEL_ID, order: 25, locale: NS,
        label: () => t('panel'),
      }, LibraryPanelIcon)), 'artifact-library: sidebar entry');
    }

    return {
      inject: ['slots', 'locale', 'remote', 'sessions', 'uiWorkspace'],
      apply,
      __internals: { contribution, kindLabel, availabilityLabel, locale: EN, HTML_CSP, sandboxDocument, sessionHref, navigateToSession, LibraryPage, ReaderPage, CollectionBlock, ArtifactRow },
    };
  },
});
