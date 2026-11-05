# Model Labels

Tags the composer's model selector, so the list says where each model is
served: **Local** for a model running on this machine, **Remote** for one
running in the Sparks cluster. The tag follows the model, not the provider —
the `sparks` route serves one of each.

| Model | Served by | Tag |
|---|---|---|
| `qwen3.8-27b` | reef's vLLM, outside k3s | Local |
| `deepseek-v4.1-flash` | TensorFold on `spark-1` | Remote |

The tag shows in all three places the selector labels a model: the composer's
model control, the current-model row of its menu, and each model option.

## How a model is placed

`PLACEMENTS` in `client.js` names the two served models. Any other model on a
serving route (`sparks`, `reef`, `local`) falls back to the host its endpoint
names: `spark-1` is the cluster, anything else is a machine here. A model the
plugin cannot place — an API provider's model, or a serving route with no host
— keeps its catalog name and gets no tag, so a new model never gets a guess.

## Files

| File | Purpose |
|---|---|
| `index.js` | Host half; the Client module owns the label |
| `client.js` | the `conversation.input.model.label` contribution |
| `cordis.patch.yml` | the profile row that mounts it |
| `locale/en.json` | the two tag words |

## Tests

```sh
node --test test/
```
