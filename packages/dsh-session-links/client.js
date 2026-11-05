window.__ModuleLoader__.load({
  id: '@local/dsh-session-links',
  factory() {
    const PREFIX = 'dsh-session:';
    const PARAM = 'session';

    /** Decode one URL-carried value; an empty value names nothing. */
    function decoded(value) {
      const raw = value.trim();
      if (raw === '') return null;
      try {
        return decodeURIComponent(raw).trim() || null;
      } catch {
        return raw;
      }
    }

    /**
     * The session this page URL names, if any.
     * Supported forms: `?session=<id>`, `#dsh-session:<id>`, `#session=<id>`.
     */
    function readTarget(location) {
      const url = new URL(location.href);
      const query = url.searchParams.get(PARAM);
      const fromQuery = typeof query === 'string' ? decoded(query) : null;
      if (fromQuery !== null) return fromQuery;
      const hash = url.hash.slice(1);
      if (hash.startsWith(PREFIX)) return decoded(hash.slice(PREFIX.length));
      if (hash.startsWith(`${PARAM}=`)) return decoded(hash.slice(PARAM.length + 1));
      return null;
    }

    /** Drop the deep-link marker so a later refresh does not re-open it. */
    function cleanLocation(history, location) {
      const url = new URL(location.href);
      url.searchParams.delete(PARAM);
      const hash = url.hash.slice(1);
      if (hash.startsWith(PREFIX) || hash.startsWith(`${PARAM}=`)) url.hash = '';
      history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    }

    /** Open the named session once the session list can address it. */
    function apply(ctx) {
      const target = readTarget(window.location);
      if (target === null) return;
      const open = () => {
        cleanLocation(window.history, window.location);
        ctx.uiWorkspace.openSession(target);
      };
      const list = ctx.sessions.list;
      if (list.getSnapshot().phase === 'ready') {
        open();
        return;
      }
      const dispose = list.subscribe(() => {
        if (list.getSnapshot().phase !== 'ready') return;
        dispose();
        open();
      });
    }

    return {
      inject: ['sessions', 'uiWorkspace'],
      apply,
      __internals: { readTarget, cleanLocation },
    };
  },
});
