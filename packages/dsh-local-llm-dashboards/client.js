window.__ModuleLoader__.load({
  id: '@local/dsh-local-llm-dashboards',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NS = 'sparks';
    const PANEL_ID = 'sparks';
    const EN = {"meta": {"title": "Local Models", "description": "Local model-serving deployments from Prometheus: per-model state, requests in flight, GPU and CPU temperature, tokens served, and firing alerts."}, "panel": "Local Models", "title": "Local models", "loading": "Reading Prometheus…", "empty": "Prometheus has no local serving series.", "error.read": "Could not read Prometheus.", "action.refresh": "Refresh", "action.refreshing": "Refreshing…", "state.down": "Down", "state.degraded": "Degraded", "state.busy": "Serving", "state.idle": "Idle", "fleet.down": "Fleet down", "fleet.degraded": "Fleet degraded", "fleet.busy": "Fleet serving", "fleet.idle": "Fleet idle", "fact.requests": "Running + waiting", "fact.gpu": "GPU", "fact.power": "Power", "fact.cpu": "CPU temp", "graph.hour": "Last hour", "graph.start": "1 h ago", "graph.now": "Now", "graph.empty": "No samples", "graph.temperature": "GPU temperature", "graph.utilization": "GPU utilization", "fact.kvCache": "KV cache", "fact.acceptance": "Spec acceptance", "fact.host": "Host", "time.now": "just now", "time.minutes": "{count} min ago", "time.hours": "{count} h ago", "time.days": "{count} d ago", "fact.decode": "Decode", "fact.prefill": "Prefill", "rate.idle": "—", "error.connecting": "Connecting to Prometheus…"};
    const ID = '@local/dsh-local-llm-dashboards';
    const codec = { mode: 'strict', typeSymbol: ID + '#JSON', create: () => ({ parse: (value) => value }) };
    function contribution() {
      return { package: ID, descriptors: [{
        id: ID + '#overview', service: 'sparks', namespace: 'sparks', method: 'overview',
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

    function percent(value) {
      return typeof value === 'number' ? `${Math.round(value)}%` : '—';
    }

    function tokens(value) {
      if (!Number.isFinite(value) || value <= 0) return '0';
      const units = ['', 'K', 'M', 'B', 'T'];
      let unit = 0;
      let scaled = value;
      while (scaled >= 1000 && unit < units.length - 1) {
        scaled /= 1000;
        unit += 1;
      }
      return `${scaled >= 100 ? Math.round(scaled) : Math.round(scaled * 10) / 10}${units[unit]}`;
    }

    function rate(value, t) {
      return typeof value === 'number' && value > 0 ? `${tokens(value)} tok/s` : t('rate.idle');
    }

    function relativeTime(timestamp, t, now) {
      if (typeof timestamp !== 'number') return '—';
      const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
      if (seconds < 60) return t('time.now');
      if (seconds < 3600) return t('time.minutes', { count: Math.round(seconds / 60) });
      if (seconds < 86400) return t('time.hours', { count: Math.round(seconds / 3600) });
      return t('time.days', { count: Math.round(seconds / 86400) });
    }

    const styles = {
      page: { boxSizing: 'border-box', height: '100%', color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-base)', fontSize: 14, lineHeight: 1.6, overflow: 'auto' },
      content: { maxWidth: 960, margin: '0 auto', padding: '28px clamp(24px,4vw,48px) 48px' },
      heading: { display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center',
        gap: 16, marginBottom: 20 },
      title: { margin: 0, fontSize: 20, fontWeight: 500, lineHeight: '28px' },
      actions: { display: 'flex', alignItems: 'center', gap: 12 },
      button: { height: 32, padding: '0 12px', borderRadius: 16, border: '0.5px solid var(--dsw-alias-border-l2)',
        background: 'transparent', color: 'var(--dsw-alias-label-primary)', font: 'inherit', fontSize: 13,
        cursor: 'pointer' },
      conditions: { display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 16 },
      condition: { display: 'flex', alignItems: 'center', gap: 8, borderRadius: 10, padding: '8px 12px',
        background: 'var(--dsw-alias-bg-layer-1)', fontSize: 13 },
      list: { display: 'flex', flexDirection: 'column', gap: 8 },
      card: { borderRadius: 16, border: '0.5px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)', padding: 16 },
      cardHead: { display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 2 },
      dot: { fontSize: 12 },
      name: { fontSize: 15, fontWeight: 500 },
      meta: { color: 'var(--dsw-alias-label-secondary)', fontSize: 13 },
      state: { marginLeft: 'auto', fontSize: 13, color: 'var(--dsw-alias-label-secondary)' },
      reason: { color: 'var(--dsw-alias-label-secondary)', fontSize: 13, margin: '2px 0 12px' },
      muted: { color: 'var(--dsw-alias-label-secondary)', fontSize: 13, margin: 0 },
      failure: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 13, margin: '0 0 16px' },
    };

    // Layout that needs media queries lives here; everything else stays inline.
    const CLIENT_CSS = `
.dshllm-facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(148px,1fr));gap:12px 24px}
.dshllm-fact{display:flex;flex-direction:column;gap:2px;min-width:0}
.dshllm-fact-label{color:var(--dsw-alias-label-secondary);font-size:12px}
.dshllm-fact-value{font-size:14px;font-variant-numeric:tabular-nums;white-space:nowrap}
.dshllm-trends{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr));gap:12px 24px;margin-top:8px}
.dshllm-trend{margin:0;min-width:0}
.dshllm-trend-head{display:flex;justify-content:space-between;align-items:baseline;gap:8px}
.dshllm-trend-head-label{color:var(--dsw-alias-label-secondary);font-size:12px}
.dshllm-trend-latest{color:var(--dsw-alias-label-secondary);font-size:11px;font-variant-numeric:tabular-nums}
.dshllm-trend-plot{width:100%;height:72px;display:block;color:var(--dsw-alias-label-primary)}
.dshllm-trend-foot{display:flex;justify-content:space-between;color:var(--dsw-alias-label-secondary);font-size:11px;margin-top:2px}
.dshllm-trend-empty{height:72px;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-secondary);font-size:12px}
@media (max-width:640px){
.dshllm-facts{grid-template-columns:1fr 1fr;gap:6px 16px}
.dshllm-fact{flex-direction:row;justify-content:space-between;align-items:baseline;gap:8px}
.dshllm-fact-value{text-align:right}
.dshllm-trends{grid-template-columns:1fr 1fr;gap:12px 12px}
.dshllm-trend-plot,.dshllm-trend-empty{height:56px}
}
`;

    function stateColor(state) {
      if (state === 'down') return 'var(--dsw-alias-state-error-primary)';
      if (state === 'degraded') return 'var(--dsw-alias-state-warn-primary)';
      if (state === 'busy') return 'var(--dsw-alias-state-success-primary)';
      return 'var(--dsw-alias-state-idle-primary)';
    }

    function Fact({ label, value }) {
      return h('div', { className: 'dshllm-fact' },
        h('span', { className: 'dshllm-fact-label' }, label),
        h('span', { className: 'dshllm-fact-value' }, value));
    }

    function Trend({ label, points = [], unit, end, t }) {
      const start = end - 3600000;
      const samples = points.filter(({ t: time, v }) => Number.isFinite(time) && Number.isFinite(v) && time >= start && time <= end);
      const top = Math.max(unit === '%' ? 100 : 1, ...samples.map(({ v }) => v));
      const x = (time) => 8 + (time - start) / 3600000 * 284;
      const y = (value) => 88 - value / top * 66;
      let previous;
      const path = samples.map(({ t: time, v }) => {
        const move = previous === undefined || time - previous > 60000;
        previous = time;
        return `${move ? 'M' : 'L'}${x(time).toFixed(2)},${y(v).toFixed(2)}`;
      }).join(' ');
      const format = (value) => `${tokens(value)}${unit === 'tok/s' ? ' tok/s' : unit}`;
      const latest = samples.length > 0 ? samples[samples.length - 1].v : undefined;
      return h('figure', { className: 'dshllm-trend', 'aria-label': label },
        h('div', { className: 'dshllm-trend-head' },
          h('span', { className: 'dshllm-trend-head-label' }, label),
          latest === undefined ? null : h('span', { className: 'dshllm-trend-latest' }, format(latest))),
        samples.length > 0 ? h('svg', { className: 'dshllm-trend-plot', viewBox: '0 0 300 112', preserveAspectRatio: 'none', role: 'img', 'aria-label': `${label} · ${t('graph.hour')}` },
          h('line', { x1: 8, x2: 292, y1: 88, y2: 88, stroke: 'var(--dsw-alias-border-l2)', vectorEffect: 'non-scaling-stroke' }),
          h('path', { d: path, fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, vectorEffect: 'non-scaling-stroke' }),
          samples.map(({ t: time, v }) => h('circle', { key: time, cx: x(time), cy: y(v), r: 2, fill: 'currentColor' },
            h('title', null, `${new Date(time).toLocaleTimeString()} · ${format(v)}`))))
          : h('div', { className: 'dshllm-trend-empty' }, t('graph.empty')),
        samples.length > 0 ? h('div', { className: 'dshllm-trend-foot' },
          h('span', null, t('graph.start')), h('span', null, t('graph.now'))) : null);
    }

    function DeploymentCard({ deployment, t, end }) {
      const gpu = deployment.gpu || {};
      const serving = deployment.serving || {};
      const gpuFact = gpu.devices > 0
        ? `${percent(gpu.usagePercent)} · ${gpu.temperatureC === null ? '—' : `${gpu.temperatureC}°C`}`
        : '—';
      const power = gpu.powerW === null || gpu.powerW === undefined ? '—' : `${gpu.powerW} W`;
      const acceptance = serving.specAcceptance === null || serving.specAcceptance === undefined
        ? '—' : percent(serving.specAcceptance * 100);
      return h('article', { style: styles.card, 'aria-label': deployment.name },
        h('div', { style: styles.cardHead },
          h('span', { style: { ...styles.dot, color: stateColor(deployment.state) }, 'aria-hidden': true }, '●'),
          h('span', { style: styles.name }, deployment.name),
          h('span', { style: styles.meta }, deployment.id),
          h('span', { style: styles.state }, t(`state.${deployment.state}`))),
        deployment.reason === null || deployment.reason === deployment.name ? null
          : h('p', { style: styles.reason }, deployment.reason),
        deployment.alerts && deployment.alerts.length > 0
          ? h('p', { style: styles.reason }, deployment.alerts.join(' · '))
          : null,
        h('div', { className: 'dshllm-facts' },
          h(Fact, { label: t('fact.requests'), value: `${serving.requestsRunning ?? 0} + ${serving.requestsWaiting ?? 0}` }),
          h(Fact, { label: t('fact.gpu'), value: gpuFact }),
          h(Fact, { label: t('fact.power'), value: power }),
          h(Fact, { label: t('fact.cpu'), value: typeof deployment.cpu?.temperatureC === 'number' ? `${Math.round(deployment.cpu.temperatureC)}°C` : '—' }),
          h(Fact, { label: t('fact.kvCache'), value: percent(deployment.memory?.percent) }),
          h(Fact, { label: t('fact.decode'), value: rate(serving.decodeTps, t) }),
          h(Fact, { label: t('fact.prefill'), value: rate(serving.prefillTps, t) }),
          h(Fact, { label: t('fact.acceptance'), value: acceptance }),
          h(Fact, { label: t('fact.host'), value: gpu.host || '—' })),
        h('div', { style: { marginTop: 20, borderTop: '0.5px solid var(--dsw-alias-border-l1)', paddingTop: 12 } },
          h('div', { className: 'dshllm-fact-label' }, t('graph.hour')),
          h('div', { className: 'dshllm-trends' },
            [['decode', 'fact.decode', 'tok/s'], ['prefill', 'fact.prefill', 'tok/s'],
              ['gpuTemp', 'graph.temperature', '°C'], ['gpuUtil', 'graph.utilization', '%']].map(([key, label, unit]) =>
              h(Trend, { key, label: t(label), points: deployment.series?.[key], unit, end, t })))));
    }

    function SparksPage({ useOverview, refresh, ctx }) {
      const t = useTranslate(ctx);
      const snapshot = useOverview((value) => value);
      const now = React.useMemo(() => Date.now(), [snapshot]);
      const { status, overview, error } = snapshot;
      const deployments = overview === null ? [] : overview.deployments;
      return h('section', { style: styles.page, 'aria-label': t('title'), 'data-plugin': '@local/dsh-local-llm-dashboards' },
        h('style', null, CLIENT_CSS),
        h('div', { style: styles.content },
          h('div', { style: styles.heading },
            h('h1', { style: styles.title, tabIndex: -1 }, t('title')),
            h('div', { style: styles.actions },
              overview === null ? null : h('span', { style: styles.muted },
                t(`fleet.${overview.fleetState}`)),
              h('button', { type: 'button', style: styles.button, onClick: refresh, disabled: status === 'loading' },
                status === 'loading' ? t('action.refreshing') : t('action.refresh')))),
          error === null ? null : h('p', { style: styles.failure, role: 'alert' }, error),
          overview === null || overview.conditions.length === 0 ? null
            : h('div', { style: styles.conditions },
              overview.conditions.map((condition) => h('div', { key: condition.id, style: styles.condition },
                h('span', { style: { color: 'var(--dsw-alias-state-warn-primary)' }, 'aria-hidden': true }, '●'),
                h('span', null, condition.message),
                h('span', { style: { ...styles.muted, marginLeft: 'auto' } }, relativeTime(condition.ts, t, now))))),
          deployments.length === 0
            ? h('p', { style: styles.muted }, status === 'loading' ? t('loading') : t('empty'))
            : h('div', { style: styles.list },
              deployments.map((deployment) => h(DeploymentCard, { key: deployment.id, deployment, t, end: overview.fetchedAt })))));
    }

    function SparksPanelIcon({ size, active }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true,
        stroke: active ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
        strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
      }, [
        h('rect', { key: 'a', x: 3, y: 4, width: 18, height: 7, rx: 1.6 }),
        h('rect', { key: 'b', x: 3, y: 13, width: 18, height: 7, rx: 1.6 }),
        h('path', { key: 'c', d: 'M6.5 7.5h2M6.5 16.5h2' }),
        h('path', { key: 'd', d: 'M17 6.5v2M16 7.5h2M17 15.5v2M16 16.5h2' }),
      ]);
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { en: EN }), 'sparks: locale');
      const t = ctx.locale.bind(NS);
      let remote;
      let store = { status: 'idle', overview: null, error: null };
      const listeners = new Set();
      const publish = (changes) => {
        store = { ...store, ...changes };
        for (const notify of listeners) notify();
      };
      let inFlight = false;
      let timer;
      const POLL_MS = 15000;
      /**
       * Read the fleet. A quiet read is the background poll: it keeps the last
       * good numbers on screen instead of flashing a loading state every tick.
       */
      const load = async (quiet = false) => {
        if (inFlight) return;
        inFlight = true;
        if (!quiet) publish({ status: 'loading', error: null });
        try {
          if (!remote) throw new Error(t('error.connecting'));
          const result = await remote.overview();
          if (!result.ok) {
            publish({ status: 'error', error: result.error?.message || t('error.read') });
            return;
          }
          publish({ status: 'ready', overview: result.value, error: null });
        } catch (error) {
          publish({ status: 'error', error: error?.message || t('error.read') });
        } finally {
          inFlight = false;
        }
      };
      /** Reading the tab again should not show whatever was true an hour ago. */
      const wake = () => {
        if (document.visibilityState === 'visible') load(true);
      };
      const useOverview = (selector) => {
        const [, force] = React.useReducer((value) => value + 1, 0);
        React.useEffect(() => {
          listeners.add(force);
          if (listeners.size === 1) {
            // The data is a live view: poll while the panel is open, at the
            // scrape interval, so a number on screen is at most one tick old.
            if (store.status !== 'loading') load();
            timer = setInterval(() => load(true), POLL_MS);
            document.addEventListener('visibilitychange', wake);
          }
          return () => {
            listeners.delete(force);
            if (listeners.size > 0) return;
            clearInterval(timer);
            timer = undefined;
            document.removeEventListener('visibilitychange', wake);
          };
        }, []);
        return selector(store);
      };
      ctx.effect(() => {
        let disposed = false;
        let face;
        Promise.resolve(ctx.remote.$mount(contribution())).then(() => {
          if (disposed) return;
          face = ctx.inject(['remote.sparks'], (scoped) => {
            remote = scoped.remote.sparks;
            if (listeners.size > 0) load(true);
          });
        }).catch((error) => {
          if (!disposed) publish({ status: 'error', error: error?.message || t('error.read') });
        });
        return () => { disposed = true; remote = undefined; face?.dispose?.(); };
      }, 'sparks: remote');
      ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main', key: PANEL_ID, locale: NS,
        inject: () => ({ useOverview, refresh: load, ctx }),
      }, SparksPage)), 'sparks: page');
      ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist', id: PANEL_ID, order: 20, locale: NS,
        label: () => t('panel'),
      }, SparksPanelIcon)), 'sparks: sidebar entry');
    }

    return {
      inject: ['slots', 'locale', 'remote'],
      apply,
      __internals: { tokens, relativeTime, percent, stateColor },
    };
  },
});
