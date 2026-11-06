/**
 * Isolated browser fixture for the Artifact Library client.
 *
 * It serves the real `client.js` over the fixture server, loads real React from
 * the staged vendor directory, renders the registered main panel with a mock
 * remote, and exposes the calls and DOM helpers the Playwright run asserts.
 * No DSH host, session, profile or real artifact store is involved.
 */
(async () => {
  const calls = { library: 0, search: [], artifact: [], setPinned: [], sessionRefresh: 0, openedSessions: [], order: [] };
  const state = { registry: null, docs: {}, bodies: {} };

  /** A fresh synthetic registry for each fixture load. */
  function resetState() {
    state.registry = {
      projects: ['ai-stack', 'docs'],
      collections: [
        {
          id: 'coll-a',
          title: 'Client Repair',
          project: 'ai-stack',
          sourceSessionId: 'session-x',
          artifacts: [
            { id: 'a-md', title: 'Report MD', kind: 'research', format: 'markdown', availability: 'original', pinned: false, sourceSessionId: 'session-x' },
            { id: 'a-html', title: 'Report HTML', kind: 'report', format: 'html', availability: 'snapshot', pinned: true, sourceSessionId: 'session-x' },
            { id: 'a-malice', title: 'Malicious HTML', kind: 'report', format: 'html', availability: 'original', pinned: false, sourceSessionId: 'session-y' },
          ],
          expectedOutputs: [
            { id: 'e-pending', title: 'Illustrated guide', state: 'pending' },
            { id: 'e-delivered', title: 'Delivered report', state: 'delivered' },
          ],
        },
        {
          id: 'coll-b',
          title: 'Docs Topic',
          project: 'docs',
          artifacts: [
            { id: 'b-md', title: 'Body Only Report', kind: 'design', format: 'markdown', availability: 'missing', pinned: false, sourceSessionId: 'session-z' },
          ],
          expectedOutputs: [],
        },
      ],
    };

    const safePixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z2h8AAAAASUVORK5CYII=';
    state.docs = {
      'a-md': {
        ok: true, id: 'a-md', title: 'Report MD', kind: 'research', project: 'ai-stack',
        mode: 'markdown', source: 'original', availability: 'original', sourceSessionId: 'session-x',
        relatedArtifactId: 'a-html',
        html: '<h1>Markdown report</h1><p>The quick brown fox.</p>',
      },
      'a-html': {
        ok: true, id: 'a-html', title: 'Report HTML', kind: 'report', project: 'ai-stack',
        mode: 'html', source: 'snapshot', availability: 'snapshot', sourceSessionId: 'session-x',
        html: `<html><head><title>Safe report</title></head><body><h1>Safe report</h1><img id="pixel" alt="pixel" src="${safePixel}"></body></html>`,
      },
      'a-malice': {
        ok: true, id: 'a-malice', title: 'Malicious HTML', kind: 'report', project: 'ai-stack',
        mode: 'html', source: 'original', availability: 'original', sourceSessionId: 'session-y',
        html: '<html><head><link rel="stylesheet" href="/exfil.css"><style>body{background-image:url(\'/exfil-bg.png\')}</style></head><body><script>document.documentElement.setAttribute(\'data-script-ran\',\'yes\');fetch(\'/exfil?script=1\')</script><img src="/exfil.png" alt="x"><h1>Malicious report</h1></body></html>',
      },
      'b-md': {
        ok: true, id: 'b-md', title: 'Body Only Report', kind: 'design', project: 'docs',
        mode: 'markdown', source: 'missing', availability: 'missing', sourceSessionId: 'session-z',
        html: '<h1>Body Only Report</h1><p>BodyOnly needle.</p>',
      },
    };
    state.bodies = {
      'a-md': 'The quick brown fox.',
      'a-html': 'Safe report',
      'a-malice': 'Malicious report',
      'b-md': 'BodyOnly needle.',
    };
  }

  resetState();

  /** Load one CommonJS vendor file with a synchronous require map. */
  async function loadCjs(url, modules = {}) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`fixture: ${url} returned ${response.status}`);
    const source = await response.text();
    const module = { exports: {} };
    const require = (name) => {
      if (!Object.hasOwn(modules, name)) throw new Error(`fixture: unexpected require ${name} in ${url}`);
      return modules[name];
    };
    const run = new Function('module', 'exports', 'require', 'process', 'global', source);
    run(module, module.exports, require, { env: { NODE_ENV: 'development' } }, window);
    return module.exports;
  }

  const React = await loadCjs('/vendor/react/cjs/react.development.js');
  const scheduler = await loadCjs('/vendor/scheduler/cjs/scheduler.development.js');
  const reactDom = await loadCjs('/vendor/react-dom/cjs/react-dom.development.js', { react: React });
  const reactDomClient = await loadCjs('/vendor/react-dom/cjs/react-dom-client.development.js', {
    react: React,
    scheduler,
    'react-dom': reactDom,
  });
  window.React = React;
  window.ReactDOM = reactDomClient;

  const definition = await new Promise((resolve, reject) => {
    window.__ModuleLoader__ = { load(value) { resolve(value); } };
    const script = document.createElement('script');
    script.src = '/client.js';
    script.onerror = () => reject(new Error('fixture: client.js failed to load'));
    document.head.append(script);
  });

  const client = definition.factory((name) => {
    if (name === 'react') return React;
    throw new Error(`fixture: unexpected module ${name}`);
  });

  const DICT = client.__internals.locale;
  const t = (key, values) => {
    let text = DICT[key] ?? key;
    if (values !== undefined) {
      for (const [name, value] of Object.entries(values)) text = text.split(`{${name}}`).join(String(value));
    }
    return text;
  };

  const remote = {
    async library() {
      calls.library += 1;
      return { ok: true, value: state.registry };
    },
    async search(request) {
      calls.search.push({ ...request });
      const query = String(request.query ?? '').toLowerCase();
      const project = typeof request.project === 'string' ? request.project : null;
      const matches = [];
      for (const collection of state.registry.collections) {
        if (project !== null && collection.project !== project) continue;
        for (const artifact of collection.artifacts) {
          const haystack = `${artifact.title ?? ''}\n${artifact.note ?? ''}\n${state.bodies[artifact.id] ?? ''}`.toLowerCase();
          if (query !== '' && !haystack.includes(query)) continue;
          matches.push({
            collectionId: collection.id, id: artifact.id, title: artifact.title,
            kind: artifact.kind, format: artifact.format ?? null, project: collection.project,
          });
        }
      }
      matches.sort((a, b) => String(a.title ?? '').localeCompare(String(b.title ?? '')));
      return { ok: true, value: { matches } };
    },
    async artifact(request) {
      calls.artifact.push({ ...request });
      const doc = state.docs[request.id];
      if (doc === undefined) return { ok: false, error: `fixture: unknown artifact ${request.id}` };
      return { ok: true, value: doc };
    },
    async setPinned(request) {
      calls.setPinned.push({ ...request });
      const collection = state.registry.collections.find((candidate) => candidate.id === request.collectionId);
      const artifact = collection && collection.artifacts.find((candidate) => candidate.id === request.artifactId);
      if (artifact === undefined) return { ok: false, error: 'fixture: unknown artifact' };
      artifact.pinned = request.pinned === true;
      return { ok: true, value: { ok: true, id: artifact.id, pinned: artifact.pinned } };
    },
  };

  const registrations = [];
  const effects = [];
  const ctx = {
    sessions: {
      async refresh() {
        calls.sessionRefresh += 1;
        calls.order.push('refresh');
      },
      list: {
        getSnapshot: () => ({
          phase: 'ready',
          ids: ['session-x', 'session-y', 'session-z'],
          byId: { 'session-x': {}, 'session-y': {}, 'session-z': {} },
        }),
      },
    },
    uiWorkspace: {
      openSession: (id) => {
        calls.openedSessions.push(id);
        calls.order.push(`open:${id}`);
      },
    },
    locale: {
      register(namespace, dicts) {
        if (namespace !== 'artifact-library') throw new Error(`fixture: locale namespace ${namespace}`);
        if (dicts.en.panel !== 'Artifact Library') throw new Error('fixture: locale panel mismatch');
        return () => {};
      },
      getSnapshot: () => ({ locale: 'en' }),
      subscribe: () => () => {},
      bind: () => t,
    },
    remote: {
      $mount(contribution) {
        registrations.mount = contribution;
        return Promise.resolve();
      },
    },
    slots: {
      inject(_name, run) {
        run();
        return () => {};
      },
      register(options, component) {
        registrations.push({ options, component });
        return () => {};
      },
    },
    effect(fn) {
      const cleanup = fn();
      if (typeof cleanup === 'function') effects.push(cleanup);
    },
    inject(keys, run) {
      registrations.injections = Array.from(keys);
      run({ remote: { artifactLibrary: remote } });
      return { dispose() {} };
    },
  };

  client.apply(ctx);
  await Promise.resolve();
  await Promise.resolve();

  const page = registrations.find(({ options }) => options.name === 'main');
  if (page === undefined) throw new Error('fixture: main page was not registered');
  const root = reactDomClient.createRoot(document.getElementById('panel'));
  root.render(React.createElement(page.component, page.options.inject()));

  const frame = () => document.querySelector('[data-html-reader]');
  const reader = () => document.querySelector('[data-artifact][data-plugin]');

  window.__fx = {
    ready: false,
    error: null,
    calls,
    state,
    t,
    React,
    registrations,
    frame,
    srcdoc: () => (frame() === null ? null : frame().getAttribute('srcdoc')),
    sandbox: () => (frame() === null ? null : frame().getAttribute('sandbox')),
    readerText: () => (reader() === null ? null : reader().innerText),
    bodyText: () => document.body.innerText,
  };
  window.__fx.ready = true;
})().catch((error) => {
  window.__fx = { ready: false, error: String(error?.stack ?? error) };
  console.error(error);
});
