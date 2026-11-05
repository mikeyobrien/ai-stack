window.__ModuleLoader__.load({
  id: '@local/dsh-3ds',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const DICT = {
      waiting: 'No console paired',
      seen: 'Console seen',
      offline: 'Bridge offline',
      scan: 'Scan this code with DSH Link',
    };

    /** Format the last console contact without a second-by-second ticker. */
    function ago(timestamp) {
      if (typeof timestamp !== 'number' || timestamp <= 0) return '';
      const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
      if (seconds < 60) return 'just now';
      const minutes = Math.round(seconds / 60);
      if (minutes < 60) return `${minutes}m ago`;
      const hours = Math.round(minutes / 60);
      if (hours < 24) return `${hours}h ago`;
      return `${Math.round(hours / 24)}d ago`;
    }

    const styles = {
      wrap: {
        display: 'grid',
        gap: 20,
        justifyItems: 'start',
        maxWidth: 420,
        color: 'var(--dsw-alias-label-primary)',
      },
      code: {
        padding: 24,
        borderRadius: 12,
        background: '#ffffff',
        border: '1px solid var(--dsw-alias-border-l1)',
        lineHeight: 0,
      },
      image: { display: 'block', width: 260, height: 260 },
      meta: {
        display: 'grid',
        gap: 8,
        fontVariantNumeric: 'tabular-nums',
      },
      address: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 13,
        color: 'var(--dsw-alias-label-secondary)',
      },
      token: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 12,
        color: 'var(--dsw-alias-label-secondary)',
        userSelect: 'all',
      },
      status: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        fontSize: 14,
      },
      dot: {
        width: 8,
        height: 8,
        borderRadius: 999,
        background: 'var(--dsw-alias-state-idle-primary)',
      },
      dotLive: {
        width: 8,
        height: 8,
        borderRadius: 999,
        background: 'var(--dsw-alias-state-success-primary)',
      },
      error: {
        fontSize: 14,
        color: 'var(--dsw-alias-state-error-primary)',
      },
    };

    /**
     * Settings page: the pairing code, the address a console types if it cannot
     * scan, and whether a console has reached the bridge since startup.
     */
    function LinkSection() {
      const [state, setState] = React.useState({ loading: true });

      React.useEffect(() => {
        let live = true;
        async function load() {
          try {
            const response = await fetch('/3ds/status', { credentials: 'same-origin', headers: { accept: 'application/json' } });
            const value = await response.json().catch(() => ({}));
            if (!live) return;
            setState(response.ok && value.ok === true ? { loading: false, value } : { loading: false, error: DICT.offline });
          } catch {
            if (live) setState({ loading: false, error: DICT.offline });
          }
        }
        load();
        const timer = setInterval(load, 5000);
        return () => {
          live = false;
          clearInterval(timer);
        };
      }, []);

      if (state.loading) return h('div', { style: styles.wrap }, h('div', { style: styles.meta }, '…'));
      if (state.error !== undefined) {
        return h('div', { style: styles.wrap }, h('div', { style: styles.error, role: 'status' }, state.error));
      }
      const value = state.value;
      const paired = typeof value.lastClientAt === 'number' && value.lastClientAt > 0;
      return h('div', { style: styles.wrap },
        h('div', { style: styles.code },
          h('img', {
            src: `/3ds/qr.svg?size=520&v=${encodeURIComponent(value.origin || '')}`,
            alt: DICT.scan,
            width: 260,
            height: 260,
            style: styles.image,
          }),
        ),
        h('div', { style: styles.meta },
          h('div', { style: styles.address }, value.origin || '—'),
          value.token ? h('code', { style: styles.token, title: 'Pairing token' }, value.token) : null,
          h('div', { style: styles.status, role: 'status' },
            h('span', { style: paired ? styles.dotLive : styles.dot, 'aria-hidden': true }),
            paired ? `${DICT.seen} ${ago(value.lastClientAt)}` : DICT.waiting,
          ),
        ),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'dsh-3ds',
          order: 60,
          label: '3DS Link',
        }, LinkSection));
      },
    };
  },
});
