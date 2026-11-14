# @local/dsh-session-semantic-search

Hybrid session search for DSH: dense-vector recall layered on the shipped SQLite
full-text index and fused by reciprocal rank, with a silent full-text-only
fallback whenever the vector path cannot answer.

`ctx.sessionQuery` is still one provider. Everything except `searchSessions`
delegates to the concrete `@deepseek-ai/dsh-session-query-sqlite` engine, which
this package constructs internally on an isolated `sessionQuery` realm. So exact
reads, traces, filters, titles, and error codes keep their native behavior.
`searchSessions` returns native-shaped pages with this package's own cursors
(see **Search** below).

## How it works

```
query ─┬─ inner SQLite FTS    (first 50) ─┐
       │                                  ├─ RRF (k=60) ─┐
       └─ sidecar cosine scan (top 50)   ─┘              ├─ stream ─ page + native hit shape
          inner SQLite FTS    (rank 51+) ────────────────┘
```

- **Ingest**: scans `$DSH_HOME/sessions/**/*.jsonl[.zstd]`, builds the
  same first-party semantic documents the native index uses
  (`buildSessionEventSearchDocuments`), keeps current-surface `user/message` and
  `assistant/message` events, splits text longer than 1200 code points at
  whitespace, and stores one row per chunk in SQLite.
  Files without a session header are ignored.
- **Embeddings**: `POST <endpointUrl>` with `nomic-embed-text-v1.5`, at most 16
  inputs per request, `search_document: ` / `search_query: ` prefixes. Document
  batches go one request at a time. 429, 5xx, and network failures retry after
  30 s doubling to 5 min, or after `Retry-After`; the wait between attempts
  does not hold the queue and ends at once on shutdown. Any other 4xx, or a
  malformed or wrong-dimension response, is a refusal: the batch is split in
  half until each refused chunk stands alone, that chunk is marked failed and
  skipped for 24 h (or until its text changes), and the rest are stored. A
  probe input is sent first, so an endpoint that refuses everything (wrong URL,
  model, or `dim`) marks nothing and leaves the corpus pending. There are no
  new runtime dependencies: the sidecar uses `node:sqlite` and `node:zlib`.
- **Search**: the native FTS read and the query embedding run concurrently.
  The query embedding never joins the document queue; it has one total budget
  of `queryTimeoutMs` (1.5 s), after which the search serves full text. The
  first `ftsCandidates` (50) native hits and the top `vectorCandidates` (50)
  vector candidates (best chunk per session) are fused as
  `1/(60 + rank_fts) + 1/(60 + rank_vec)`; every later native hit follows in
  native order. A session found by both sides outranks a session found by only
  one. With no vector candidates the stream is the native order itself. Pages
  are native `{ items, nextCursor }`; `nextCursor` appears exactly when more
  results exist.
- **Cursors**: a cursor names the stream it continues, `fts` or `hybrid`, so a
  page served from full text alone keeps paging full text even after vectors
  become available, and a hybrid page keeps the fused order. Both streams are
  fixed by the corpus, not by the page offset, so every match is served exactly
  once. A hybrid page reuses its first page's query vector (the last 32 queries
  are kept in memory), so it continues even if the endpoint goes down between
  pages.
- **Convergence**: all progress is database state (`files` offsets, `chunks.vec`,
  `embedded_at`). A crash mid-batch leaves the unembedded chunks pending and the
  next poll finishes them. A single-writer lock file prevents two processes
  from embedding at once; the others only search the shared index.

## Mounting

The package is an installable bundle; its `cordis.patch.yml` performs the
replacement described below. Installing it as a profile dependency applies that
patch layer.

The **exact user patch** for `~/.dsh/profiles/web/cordis.patch.yml` is:

```yaml
- id: session-query-sqlite
  disabled: true
- insert:
    - id: session-query-semantic
      name: '@local/dsh-session-semantic-search'
```

Why not replace the row in place: the host row id is `session-query-sqlite`
(`@deepseek-ai/dsh-session-query-sqlite`, applied by the `dsh-web-app` bundle).
A Cordis patch can set an existing row's fields, but a truthy `name` **asserts**
the current plugin name instead of renaming the row, and `config` is replaced
wholesale rather than merged (dsh-app-boot README: "A user patch replaces the
whole matched config — an id-targeted patch does not deep-merge"; patch schema:
"A truthy `name` asserts the existing plugin name rather than renaming it").
Disabling the host row by id and inserting this package is therefore the only
legal by-id replacement, and it also means the inner SQLite engine must be
constructed by this package rather than by a second profile row.

The shipped Web profile configures that row as `path: ':memory:'`,
`openAt: never`, which disables full-text search. Replacing the row turns the
native backend back on at `$DSH_HOME/embeddings/session-query.sqlite` by default.

The embeddings endpoint is any OpenAI-compatible `/v1/embeddings` server. It
defaults to `http://127.0.0.1:8890/v1/embeddings`; set `DSH_EMBED_ENDPOINT` in
the DSH environment, or `endpointUrl` below, to point elsewhere (`endpointUrl`
wins).

Optional knobs (all defaulted, so the insert above is complete):

```yaml
- insert:
    - id: session-query-semantic
      name: '@local/dsh-session-semantic-search'
      config:
        endpointUrl: 'http://127.0.0.1:8890/v1/embeddings'
        model: 'nomic-embed-text-v1.5'
        dim: 768
        ftsPath: '~/.dsh/embeddings/session-query.sqlite'   # path, not expanded; use an absolute path
        ftsCandidates: 50
        vectorCandidates: 50
        rrfK: 60
        pollSeconds: 120
        queryTimeoutMs: 1500
        embedBatchSize: 16
        indexer: true
```

Configuration is validated with the harness's Schemastery `z` (the DSH
equivalent of zod; `zod` is not a DSH dependency).

## Failure modes

| Condition | Behavior |
| --- | --- |
| Endpoint down, timeout, 429/5xx | Query embedding fails within `queryTimeoutMs`; `searchSessions` serves the full-text stream. The document pass stops and its chunks stay pending for the next poll. |
| Indexer batch waiting out a retry | Searches are unaffected: query embeddings do not queue behind document batches. |
| Endpoint refuses one chunk (4xx, too large, bad shape or dimension) | That chunk is isolated, logged, and skipped for 24 h or until its text changes; the rest are embedded. |
| Endpoint refuses every input | Nothing is skipped; the pass stops and logs; chunks stay pending until the endpoint is fixed. |
| Sidecar database missing, unreadable, or empty | Vector candidates are empty; full-text stream. |
| Query embedding slower than `queryTimeoutMs` | Abandoned at the budget; full-text stream. |
| Inner engine configured `openAt: never` | Treated as an empty FTS side; vector matches are still served. |
| Inner engine returns any other error | Propagated unchanged (validation, not-found, abort). |
| Hybrid cursor whose vector side cannot be reproduced, or whose served prefix changed | `SESSION_QUERY_STALE_CURSOR`; restart the search. |
| Event filter the sidecar cannot express | Matches no vector chunk, so vector-only hits never violate it. `seq`, `time`, `type`, and `surface` are applied. |
| Another process holds the writer lock | This process searches the shared index and never writes. |
| `indexer: false` | No ingest or lock; an existing index is opened read-only for search. |
| A session log cannot be read, parsed, or its surface folded | Skipped and logged once; the rest of the corpus is indexed. |
| Embedding model or dimension changes | A process with a different `model`/`dim` does not search the stored vectors. Only the writer-lock holder discards them, then re-embeds. |
| Vector table row has a malformed blob | Ignored at scan time. |

## Operations

- **First index**: builds automatically on plugin activation (lock, schema,
  then `runOnce` in the background). It never delays or fails activation.
- **Progress**: `sqlite3 $DSH_HOME/embeddings/session-vectors.sqlite
  "SELECT COUNT(*), COUNT(vec), COUNT(embed_failed_at) FROM chunks"`. Pending
  chunks are retried every `pollSeconds`. Refused chunks and why:
  `SELECT id, embed_error FROM chunks WHERE embed_failed_at IS NOT NULL`; set
  `embed_failed_at = NULL` to retry them sooner.
- **Rebuild vectors**: stop DSH, delete `session-vectors.sqlite` (+ `-wal`,
  `-shm`), start again. The FTS index (`embeddings/session-query.sqlite`) is a
  disposable derived index and self-heals on schema mismatch.
- **Model change**: edit `model`/`dim`; vectors are discarded and re-embedded
  automatically. Keep `dim` equal to the endpoint's dimension.
- **Lock**: `$DSH_HOME/embeddings/session-vectors.lock` holds
  `{"pid":…,"startedAt":…}` (epoch ms). A lock whose pid no longer exists, or
  one left empty or unparseable for over 10 s (a crash mid-write), is
  reclaimed. A live pid blocks writes only. The holder re-checks the file every
  pass and stops writing if it was replaced.
- **Tests**: `node --test test/*.test.js` (54 tests, ~6 s, local fixtures only).
- **Eval**: `node eval/golden.mjs` uses the endpoint from `DSH_EMBED_ENDPOINT`
  (default `http://127.0.0.1:8890/v1/embeddings`) when reachable; `--offline`
  uses a local bag stand-in.
- **Do not mount two copies**: one plugin row owns `ctx.sessionQuery`.

## Measured behavior

Golden paraphrase eval (`node eval/golden.mjs`, 12 pairs, real endpoint):
`hit@1 fts 0/12, hybrid 12/12`, 12 strict wins, 0 regressions → PASS. Offline
stand-in: `hybrid 9/12`, PASS. Full-text is phrase matching, so any reworded
query misses it (`"release the app"` does not match "deploy the app"); the
vector side recovers those.

A sidecar pass over a real 6,677-event session log indexed 1,140 chunks in
seconds; a second pass did no work.

## Limitations

- **Deep pages re-read the ranking.** Each page re-reads the native ranking from
  the top through its last position (in native pages of at most the inner
  `maxLimit`) and, for a hybrid stream, re-runs the vector scan, so cost grows
  with page depth. The Web controller only asks for 21.
- **Cursors are per-request and prefix-bound.** A cursor carries a digest of
  the session ids that fixed the order of everything served so far: the native
  hits through the last served position and, for a hybrid stream, the head
  size and the vector candidate order. If those change between pages,
  `SESSION_QUERY_STALE_CURSOR` is raised, which the controller handles by
  restarting the search; changes past the served prefix are picked up without
  one. Cursors do not survive a restart (the native ones do not either).
- **Live sessions lag.** The sidecar indexes persisted files, so a live session
  gets vector recall only after its log is persisted. Vector-only hits report
  `live: false, persisted: true`; native FTS hits keep their real flags.
- **Changed logs are re-read whole.** DSH writes
  `sessions/<slug>/session-<id>/session.v4.jsonl.zstd`, where surface folding
  needs the complete log and zstd frames are not byte-append-safe, so a changed
  file is re-parsed in full. Dedupe is by `UNIQUE(session_id, seq, chunk_index)`
  and only unembedded chunks are sent again, so no duplicate rows and no
  re-embedding occur. File `size`/`mtime` still skip unchanged files.
- **Only messages are vector-indexed.** Tool calls/results, thinking text, and
  structural events are excluded, matching the types the session-search API
  accepts (`bestMatch.surface === "current"`, message types only).
- **Low-similarity vector tail.** The top `vectorCandidates` sessions always
  participate, so the fused tail can hold weakly related sessions that FTS
  missed. RRF keeps them below agreeing and stronger hits; the API truncates to
  21 results.
- **One embedding model, one dimension (768).** A different dimension requires
  editing `dim` (vectors rebuild), and mixed models cannot be served at once.
- **Not yet exercised in a running DSH host.** The plugin wiring is covered by a
  test that constructs it on a real Cordis context and searches through the
  real SQLite engine.

## Verified by

```
$ node --test test/*.test.js
ℹ tests 54   ℹ pass 54   ℹ fail 0

$ node eval/golden.mjs --offline
hit@1  fts 0/12  hybrid 9/12
strict wins 9/12, regressions 0, gate PASS
```
