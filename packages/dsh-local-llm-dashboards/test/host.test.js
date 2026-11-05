/**
 * Behaviour tests for the Sparks deployments Host half.
 *
 * The assertions are about what the page and the agent can observe: a
 * deployment's state, the alerts that name it, the facts the card shows, and
 * what the tool returns. The last test runs the real PromQL against the live
 * Prometheus through the SSH tunnel, so the queries are checked against the
 * metrics that actually exist, not against a fixture that happens to match.
 *
 * Run: node --test test/
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { apply, PrometheusMonitor, QUERIES, HISTORY_QUERIES, SshTunnel, fleetState, formatTokens, seriesFor, sparksTool, summarizePrometheus } from '../index.js';

const NOW = Date.now();

/** A Prometheus that answers each query with the instant vector a fixture names. */
function stubPrometheus(answers, seen = []) {
  return async (url) => {
    const parsed = new URL(url);
    const query = parsed.searchParams.get('query');
    seen.push(query);
    const history = parsed.pathname.endsWith('/query_range');
    const table = history ? HISTORY_QUERIES : QUERIES;
    const entry = Object.entries(table).find(([, promql]) => promql === query);
    if (entry === undefined) return new Response('bad query', { status: 400 });
    if (history) {
      const result = answers[`history.${entry[0]}`] ?? [];
      return Response.json({ status: 'success', data: { resultType: 'matrix', result } });
    }
    return Response.json({ status: 'success', data: { resultType: 'vector', result: answers[entry[0]] ?? [] } });
  };
}

/** One instant-vector sample. */
function sample(metric, value, ts = NOW / 1000) {
  return { metric, value: [ts, String(value)] };
}

/** Wrap fixtures the way Prometheus answers: `{ status, data: { result } }`. */
function answers(vectors) {
  return Object.fromEntries(Object.entries(vectors).map(([name, result]) => [name, { status: 'success', data: { resultType: 'vector', result } }]));
}

const HEALTHY = {
  'serving.vllm': [sample({ job: 'local-llm', model_name: 'qwen3.8-27b' }, 1)],
  'running.vllm': [sample({ job: 'local-llm' }, 1)],
  'waiting.vllm': [sample({ job: 'local-llm' }, 0)],
  'generationTokens.vllm': [sample({ job: 'local-llm' }, 1147375)],
  'promptTokens.vllm': [sample({ job: 'local-llm' }, 39326940)],
  'kvCache.vllm': [sample({ job: 'local-llm' }, 0.0622)],
  'specDraftTokens.vllm': [sample({ job: 'local-llm' }, 2286941)],
  'specAccepted.vllm': [sample({ job: 'local-llm' }, 821087)],
  gpuUtil: [sample({ job: 'dcgm-exporter', Hostname: 'reef', device: 'nvidia0' }, 0), sample({ job: 'dcgm-exporter', Hostname: 'reef', device: 'nvidia1' }, 0)],
  gpuTemp: [sample({ Hostname: 'reef', device: 'nvidia0' }, 38), sample({ Hostname: 'reef', device: 'nvidia1' }, 41)],
  gpuPower: [sample({ Hostname: 'reef' }, 63.1)],
  gpuXid: [sample({ Hostname: 'reef' }, 0)],
  up: [sample({ job: 'local-llm' }, 1), sample({ job: 'dcgm-exporter' }, 1)],
  alerts: [],
};

test('a serving job reads as busy with its model, GPU and token facts', () => {
  const { deployments } = summarizePrometheus(answers(HEALTHY), NOW);
  assert.equal(deployments.length, 1);
  const [deployment] = deployments;
  assert.equal(deployment.id, 'local-llm');
  assert.equal(deployment.name, 'qwen3.8-27b');
  assert.equal(deployment.state, 'busy');
  assert.equal(deployment.gpu.host, 'reef');
  assert.equal(deployment.gpu.devices, 2);
  assert.equal(deployment.gpu.usagePercent, 0);
  assert.equal(deployment.gpu.temperatureC, 41, 'the hotter GPU of the pair is the one to show');
  assert.equal(deployment.gpu.powerW, 63.1);
  assert.equal(deployment.memory.percent, 6.2, 'KV cache usage is the memory fact that exists for vLLM');
  assert.equal(deployment.serving.requestsRunning, 1);
  assert.equal(deployment.serving.promptTokens, 39326940);
  assert.equal(deployment.serving.completionTokens, 1147375);
  assert.equal(Math.round(deployment.serving.specAcceptance * 1000) / 1000, 0.359);
});

test('a TensorFold target is its own deployment and does not borrow reef GPUs', () => {
  const tf = {
    ...HEALTHY,
    'serving.tensorfold': [sample({ job: 'sparks-serving', model: 'deepseek-v4.1-flash', host: 'spark-1' }, 2)],
    'running.tensorfold': [sample({ job: 'sparks-serving' }, 2)],
    'waiting.tensorfold': [sample({ job: 'sparks-serving' }, 0)],
    'promptTokens.tensorfold': [sample({ job: 'sparks-serving' }, 576086)],
    'generationTokens.tensorfold': [sample({ job: 'sparks-serving' }, 120000)],
    'specDraftTokens.tensorfold': [sample({ job: 'sparks-serving' }, 1000)],
    'specAccepted.tensorfold': [sample({ job: 'sparks-serving' }, 359)],
    'kvCache.tensorfold': [sample({ job: 'sparks-serving' }, 0)],
    up: [sample({ job: 'local-llm' }, 1), sample({ job: 'sparks-serving' }, 1)],
  };
  const { deployments } = summarizePrometheus(answers(tf), NOW);
  assert.equal(deployments.length, 2, 'one row per serving job across both families');
  const sparks = deployments.find((deployment) => deployment.id === 'sparks-serving');
  assert.equal(sparks.name, 'deepseek-v4.1-flash', 'the model name comes from the scrape label');
  assert.equal(sparks.serving.backend, 'tensorfold');
  assert.equal(sparks.state, 'busy');
  assert.equal(sparks.gpu.host, 'spark-1');
  assert.equal(sparks.gpu.devices, 0, "reef's DCGM exports are not the Sparks' GPUs");
  assert.equal(sparks.gpu.usagePercent, null);
  assert.equal(sparks.serving.promptTokens, 576086);
  assert.equal(sparks.serving.specAcceptance, 0.359);
  const reef = deployments.find((deployment) => deployment.id === 'local-llm');
  assert.equal(reef.gpu.host, 'reef', 'the unlabelled host still takes the sole DCGM exporter');
});

test('the TP=2 Sparks fold both GB10s into one row with their own thermal data', () => {
  const live = answers({
    'serving.tensorfold': [sample({ job: 'sparks-serving', model: 'deepseek-v4.1-flash', host: 'spark-1' }, 1)],
    'running.tensorfold': [sample({ job: 'sparks-serving' }, 1)],
    'waiting.tensorfold': [sample({ job: 'sparks-serving' }, 0)],
    'promptTokens.tensorfold': [sample({ job: 'sparks-serving' }, 576086)],
    'generationTokens.tensorfold': [sample({ job: 'sparks-serving' }, 2081)],
    'kvCache.tensorfold': [sample({ job: 'sparks-serving' }, 0.02)],
    gpuUtil: [
      sample({ Hostname: 'reef', device: 'nvidia0' }, 0),
      sample({ hostname: 'spark-1', device: 'nvidia0', model: 'deepseek-v4.1-flash' }, 42),
      sample({ hostname: 'spark-2', device: 'nvidia0', model: 'deepseek-v4.1-flash' }, 51),
    ],
    gpuTemp: [
      sample({ Hostname: 'reef', device: 'nvidia0' }, 38),
      sample({ hostname: 'spark-1', device: 'nvidia0' }, 56),
      sample({ hostname: 'spark-2', device: 'nvidia0' }, 61),
    ],
    gpuPower: [sample({ Hostname: 'reef' }, 63), sample({ hostname: 'spark-1' }, 9.3), sample({ hostname: 'spark-2' }, 10.3)],
    gpuXid: [sample({ Hostname: 'reef' }, 0), sample({ hostname: 'spark-1' }, 0), sample({ hostname: 'spark-2' }, 0)],
    cpuTemp: [sample({ host: 'spark-1' }, 73), sample({ host: 'spark-2' }, 68)],
    up: [sample({ job: 'sparks-serving' }, 1)],
  });
  const { deployments } = summarizePrometheus(live, NOW);
  const sparks = deployments[0];
  assert.equal(sparks.id, 'sparks-serving');
  assert.equal(sparks.state, 'busy');
  assert.equal(sparks.gpu.devices, 2, 'both GB10s belong to the one TP=2 deployment');
  assert.equal(sparks.gpu.temperatureC, 61, 'the hotter GB10 is the one to show');
  assert.equal(sparks.gpu.usagePercent, 51);
  assert.equal(sparks.gpu.powerW, 19.6, 'power adds across the pair');
  assert.equal(sparks.cpu.temperatureC, 73, 'the ACPI zone is the thermal limit on GB10');
  assert.equal(sparks.gpu.host, 'spark-1', 'the serving endpoint is the head node');
});

test('decode and prefill report a current rate, with cached prefix tokens excluded', () => {
  const live = answers({
    ...HEALTHY,
    'decode.vllm': [sample({ job: 'local-llm' }, 92.5)],
    'decodeWork.vllm': [sample({ job: 'local-llm' }, 0.925)],
    'prefill.vllm': [sample({ job: 'local-llm' }, 5000)],
    'prefillCached.vllm': [sample({ job: 'local-llm' }, 4900)],
    'prefillWork.vllm': [sample({ job: 'local-llm' }, 1)],
  });
  const [deployment] = summarizePrometheus(live, NOW).deployments;
  assert.equal(deployment.serving.decodeTps, 100, '92.5 tokens over 0.925 s of decoding');
  assert.equal(deployment.serving.prefillTps, 100, 'a cached prefix is not prefill work');

  const idle = answers({ ...HEALTHY, 'decode.vllm': [sample({ job: 'local-llm' }, 0)], 'decodeWork.vllm': [sample({ job: 'local-llm' }, 0)] });
  assert.equal(summarizePrometheus(idle, NOW).deployments[0].serving.decodeTps, null, 'no work is not zero throughput');
});

test('prefill is unknown when cached prompt tokens cannot be excluded', () => {
  for (const family of ['vllm', 'tensorfold']) {
    const fixture = {
      [`serving.${family}`]: [sample({ job: 'model', model: 'test' }, 1)],
      [`prefill.${family}`]: [sample({ job: 'model' }, 640262.67)],
      [`prefillWork.${family}`]: [sample({ job: 'model' }, 1.544)],
      [`decode.${family}`]: [sample({ job: 'model' }, 152)],
      [`decodeWork.${family}`]: [sample({ job: 'model' }, 1.498)],
    };
    const [deployment] = summarizePrometheus(answers(fixture), NOW).deployments;
    assert.equal(deployment.serving.prefillTps, null, `${family}: full prompts are not uncached prefill work`);
    assert.equal(deployment.serving.decodeTps, 101.5, 'decode remains independently measurable');
    fixture[`prefillCached.${family}`] = [sample({ job: 'model' }, 0)];
    fixture[`prefill.${family}`] = [sample({ job: 'model' }, 1000)];
    fixture[`prefillWork.${family}`] = [sample({ job: 'model' }, 1)];
    assert.equal(summarizePrometheus(answers(fixture), NOW).deployments[0].serving.prefillTps, 1000, 'a measured zero cache count differs from a missing count');
  }
});

test('an idle model is idle; a target that stops answering is down', () => {
  const idle = summarizePrometheus(answers({ ...HEALTHY, 'running.vllm': [], 'waiting.vllm': [] }), NOW).deployments[0];
  assert.equal(idle.state, 'idle');
  const down = summarizePrometheus(answers({ ...HEALTHY, up: [sample({ job: 'local-llm' }, 0)] }), NOW).deployments[0];
  assert.equal(down.state, 'down');
  assert.equal(down.online, false);
  assert.match(down.reason, /not answering/);
});

test('a firing alert on the serving job makes it degraded and names it', () => {
  const alerted = {
    ...HEALTHY,
    alerts: [sample({ alertname: 'TargetDown', alertstate: 'firing', severity: 'warning', job: 'local-llm' }, 1, (NOW - 5000) / 1000)],
  };
  const { deployments, conditions } = summarizePrometheus(answers(alerted), NOW);
  assert.equal(deployments[0].state, 'degraded');
  assert.equal(deployments[0].reason, 'TargetDown');
  assert.deepEqual(deployments[0].alerts, ['TargetDown']);
  assert.equal(conditions.length, 1);
  assert.equal(conditions[0].sparkName, 'qwen3.8-27b');
});

test('an alert from another job or from an hour ago does not mark this deployment', () => {
  const stale = {
    ...HEALTHY,
    alerts: [
      sample({ alertname: 'KubeSchedulerDown', alertstate: 'firing', severity: 'critical' }, 1),
      sample({ alertname: 'TargetDown', alertstate: 'firing', job: 'local-llm' }, 1, (NOW - 3_600_000) / 1000),
    ],
  };
  const { deployments, conditions } = summarizePrometheus(answers(stale), NOW);
  assert.equal(deployments[0].state, 'busy');
  assert.deepEqual(conditions, []);
});

test('an Xid on the serving host degrades the deployment', () => {
  const xid = { ...HEALTHY, 'running.vllm': [], gpuXid: [sample({ Hostname: 'reef' }, 2)] };
  assert.equal(summarizePrometheus(answers(xid), NOW).deployments[0].state, 'degraded');
});

test('a fleet reports its worst state, not an average', () => {
  assert.equal(fleetState([{ state: 'idle' }, { state: 'down' }, { state: 'busy' }]), 'down');
  assert.equal(fleetState([{ state: 'idle' }, { state: 'busy' }]), 'busy');
  assert.equal(fleetState([]), 'idle');
});

test('the monitor asks Prometheus every query and caches the answer briefly', async () => {
  const seen = [];
  const monitor = new PrometheusMonitor('http://127.0.0.1:9090', { fetch: stubPrometheus(HEALTHY, seen) });
  const overview = await monitor.overview();
  assert.equal(overview.deployments.length, 1);
  assert.equal(overview.fleetState, 'busy');
  const declared = [...Object.values(QUERIES), ...Object.values(HISTORY_QUERIES)].sort();
  assert.deepEqual(seen.sort(), declared, 'every declared query is asked, instant and trend');
  await monitor.overview();
  assert.equal(seen.length, declared.length, 'the second read is served from cache');
});

test('the overview carries per-deployment historical points without mixing models', async () => {
  const fixtures = { ...HEALTHY,
    'history.decode': [
      { metric: { job: 'local-llm' }, values: [[NOW / 1000 - 30, '92'], [NOW / 1000, '100']] },
      { metric: { job: 'other-model' }, values: [[NOW / 1000, '999']] },
    ],
  };
  const monitor = new PrometheusMonitor('http://127.0.0.1:9090', { fetch: stubPrometheus(fixtures) });
  const [deployment] = (await monitor.overview()).deployments;
  assert.deepEqual(deployment.series.decode, [{ t: NOW - 30000, v: 92 }, { t: NOW, v: 100 }]);
  assert.deepEqual(deployment.series.prefill, [], 'missing data is not invented as zero');
});

test('GPU history uses the hottest and busiest member of the TP pair', () => {
  const result = seriesFor({ id: 'sparks-serving', name: 'deepseek', gpu: { host: 'spark-1' } }, {
    gpuTemp: { data: { result: [
      { metric: { hostname: 'spark-1', model: 'deepseek' }, values: [[100, '55']] },
      { metric: { hostname: 'spark-2', model: 'deepseek' }, values: [[100, '70'], [130, 'NaN']] },
      { metric: { Hostname: 'reef' }, values: [[100, '90']] },
    ] } },
  });
  assert.deepEqual(result.gpuTemp, [{ t: 100000, v: 70 }]);
});

test('failed history leaves live readings available and can recover on the next read', async () => {
  const transport = stubPrometheus(HEALTHY);
  let failed = true;
  const monitor = new PrometheusMonitor('http://127.0.0.1:9090', { fetch: (url) =>
    failed && new URL(url).pathname.endsWith('/query_range')
      ? Promise.resolve(new Response('unavailable', { status: 503 })) : transport(url) });
  const overview = await monitor.overview();
  assert.equal(overview.deployments[0].state, 'busy');
  assert.deepEqual(overview.deployments[0].series.decode, []);
  failed = false;
  assert.equal((await monitor.range('decode')).status, 'success');
});

test('a Prometheus that cannot be reached is reported, not rendered as a healthy fleet', async () => {
  const monitor = new PrometheusMonitor('http://127.0.0.1:9090', { fetch: async () => { throw new Error('connect ECONNREFUSED'); } });
  await assert.rejects(monitor.overview(), /not reachable/);
});

test('the agent tool answers for one deployment and refuses an unknown one', async () => {
  const tool = sparksTool(new PrometheusMonitor('http://127.0.0.1:9090', { fetch: stubPrometheus(HEALTHY) }));
  const result = await tool.execute({ deployment: 'local-llm' }, {});
  assert.equal(result.deployments.length, 1);
  assert.equal(result.deployments[0].serving.modelId, 'qwen3.8-27b');
  await assert.rejects(tool.execute({ deployment: 'nowhere' }, {}), /no deployment "nowhere"; known deployments: local-llm/);
});

test('the plugin mounts a sparks Service the Typert Gateway can discover', () => {
  const mounted = [];
  const registered = [];
  const tools = { register: (definition) => { registered.push(definition.name); return () => {}; } };
  const ctx = {
    effect: (callback) => callback(),
    plugin: (plugin) => { mounted.push(plugin); },
    inject: (deps, callback) => { if (deps.includes('tools')) callback({ effect: (fn) => fn(), tools }); return () => {}; },
  };
  apply(ctx, { baseUrl: 'http://127.0.0.1:9090', tool: false });
  assert.equal(mounted.length, 1, 'the plugin mounts one Service');
  const Service = mounted[0];
  const marker = Service.prototype['@deepseek-ai/dsh-typert-protocol/remote-methods'];
  assert.ok(marker, 'the method marker is what the Gateway reads to expose the Remote namespace');
  assert.deepEqual(marker.methods.map((method) => method.method), ['overview']);
  assert.equal(typeof Service.prototype.overview, 'function');
  assert.deepEqual(registered, [], 'tool: false keeps the page without the agent tool');
  apply(ctx, { baseUrl: 'http://127.0.0.1:9090' });
  assert.deepEqual(registered, ['local_models'], 'the tool is registered by default');
  apply({ ...ctx, inject: () => () => {} }, { baseUrl: 'http://127.0.0.1:9090' });
  assert.equal(mounted.length, 3, 'a profile without a tool registry still serves the page');
});

test('formatTokens keeps a short count', () => {
  assert.equal(formatTokens(0), '0');
  assert.equal(formatTokens(1147375), '1.1M');
  assert.equal(formatTokens(39326940), '39.3M');
  assert.equal(formatTokens(4611971753), '4.6B');
});

test('live: the tunnel reaches reef Prometheus and every query is valid PromQL there', async (t) => {
  const tunnel = new SshTunnel(process.env.SPARKS_SSH ?? 'mobrienv@reef');
  try {
    let origin;
    try {
      origin = await tunnel.open();
    } catch (error) {
      t.skip(`no SSH access to reef from this machine: ${error.message}`);
      return;
    }
    const monitor = new PrometheusMonitor(() => Promise.resolve(origin));
    for (const name of Object.keys(QUERIES)) {
      const payload = await monitor.query(name);
      assert.equal(payload.status, 'success', `${name} is valid PromQL: ${QUERIES[name]}`);
    }
    for (const name of Object.keys(HISTORY_QUERIES)) {
      const payload = await monitor.range(name);
      assert.equal(payload.status, 'success', `${name} history is valid PromQL`);
      assert.equal(payload.data.resultType, 'matrix');
    }
    const overview = await monitor.overview();
    assert.ok(Array.isArray(overview.deployments));
    assert.ok(overview.deployments.length > 0, 'Prometheus has at least one serving series');
    assert.ok(['down', 'degraded', 'busy', 'idle'].includes(overview.fleetState));
  } finally {
    tunnel.close();
  }
});
