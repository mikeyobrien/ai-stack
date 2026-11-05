# dsh-kwgt-feed

One headerless GET that serves DSH state to phone widgets:

    GET /kwgt/feed.json
    → {"stamp":1763133521,"agents":2,"sessions":9,
       "recent":["‣ Improve Mobile… · 4m"],
       "text":"2 agents live · 9 sessions\n‣ Improve Mobile… · 4m\n…"}

- Auth: none needed on the tailnet — the auth-proxy signs every request with
  the profile browser-session secret; on-host callers go through
  `connection.authorizeIndex` like every other route.
- Polling: Kustom `$wg()` caches per-URL, so append a tick query param
  (`?t=…`) in the widget formula. Snapshots cache server-side for 30s.
- Staleness: compare `stamp` against widget time; One UI doze can silence
  polls for minutes to hours — whitelist Kustom, don't fight it.
