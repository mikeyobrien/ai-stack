# Local Models

The **Local Models** sidebar page shows model-serving deployments from
Prometheus: vLLM on reef and TensorFold across the Sparks. Each card shows
state, requests in flight, GPU and CPU readings, throughput, and speculative
decoding acceptance. Firing alerts that name a serving job mark it degraded.

Four graphs show the last hour of decode throughput, prefill throughput,
GPU temperature, and GPU utilization, sampled every 30 seconds. The page
refreshes every 15 seconds while open. Throughput uses tokens per second of
actual decode/prefill work, matching the cards; missing samples remain gaps,
not invented zeros. Hover a point for its time and value. GPU graphs show the
hottest/busiest member of a multi-host model deployment. Prefill requires a
cached-token count so reused prompts are excluded; TensorFold 1.0.12 does not
export that count in Prometheus, so its prefill speed is unavailable.

The `local_models` agent tool reads the same monitor.

## Where the numbers come from

Prometheus in reef's k3s (`kube-prometheus-stack`, service
`kube-prometheus-stack-prometheus`). It is a ClusterIP, so the plugin opens a
private SSH tunnel to reef and queries `10.43.152.17:9090` through it. Nothing
listens on reef's network for this plugin, and nothing is exposed to the
tailnet.

| Fact | Series |
|---|---|
| Deployments | `count by (job, model_name) (vllm:num_requests_running)` |
| Requests | `vllm:num_requests_running`, `vllm:num_requests_waiting` |
| Tokens | `vllm:prompt_tokens_total`, `vllm:generation_tokens_total` |
| Memory | `vllm:kv_cache_usage_perc` (KV cache) |
| Spec acceptance | `vllm:spec_decode_num_accepted_tokens_total / vllm:spec_decode_num_draft_tokens_total` |
| GPU | `DCGM_FI_DEV_GPU_UTIL`, `DCGM_FI_DEV_GPU_TEMP`, `DCGM_FI_DEV_POWER_USAGE`, `DCGM_FI_DEV_XID_ERRORS` |
| Health | `up`, `ALERTS{alertstate="firing"}` |

The full PromQL is exported as `QUERIES` from `index.js`; paste any one into
Prometheus to check the page against the source.

## States

| State | Meaning |
|---|---|
| `down` | the serving target is not up |
| `degraded` | a firing alert names this job, or its host reports an Xid |
| `busy` | a request is running or waiting |
| `idle` | nothing in flight |

## Configuration

| Key | Default | Purpose |
|---|---|---|
| `baseUrl` | — | Prometheus origin, to skip the tunnel |
| `ssh` | `mobrienv@reef` | SSH destination for the tunnel |
| `target` | `10.43.152.17:9090` | remote address behind the tunnel |
| `tool` | `true` | register the `local_models` tool |

## Tests

```sh
node --test test/
```

The last test opens the real tunnel and runs every query against the live
Prometheus, so a renamed series fails here rather than blanking the page. It
skips when reef is not reachable over SSH.

## Client boot contract
Mount the overview descriptor with ctx.remote.$mount before injecting the
remote.sparks face. Root dependencies are slots, locale and remote; waiting
on the unmounted face at root deadlocks boot. Use React hooks only in page
components, not Cordis apply. Register the English dictionary in the sparks
locale namespace before binding. Regression command: node --test test/*.test.js
