# dsh-opencode-suite

**One DeepSeek Harness plugin that does everything OpenCode needs.**

It covers four things that would otherwise be four separate installs:

- a pooled, quota-aware key rotator behind one OpenCode Zen route
- per-session request headers for gateway affinity and accounting
- both Zen model tiers managed from one card, in both directions
- a usage dashboard and seven agent tools for all of the above

One plugin row, one settings namespace (`opencode-suite`), one Remote
(`opencodeSuite`), one settings page, seven agent tools.

```sh
dsh plugin --profile <name> add dsh-opencode-suite
```

> Chinese documentation: [README.zh.md](README.zh.md)

---

## What it gives you

- **Automatic key rotation.** Several OpenCode Go accounts behind one route. When
  a key runs out of quota or its credential is rejected, the request moves to the
  next usable key **before any content is produced**, so the failed attempt is
  invisible in the transcript.
- **A usage dashboard.** 5-hour rolling / weekly / monthly used-percent bars per
  key, plus reset countdowns, taken from the OpenCode usage endpoint.
- **Both model tiers in one card.** The Go tier is served by this plugin, so its
  catalog is managed here (selection, image capability, real capacities). The
  free tier belongs to `llm-pi-ai`, so only its model list is read and written,
  through the settings seam.
- **Session identity on the wire.** The harness session id (hashed to a short
  digest by default) rides out on the requests sent to `opencode.ai`, so the
  gateway can do per-session affinity and accounting. Request headers only.
- **Agent tools.** The model can inspect and repair the pool and both catalogs
  without opening a browser.

## The two tiers, plainly

The two OpenCode Zen routes are **not "a free quota plus a paid quota"** — they
are not the same kind of thing:

| Route | What it is | Endpoint | Model ids | "Quota" |
| --- | --- | --- | --- | --- |
| `opencode` | A pay-as-you-go **price list**, some rows priced `Free` | `https://opencode.ai/zen/v1` | `big-pickle` has no suffix; the rest of the free rows end in `-free` | none |
| `opencode-go` | The **Go subscription** | `https://opencode.ai/zen/go/v1` | unsuffixed | 5-hour rolling / weekly / monthly — what this plugin rotates on |

Details worth internalising:

- **"Free tier" is a per-model price attribute, not a free allowance you can
  spend.** The live `zen/v1/models` listing currently advertises 70 ids, of which
  only 6 carry an official `Free` price (`big-pickle`, `mimo-v2.5-free`,
  `ling-3.0-flash-fin-free`, `nemotron-3-ultra-free`,
  `nemotron-3.5-lightning-free`, `muse-spark-1.3-contributor-free`). The other 64
  (Claude, GPT, Gemini, …) sit behind the same endpoint and are **billed per
  token**. The listing discloses ids only, never prices, so the plugin gates on an
  official allowlist instead of guessing.
- **A `-free` suffix does not imply free of charge.** `big-pickle` is free with no
  suffix; conversely `deepseek-v4-flash-free` and
  `muse-spark-1.2-contributor-free` carry the suffix but are absent from the free
  pricing rows, so this plugin never offers them as free. Ids you configured by
  hand are exempt and stay managed either way.
- **The free set rotates.** Upstream replaces limited-time models
  (`muse-spark-1.2-contributor-free` → `muse-spark-1.3-contributor-free`) and
  keeps a separate "Deprecated models" table. A hard-coded allowlist always goes
  stale, which is why the drift check on this page reads the live listing.
- **The percentages in your pool belong to the Go tier, not the free tier.** The
  5-hour / weekly / monthly windows are subscription usage; the free tier has no
  such concept.

## Requirements

- DeepSeek Harness `0.1.5-rc.1` or newer (the pins in `package.json`).
- Node `>= 20`.
- At least one OpenCode Go API key, and/or the free tier already configured.
- The web profile, if you want the settings page. The host half works headless.

## Install

```sh
dsh plugin --profile <name> add dsh-opencode-suite
```

`add file:/absolute/path` works the same way for a local checkout.

**Installing by hand when pnpm versions disagree.** `dsh plugin` is a thin pnpm
forwarder, so it runs whatever pnpm the *invoking* directory resolves to. From
the harness source tree, the harness's own `packageManager` makes it a different
pnpm major than the one that built the profile's `node_modules`, and the
forwarded install fails outright:

```
[ERR_PNPM_UNEXPECTED_STORE] Unexpected store location
... currently linked from the store at .../store/v10
pnpm now wants to use the store at .../store/v11
```

Do not reinstall the whole profile to fix that — it rewrites the lockfile and
churns every other plugin. Run a plain install inside the profile directory with
the pnpm that profile already owns; it does exactly what the forwarder does,
minus the automatic bundle reconciliation:

```sh
cd ~/.dsh/profiles/<name>
# write the dependency and dsh.profile.bundles entry first, then:
pnpm install
```

Then **remove the `opencode-go` supplier row from Settings → Models.** The pool
serves that route; while another adapter still owns it this plugin stays dormant
and the page shows the takeover hint. Existing conversations need no changes.

The free route `opencode` keeps its `llm-pi-ai` row — this plugin only touches
its model list.

Add keys either on the settings page (*Key management*) or with the
`oc_suite_status` / `oc_suite_pool` tools. Secrets go through the credentials
service under each key's reference name; they never enter settings, logs, or any
response.

## Configuration

Every key is optional; the defaults are what the bundle patch inserts.

```yaml
- id: opencode-suite
  name: 'dsh-opencode-suite'
  config:
    route: opencode-go            # opencode-suite-go for a private route
    keys: []                      # {id, label, apiKeyEnv}; managed from the card
    preemptAtPercent: 100         # 100 = switch only on failure
    switchAfterConsecutiveFailures: 0   # 0 = off
    modelMode: all                # all = follow the catalog; custom = `models`
    models: []
    imageModels: []               # ids to declare image-capable
    modelCapacities: {}           # {id: {contextWindow, maxTokens}}
    usageBaseUrl: https://opencode.ai/zen/go/v1/usage
    modelsBaseUrl: https://opencode.ai/zen/go/v1/models
    freeModelsBaseUrl: https://opencode.ai/zen/v1/models
    usageRefreshMs: 30000
    timeoutMs: 15000
    usageLogEnabled: true          # local day × model token accounting
    usageLogSource: live           # live = count this host's streams; log = fold the session log
    usageLogWindowDays: 7          # days the card and the tool report
    usageLogRetentionDays: 90      # day buckets kept; the horizon, not the window
    usageLogSessionsPerSweep: 12   # changed sessions one refresh may open
    usageLogSweepMaxMs: 4000       # wall clock one refresh may spend folding them
    modelWatchEnabled: true        # poll both listings for new / delisted ids
    modelWatchIntervalMs: 900000   # 15 min
    notifyImEnabled: false         # push new-model news over the IM plugin
    notifyImBotId: ''              # chosen in the card from listBots()
    notifyImTargetId: ''           # chosen in the card from listTargets()
    sessionHeaders:
      enabled: true               # on by default
      nanoidSessionId: true
      nanoidLength: 8             # 4..32
      nanoidAlphabet: alphanumeric  # or urlsafe
      seedSessionId: false
      verbose: false
      providers: [opencode, opencode-go]
      hosts: [opencode.ai]
      baseURLs: []
      headers: [x-opencode-session, x-session-affinity, x-client-request-id, x-session-id]
      extraHeaders: {}
      userAgent: ''
      disableFetchInjection: false
```

`preemptAtPercent` is the *avoidance* rule: switch ahead once the 5-hour rolling
**or** weekly window reaches the threshold. `switchAfterConsecutiveFailures`
counts non-quota failures (rate limit / server / timeout). Quota exhaustion and
invalid credentials always switch immediately, whatever these are set to.

### Image input declarations

The upstream `models` endpoint publishes ids only and **declares no model as
image-capable**, so every model adopted into the Go tier reads as text-only —
`read_image` and pasted images are refused for it. The declaration is per model,
and all four entry points write the same `imageModels` list:

| Entry point | How |
| --- | --- |
| Settings page | an "Image" checkbox per model on the Go-tier card |
| Config | `imageModels: [id, ...]` |
| Tool | an `oc_model_add` entry with `input: ['text', 'image']` |
| RPC | `putConfig({ imageModels: [...] })` |

A save applies immediately — no restart, no reconnect. Models the catalog itself
already declares image-capable need no declaration here (the card shows them as
catalog-declared), and a save writes **only what the catalog does not declare**,
so refreshing the catalog never wipes what you declared by hand.

The request-side image budget is a separate trio of constants
(`maxRequestImageBytes` 20 MiB, `requestImagePixelBudget` 2048×2048,
`requestImageMaxBytes` 1 MiB), applied per route.

## The settings page

**Settings → OpenCode 套件** (one sidebar entry, id `opencode-suite`) stacks:

1. **Composer dock** — under the composer, beside the stats pills: today's token
   total with its source, and a dot with the count of unhandled new models.
   Clicking the dot suppresses it there; it never clears the host's work list,
   which is what the watch card below acts on. Client-only, no host restart.
2. **New-model watch** — what the background listing check is holding (see below).
2. **Takeover banner** — serving / waiting, the active key, the current switch
   policy, the last switch and its reason.
2. **Go tier model selection** — *all models* or a custom set, per-model image
   declaration, *fetch models* against the live endpoint, and a capacity editor
   (see below).
3. **Switching strategy** — the two auto-switch rules.
4. **One card per key** — usage bars, state badge, and only the actions that
   state allows (switch / disable / enable / clear-invalid / clear-exhausted).
5. **Key management** — add, rename, paste a secret, delete.
6. **Local usage (day × model)** — the token accounting described below.
7. **Free tier models** — configured vs online, adopt an online model by
   checking it, drop a configured one by unchecking it, plus the delisted rows
   and the settings revision.
8. **Session headers** — the master switch, digest length/alphabet, seed and
   verbose toggles, matched routes/hosts/headers, extra fixed headers, a
   User-Agent override, and the last 20 injections with their URL, header names,
   session id, digest and any error.

## New-model watch

A model that ships overnight is invisible until somebody opens the page: the
drift report in `oc_model_status` and in the card is recomputed only when it is
asked for. The watch closes that gap by polling both tiers' listings on a timer
(`modelWatchIntervalMs`, default 15 minutes) and remembering what it has already
seen in `$DSH_HOME/opencode-suite.watched.json`.

- The **first pass is a baseline**, not an announcement: a fresh install, a
  deleted state file, and a restart all adopt whatever is online silently.
- After that, each new id is announced **once**, stamped with when it was first
  seen, and stays on the card until you act. A delisted id is reported the same
  way; one that comes back is news again.
- The card (**模型上新提醒 / New models**) lists both tiers with per-tier
  actions: *fetch into the Go tier*, *adopt into the free tier*, or *dismiss*.
  `oc_model_status` and `oc_suite_status` report the same news in text, and a
  pass that finds something also logs one line, so a headless run learns about
  it without a page.
- Dismissing clears the notice, not the seen set: a dismissed id is not
  re-announced until it leaves and comes back.
- A tier that fails to answer is recorded as an error and never blocks the other
  one.

What it does **not** do: push anything to a chat app or a notification service.
The page banner, the tool output, and the log line are the three surfaces.

## Local usage, by day and by model

The Go usage endpoint answers exactly one question — how much of each plan
window a **key** has spent — and it answers it as a percentage. It publishes no
token counts and no model breakdown, so "which model burns the window" cannot
come from there. That answer comes from the log this harness already writes: each
`assistant/message` carries the model that produced it and the provider's own
`usage` numbers.

The **Local usage** card folds them per local calendar day and per model, and
reports a window of 1 / 7 / 30 / 90 days:

- a day strip, so a spike is visible without reading the table;
- a model table — calls, input, cache read, output, total, and share;
- the cache share of all tokens, which on a subscription is the number that
  actually moves the plan window;
- the sweep state, so "how much of the store is folded" is never a guess.

**Two sources, one set of numbers.** `usageLogSource` picks where they come
from, and a deployment picks one because a call seen by both would count twice:

| Source | What it counts | What it costs | What it misses |
| --- | --- | --- | --- |
| `live` (default) | every usage report this host's own streams emit, folded as each turn ends | nothing — it rides the `llm/stream` interception the suite already has for session headers | anything from before the plugin was on, and anything another process streamed |
| `log` | one completed model answer per `assistant/message` in the durable session log | bounded per refresh, but the first pass over a large store takes minutes and spreads over refreshes | a retried attempt that produced no message |

Day keys are **local** dates, so "today" means your today. Subagent sessions are
counted in both sources, because their calls draw on the same plan.

The live source lives in memory between turns, so it is flushed to
`$DSH_HOME/opencode-suite.usage.json` (throttled, and once more on shutdown) and
seeded from that file on start: a host restart does not erase the day. A missing
or corrupt file just starts the count from what this run sees.

**Cost of a `log` refresh.** A session whose revision token did not move is
skipped outright, and a session that grew is read from the offset the ledger last
reached, so an unchanged day costs nothing. One refresh opens at most
`usageLogSessionsPerSweep` changed sessions and spends at most
`usageLogSweepMaxMs` on them, fastest-growing first; the rest stay queued and
`sweep.complete` says so. On a store with thousands of sessions the first full
accounting converges over several card refreshes rather than in one blocking
pass — measured on a 1,487-session store, a refresh folds about a dozen sessions
in ~5 s, so a cold pass takes minutes. A session that fails to fold three times
in a row is set aside until its log moves again, so one permanently unreadable
log cannot hold the sweep open forever.

## Capacities

The models endpoint discloses **ids only** — never context windows. So:

- a model the shipped catalog describes keeps the catalog's numbers (read-only);
- a dynamically fetched model rides the documented defaults (128k context /
  32k output) and is labelled *default* in the capacity editor;
- typing the real numbers there writes `modelCapacities` and is effective on the
  next request. A corrected row is labelled *corrected*.

A save always sends the **whole** map, because the host replaces the dict
wholesale — a partial patch would silently un-correct the other rows.

## Agent tools

| Tool | What it does |
| --- | --- |
| `oc_suite_status` | takeover state, pool roster + per-key quota, exposed models, free-tier drift |
| `oc_suite_pool` | `switch` / `disable` / `enable` / `clear-invalid` / `clear-exhausted` |
| `oc_usage_models` | local tokens per day and per model — the only per-model answer available |
| `oc_model_status` | per-tier configured vs live listing, with the drift |
| `oc_model_add` | adopt live ids or full entries into one tier |
| `oc_model_remove` | drop ids from one tier |
| `oc_model_sync` | preview (or `apply`) the online↔configured sync for both tiers |

The four `oc_model_*` names are the suite's canonical model-tool names.

## How it works

**Key selection.** The pool keeps one active key. A call resolves the key's
secret through the credentials service, streams, and — if the failure arrives
before the first content chunk — rotates to the next usable key and retries
silently. A failure after content has been surfaced is reported rather than
retried, because the transcript is already partial. States are `healthy`,
`exhausted`, `invalid`, `disabled`; a quota-exhausted key revives by itself once
the rolling window resets and the usage endpoint says so.

**Session headers.** Two cooperating pieces: the `llm/stream` waterfall records
which session a streamed call belongs to (an `AsyncLocalStorage` scope), and a
`globalThis.fetch` wrapper adds the headers to the requests whose URL matches
`hosts`/`baseURLs` for a matching provider. Only request headers change; the body
and the response are untouched. The digest is a deterministic SHA-256 walk over
the session id, so one conversation always maps to one wire id.

**Route ownership.** The plugin registers its adapter when the route is free and
re-tries on `llm/adapters-updated`, so removing the `llm-pi-ai` supplier row at
runtime is enough — no restart.

## Migrating from separate OpenCode plugins

1. Remove every other OpenCode plugin from the profile's
   `dsh.profile.bundles` — one route must have exactly one owner.
2. Remove their leftover rows from `~/.dsh/settings.yaml` if the boot wrote any.
3. Install this plugin and add your keys on the settings page.
4. Remove the `opencode-go` supplier row (the suite takes the route over).
5. Re-enter any model capacities you had set elsewhere in the capacity editor —
   the suite keeps its own storage.
6. Re-check the per-model image declarations in the Go-tier model card; they
   live in this plugin's config, not in `llm-pi-ai`.
7. **Carry over the fetched-lineup cache.** This is the step that fails
   *silently* — you just get fewer models. Sibling OpenCode plugins cache the
   fetched lineup as a flat `[{id, name}]` array at
   `$DSH_HOME/<plugin>.models.json`; this suite reads
   `$DSH_HOME/opencode-suite.models.json` shaped
   `{version: 1, routes: {<route>: [{id, name}]}}`. Anything outside the shipped
   `pi-ai` catalog lives only in that cache: of the 37 live Go ids, the shipped
   catalog carries 27, so 10 models disappear without it.

   ```sh
   node -e "const fs=require('fs');const old=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));
   const routes={'opencode-go':old.filter(e=>e&&typeof e.id==='string').map(e=>({id:e.id,name:e.name||e.id}))};
   fs.writeFileSync(process.argv[2],JSON.stringify({version:1,routes},null,2)+'\n')" \
     ~/.dsh/<old-plugin>.models.json ~/.dsh/opencode-suite.models.json
   ```

   Skipping it is fine too — one "fetch models" click in the model card has the
   same effect.

> Credentials need no migration: the suite keeps each route's existing
> `apiKeyEnv` reference name, so the `~/.dsh/.credentials.yaml` entries stay
> valid as they are.

## Troubleshooting

**"every key is exhausted, disabled, or invalid" while the keys are fine.**
The OpenCode gateway answers several unrelated rejections on exactly the 401/403
statuses a dead key produces, and the harness labels all of them `AUTH`:

| Provider error | Status | Meaning | Key at fault? |
| --- | --- | --- | --- |
| `AuthError` | 401 | invalid / missing API key | **yes** |
| `ModelError` | 401 | model not served for this account or wire format | no |
| `RegionError` | 403 | model blocked in your country | no |

The pool classifies on the provider's own error identity rather than the status,
so a `ModelError` or `RegionError` leaves every key healthy: it rotates nothing
(another key would answer identically) and reports the rejection as-is. Only an
`AuthError` marks a key invalid. A mark written by an older build is re-judged
when the state file loads, so upgrading heals a poisoned pool by itself.

**A model answers `RegionError` (`This model is not available in your country.`).**
That is a real regional authorization limit, but it is decided by **the region this
request egresses from** — not by your key, and not by a misspelled id. The same key
and the same body flip the answer when only the egress changes:

```sh
curl -s -X POST https://opencode.ai/zen/go/v1/responses \
  -H "Authorization: Bearer $OPENCODE_GO_KEY_A" -H "Content-Type: application/json" \
  -d '{"model":"muse-spark-1.3-contributor","input":"hi","max_output_tokens":16}'
```

So **check where the request actually leaves from before blaming the model**, or a
routing problem reads as "this id does not work":

```sh
curl -s https://www.cloudflare.com/cdn-cgi/trace | grep -E '^(ip|loc)='
```

Note that **one host can egress differently per protocol**: IPv4 through a tunnel
while IPv6 goes direct is a common setup, and Node prefers IPv6 by default — so
`curl` (IPv4 by default) succeeds while the harness gets the 403, which looks like a
plugin bug. On the dsh side the egress is decided by **the environment that launched
it**: `http_proxy` / `https_proxy` / `no_proxy` are read once at launch, and every
`fetch` follows them afterwards (see `@deepseek-ai/dsh-http-proxy`).

Two ways out: switch to a model that has no regional limit (most Zen models have
none), or give dsh an egress in a region where the model is offered — whether the
latter fits OpenCode's terms is between you and OpenCode.

Also note Zen assigns the **wire format per model**, so `/chat/completions` is not a
universal entry point: muse-spark and grok-4.6 use the Responses API (`/responses`),
while glm / kimi / deepseek use `/chat/completions`. The wrong entry point yields a
`ModelError` or a `500`, neither of which is about availability. This plugin reads the
per-model format from the pi-ai catalog, so you never declare it by hand.

## Development

```sh
# node_modules must resolve the harness peer deps (react, cordis, zod, …):
# the harness workspace, or a symlink to it.
pnpm test        # or: node --test test/*.test.mjs
```

The suite covers the pure host modules, the assembled Cordis plugin (route
takeover, failover, model gating, session scoping, the full RPC surface), the
Typert manifest against the real loader, and the browser bundle — the client
tests actually execute it under a `window` stub and server-render the page.

One install-time detail when iterating: a `file:` dependency is **copied** at
install time, so after editing the source a plain `pnpm install` reports
"Already up to date" and does *not* re-copy. Re-`add` the dependency, or run
`pnpm install --force`.

## Limits

- The usage endpoint is the only source of quota truth; it is polled, not
  pushed, so the dashboard can lag by one refresh interval.
- The models endpoint discloses no capacities, so adopted models start on
  documented defaults until you correct them.
- Session headers apply to `fetch`-based requests to the matched hosts. A
  provider that reaches `opencode.ai` through another transport is not covered.
- The free tier's list is written directly into `llm-pi-ai.providers.opencode.models`;
  a settings provider that is read-only makes that card read-only.

## License

MIT. Portions of this code are adapted from earlier MIT-licensed OpenCode
plugins; the required copyright notices are retained in [LICENSE](LICENSE).
