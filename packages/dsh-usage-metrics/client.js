window.__ModuleLoader__.load({
  id: '@local/dsh-usage-metrics',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const ID = '@local/dsh-usage-metrics';
    const NS = 'usage-metrics';
    const PANEL_ID = 'metrics';
    const EN = { "meta": { "title": "Metrics", "description": "Successful skill and principle_read tool calls, counted per skill and per principle from the moment this plugin was activated." }, "panel": "Metrics", "title": "Metrics", "loading": "\u2026", "empty": "None recorded.", "error.read": "Could not read session metrics.", "action.refresh": "Refresh", "action.refreshing": "Refreshing\u2026", "scope": "Successful skill and principle_read calls since {date}", "section.skills": "Skills", "section.principles": "Principles", "section.none": "None recorded." };
    const codec = { mode: 'strict', typeSymbol: ID + '#JSON', create: () => ({ parse: (value) => value }) };

    function contribution() {
      return { package: ID, descriptors: [{
        id: ID + '#overview', service: 'usageMetrics', namespace: 'usageMetrics', method: 'overview',
        invocation: { kind: 'direct' }, parameters: [], result: codec,
      }] };
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

    /** Group a count with the locale's separators; keeps the column scannable. */
    function formatCount(value) {
      return typeof value === 'number' && Number.isFinite(value) ? new Intl.NumberFormat().format(value) : '0';
    }

    /** The day counting began, in the reader's locale. */
    function formatDate(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '';
      try {
        return new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' }).format(new Date(value));
      } catch {
        return new Date(value).toISOString().slice(0, 10);
      }
    }

    /**
     * The one line that says what the numbers measure and where they start.
     * @returns the scope sentence, or null while the first read is outstanding.
     */
    function scopeLine(t, overview) {
      if (overview === undefined || overview === null || typeof overview.activatedAt !== 'number') return null;
      return t('scope', { date: formatDate(overview.activatedAt) });
    }

    const styles = {
      page: { boxSizing: 'border-box', height: '100%', color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-base)', fontSize: 14, lineHeight: 1.6, overflow: 'auto' },
      content: { maxWidth: 720, margin: '0 auto', padding: '28px clamp(20px,4vw,48px) 48px' },
      heading: { display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center',
        gap: 16, marginBottom: 8 },
      title: { margin: 0, fontSize: 20, fontWeight: 500, lineHeight: '28px' },
      button: { height: 32, padding: '0 12px', borderRadius: 16, border: '0.5px solid var(--dsw-alias-border-l2)',
        background: 'transparent', color: 'var(--dsw-alias-label-primary)', font: 'inherit', fontSize: 13,
        cursor: 'pointer' },
      scope: { margin: '0 0 24px', color: 'var(--dsw-alias-label-secondary)', fontSize: 13 },
      failure: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 13, margin: '0 0 16px' },
      section: { margin: '0 0 28px' },
      sectionTitle: { margin: '0 0 4px', color: 'var(--dsw-alias-label-secondary)', fontSize: 13, fontWeight: 500 },
      rows: { listStyle: 'none', margin: 0, padding: 0, borderTop: '0.5px solid var(--dsw-alias-border-l1)' },
      row: { display: 'flex', alignItems: 'baseline', gap: 16, padding: '8px 0',
        borderBottom: '0.5px solid var(--dsw-alias-border-l1)' },
      name: { flex: 1, minWidth: 0, overflowWrap: 'anywhere' },
      count: { flexShrink: 0, fontVariantNumeric: 'tabular-nums', textAlign: 'right' },
      muted: { color: 'var(--dsw-alias-label-secondary)', fontSize: 13, margin: 0 },
    };

    function RowList({ title, rows, t }) {
      return h('section', { style: styles.section, 'aria-label': title },
        h('h2', { style: styles.sectionTitle }, title),
        rows.length === 0
          ? h('p', { style: styles.muted }, t('section.none'))
          : h('ul', { style: styles.rows },
            rows.map((row) => h('li', { key: row.name, style: styles.row },
              h('span', { style: styles.name }, row.name),
              h('span', { style: styles.count }, formatCount(row.count))))));
    }

    function MetricsPage({ useMetrics, refresh, ctx }) {
      const t = useTranslate(ctx);
      const { overview, error, errorDetail, busy } = useMetrics((value) => value);
      const skills = overview === null ? [] : overview.skills;
      const principles = overview === null ? [] : overview.principles;
      const scope = scopeLine(t, overview);
      const empty = skills.length === 0 && principles.length === 0;
      return h('section', { style: styles.page, 'aria-label': t('title'), 'data-plugin': ID },
        h('div', { style: styles.content },
          h('div', { style: styles.heading },
            h('h1', { style: styles.title, tabIndex: -1 }, t('title')),
            h('button', { type: 'button', style: styles.button, onClick: refresh, disabled: busy },
              busy ? t('action.refreshing') : t('action.refresh'))),
          scope === null ? null : h('p', { style: styles.scope }, scope),
          error === null ? null : h('p', { style: styles.failure, role: 'alert', title: errorDetail || undefined }, error),
          overview === null
            ? busy ? h('p', { style: styles.muted }, t('loading')) : null
            : empty
              ? h('p', { style: styles.muted }, t('empty'))
              : h('div', null,
                h(RowList, { title: t('section.skills'), rows: skills, t }),
                h(RowList, { title: t('section.principles'), rows: principles, t }))));
    }

    function MetricsPanelIcon({ size, active }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true,
        stroke: active ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
        strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
      }, [
        h('path', { key: 'a', d: 'M4 20h16' }),
        h('rect', { key: 'b', x: 5, y: 12, width: 3.4, height: 5, rx: 0.8 }),
        h('rect', { key: 'c', x: 10.3, y: 8, width: 3.4, height: 9, rx: 0.8 }),
        h('rect', { key: 'd', x: 15.6, y: 4, width: 3.4, height: 13, rx: 0.8 }),
      ]);
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { en: EN }), 'usage-metrics: locale');
      const t = ctx.locale.bind(NS);
      let remote;
      let store = { overview: null, error: null, errorDetail: '', busy: false };
      const listeners = new Set();
      const publish = (changes) => {
        store = { ...store, ...changes };
        for (const notify of listeners) notify();
      };
      let inFlight = false;
      /** Read the current rows. A read cannot change a count; it only shows them. */
      const load = async () => {
        if (inFlight) return;
        inFlight = true;
        publish({ error: null, errorDetail: '', busy: true });
        try {
          if (!remote) throw new Error(t('error.read'));
          const result = await remote.overview();
          if (!result.ok) {
            publish({ error: t('error.read'), errorDetail: result.error?.message ?? '', busy: false });
            return;
          }
          publish({ overview: result.value, error: null, errorDetail: '', busy: false });
        } catch (error) {
          publish({ error: t('error.read'), errorDetail: error?.message ?? '', busy: false });
        } finally {
          inFlight = false;
        }
      };
      const useMetrics = (selector) => {
        const [, force] = React.useReducer((value) => value + 1, 0);
        React.useEffect(() => {
          listeners.add(force);
          // Opening the panel is the one moment the rows should be current.
          if (listeners.size === 1 && !inFlight) load();
          return () => {
            listeners.delete(force);
          };
        }, []);
        return selector(store);
      };
      ctx.effect(() => {
        let disposed = false;
        let face;
        Promise.resolve(ctx.remote.$mount(contribution())).then(() => {
          if (disposed) return;
          face = ctx.inject(['remote.usageMetrics'], (scoped) => {
            remote = scoped.remote.usageMetrics;
            if (listeners.size > 0 && store.overview === null && !inFlight) load();
          });
        }).catch((error) => {
          if (!disposed) publish({ error: t('error.read'), errorDetail: error?.message ?? '' });
        });
        return () => { disposed = true; remote = undefined; face?.dispose?.(); };
      }, 'usage-metrics: remote');
      ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main', key: PANEL_ID, locale: NS,
        inject: () => ({ useMetrics, refresh: load, ctx }),
      }, MetricsPage)), 'usage-metrics: page');
      ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist', id: PANEL_ID, order: 30, locale: NS,
        label: () => t('panel'),
      }, MetricsPanelIcon)), 'usage-metrics: sidebar entry');
    }

    return {
      inject: ['slots', 'locale', 'remote'],
      apply,
      __internals: { contribution, formatCount, formatDate, scopeLine, locale: EN },
    };
  },
});
