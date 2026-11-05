window.__ModuleLoader__.load({
  id: '@local/dsh-model-labels',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NS = 'model-labels';
    const EN = {"meta": {"title": "Model Labels", "description": "Marks models served on this machine as Local and models served in a cluster as Remote in the composer's model selector."}, "label.local": "Local", "label.remote": "Remote"};

    /**
     * Hosts that serve models in a cluster. Everything else that serves is a
     * machine here: reef's vLLM and the Sparks' TensorFold both name their host
     * in the serving series, and neither is a cluster host.
     */
    const REMOTE_HOSTS = new Set(['spark-1']);

    /**
     * Where one model is served: `local`, `remote`, or null when nothing says.
     * A provider can serve several models on different hosts, so the model id
     * decides before the provider's own host label. Both ids are read straight
     * from the serving endpoints' `/v1/models`, so they cannot drift from what
     * is actually answering.
     */
    const PLACEMENTS = {
      // reef outside k3s: vLLM on 192.168.1.2:8010.
      'qwen3.8-27b': 'local',
      // The Sparks cluster: TensorFold on spark-1.
      'deepseek-v4.1-flash': 'remote',
    };

    /** Providers that run a model on this machine or one of the Sparks. */
    const SERVING_PROVIDERS = new Set(['sparks', 'reef', 'local']);

    /** A host name as the serving series and URLs spell it: no scheme, no port, lowercase. */
    function hostOf(provider) {
      const host = provider?.host ?? provider?.hostname;
      if (typeof host === 'string' && host.length > 0) return host;
      const url = provider?.baseURL ?? provider?.baseUrl;
      if (typeof url !== 'string') return null;
      const match = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/]*@)?([a-z0-9][a-z0-9.-]*)/i.exec(url);
      return match === null ? null : match[1];
    }

    /** The tag one model earns, or null when it is served somewhere unknown. */
    function tagOf(provider, model) {
      const placement = PLACEMENTS[model?.id];
      if (placement !== undefined) return placement;
      const host = hostOf(provider);
      if (host === null) return null;
      return REMOTE_HOSTS.has(host.split('.')[0]) ? 'remote' : 'local';
    }

    /**
     * A serving provider's model name with its tag, or the catalog name untouched.
     *
     * The label fills the space it is given and only the name shrinks, so a
     * long name ellipsizes while the tag stays pinned where it can be read.
     */
    function ModelLabel({ provider, model, t }) {
      if (!SERVING_PROVIDERS.has(provider?.id)) return model.name;
      const placement = tagOf(provider, model);
      if (placement === null) return model.name;
      return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap', minWidth: 0, maxWidth: '100%' } },
        h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 } }, model.name),
        h('span', {
          style: { flex: 'none', borderRadius: 999, cornerShape: 'round', padding: '0 6px', fontSize: 10,
            lineHeight: '16px', fontWeight: 500,
            background: placement === 'local'
              ? 'color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent)'
              : 'color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent)',
            color: placement === 'local' ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-business-primary)' },
        }, t(`label.${placement}`)));
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { en: EN }), 'model-labels: locale');
      ctx.slots.inject('conversation.input.model.label', () => ctx.slots.register({
        name: 'conversation.input.model.label', locale: NS,
      }, ModelLabel));
    }

    return {
      inject: ['slots', 'locale'],
      apply,
      __internals: { tagOf, hostOf, REMOTE_HOSTS, PLACEMENTS },
    };
  },
});
