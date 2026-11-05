window.__ModuleLoader__.load({
  id: '@local/dsh-token-metrics',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const ID = '@local/dsh-token-metrics';
    const NS = 'token-metrics';
    const PANEL_ID = 'token-metrics';
    const EN = {
      "meta": { "title": "Token Metrics", "description": "Token usage of every model call, rolled up by model from the moment this plugin was activated." },
      "panel": "Token Metrics",
      "title": "Token Metrics",
      "loading": "\u2026",
      "empty": "No calls recorded.",
      "error.read": "Could not read token metrics.",
      "action.refresh": "Refresh",
      "action.refreshing": "Refreshing\u2026",
      "scope": "Model calls since {date}",
      "section.totals": "Totals",
      "section.models": "By model",
      "section.none": "None recorded.",
      "col.model": "Model",
      "col.calls": "Calls",
      "col.input": "Input",
      "col.cache": "Cache read",
      "col.output": "Output",
      "col.total": "Total",
    };
    const codec = { mode: 'strict', typeSymbol: ID + '#JSON', create: () => ({ parse: (value) => value }) };

    function contribution() {
      return { package: ID, descriptors: [{
        id: ID + '#overview', service: 'tokenMetrics', namespace: 'tokenMetrics', method: 'overview',
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

    /** Group a token count with the locale's separators; keeps the column scannable. */
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
      content: { maxWidth: 860, margin: '0 auto', padding: '28px clamp(20px,4vw,48px) 48px' },
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
      table: { width: '100%', borderCollapse: 'collapse', borderTop: '0.5px solid var(--dsw-alias-border-l1)' },
      th: { textAlign: 'right', padding: '6px 8px', color: 'var(--dsw-alias-label-secondary)', fontSize: 12,
        fontWeight: 500, borderBottom: '0.5px solid var(--dsw-alias-border-l1)', whiteSpace: 'nowrap' },
      thModel: { textAlign: 'left', padding: '6px 8px', color: 'var(--dsw-alias-label-secondary)', fontSize: 12,
        fontWeight: 500, borderBottom: '0.5px solid var(--dsw-alias-border-l1)' },
      td: { textAlign: 'right', padding: '8px 8px', fontVariantNumeric: 'tabular-nums',
        borderBottom: '0.5px solid var(--dsw-alias-border-l1)' },
      tdModel: { textAlign: 'left', padding: '8px 8px', overflowWrap: 'anywhere',
        borderBottom: '0.5px solid var(--dsw-alias-border-l1)' },
      muted: { color: 'var(--dsw-alias-label-secondary)', fontSize: 13, margin: 0 },
    };

    function TokenRow({ row, t }) {
      return h('tr', { 'data-model': row.model },
        h('td', { style: styles.tdModel }, row.model),
        h('td', { style: styles.td }, formatCount(row.calls)),
        h('td', { style: styles.td }, formatCount(row.inputTokens)),
        h('td', { style: styles.td }, formatCount(row.cacheReadTokens)),
        h('td', { style: styles.td }, formatCount(row.outputTokens)),
        h('td', { style: styles.td }, formatCount(row.totalTokens)));
    }

    function ModelTable({ rows, t }) {
      return h('table', { style: styles.table },
        h('thead', null,
          h('tr', null,
            h('th', { style: styles.thModel }, t('col.model')),
            h('th', { style: styles.th }, t('col.calls')),
            h('th', { style: styles.th }, t('col.input')),
            h('th', { style: styles.th }, t('col.cache')),
            h('th', { style: styles.th }, t('col.output')),
            h('th', { style: styles.th }, t('col.total')))),
        h('tbody', null, rows.map((row) => h(TokenRow, { key: row.model, row, t }))));
    }

    function Totals({ totals, t }) {
      return h('p', { style: { margin: '0 0 24px', fontVariantNumeric: 'tabular-nums', color: 'var(--dsw-alias-label-primary)' }, 'data-totals': true },
        `${formatCount(totals.calls)} ${t('col.calls')} · ${formatCount(totals.totalTokens)} ${t('col.total')}`);
    }

    function TokenMetricsPage({ useTokenMetrics, refresh, ctx }) {
      const t = useTranslate(ctx);
      const { overview, error, errorDetail, busy } = useTokenMetrics((value) => value);
      const models = overview === null ? [] : overview.models;
      const totals = overview === null ? null : overview.totals;
      const scope = scopeLine(t, overview);
      const empty = models.length === 0;
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
                totals === null ? null : h(Totals, { totals, t }),
                h('section', { style: styles.section, 'aria-label': t('section.models') },
                  h('h2', { style: styles.sectionTitle }, t('section.models')),
                  h(ModelTable, { rows: models, t })))))
    }

    function TokenMetricsPanelIcon({ size, active }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true,
        stroke: active ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
        strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
      }, [
        h('path', { key: 'a', d: 'M4 20h16' }),
        h('path', { key: 'b', d: 'M7 20v-6' }),
        h('path', { key: 'c', d: 'M12 20v-10' }),
        h('path', { key: 'd', d: 'M17 20v-14' }),
      ]);
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { en: EN }), 'token-metrics: locale');
      const t = ctx.locale.bind(NS);
      let remote;
      let store = { overview: null, error: null, errorDetail: '', busy: false };
      const listeners = new Set();
      const publish = (changes) => {
        store = { ...store, ...changes };
        for (const notify of listeners) notify();
      };
      let inFlight = false;
      /** Read the current rows. A read cannot change a row; it only shows them. */
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
      const useTokenMetrics = (selector) => {
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
          face = ctx.inject(['remote.tokenMetrics'], (scoped) => {
            remote = scoped.remote.tokenMetrics;
            if (listeners.size > 0 && store.overview === null && !inFlight) load();
          });
        }).catch((error) => {
          if (!disposed) publish({ error: t('error.read'), errorDetail: error?.message ?? '' });
        });
        return () => { disposed = true; remote = undefined; face?.dispose?.(); };
      }, 'token-metrics: remote');
      ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main', key: PANEL_ID, locale: NS,
        inject: () => ({ useTokenMetrics, refresh: load, ctx }),
      }, TokenMetricsPage)), 'token-metrics: page');
      ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist', id: PANEL_ID, order: 31, locale: NS,
        label: () => t('panel'),
      }, TokenMetricsPanelIcon)), 'token-metrics: sidebar entry');
    }

    return {
      inject: ['slots', 'locale', 'remote'],
      apply,
      __internals: { contribution, formatCount, formatDate, scopeLine, locale: EN },
    };
  },
});
