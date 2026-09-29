/**
 * The agent tools of dsh-opencode-suite.
 *
 * Factories take accessor functions instead of a Context so tests can drive
 * them with plain doubles; the plugin entry wires the real readers. Tool bodies
 * never throw across the registry boundary: expected failures come back as
 * structured `{ error }` values so the model sees the recovery text and the
 * settings card can render it.
 *
 * Two surfaces, one plugin:
 *
 *  - `oc_suite_status` / `oc_suite_pool` reach the suite service itself — pool
 *    roster, takeover state, per-key quota, and the pool switch/disable/
 *    clear-invalid actions.
 *  - `oc_usage_models` folds the session log into per-day, per-model token
 *    counts, the one surface a "which model is expensive" answer can come from:
 *    the usage endpoint reports plan windows per key and never a breakdown.
 *  - `oc_model_status` / `oc_model_add` / `oc_model_remove` / `oc_model_sync`
 *    manage both tiers' catalogs. The two tiers differ underneath and the tools
 *    say so: the Go tier edits this plugin's own catalog policy (the pooled
 *    adapter owns that route), the free tier edits
 *    `llm-pi-ai.providers.opencode.models` through the settings seam.
 *
 * @module dsh-opencode-suite/tools
 */

import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  TIERS,
  TIER_IDS,
  capacitiesFor,
} from './catalog.js'
import { FreeTierError } from './free-tier.js'

/**
 * @param resolve - `{ suite(): object|undefined }`, resolved at call time so a
 *   late-mounting plugin is picked up. The suite service owns every other
 *   dependency (llm, settings, credentials) because it is the thing that reads
 *   and writes them; the tools only validate arguments, call one method, and
 *   render its canonical value.
 * @returns the tool definitions ready for `ctx.tools.register`.
 */
export function createTools(resolve) {
  return [
    suiteStatusTool(resolve),
    suitePoolTool(resolve),
    usageModelsTool(resolve),
    modelStatusTool(resolve),
    modelAddTool(resolve),
    modelRemoveTool(resolve),
    modelSyncTool(resolve),
  ]
}

/** Human-readable message of any thrown value. */
function messageOf(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

/** Require the suite service; teach the fix when it is absent. */
function requireSuite(resolve) {
  const suite = resolve.suite()
  if (suite === undefined || suite === null) {
    throw new FreeTierError(
      'the dsh-opencode-suite service is unavailable; enable the dsh-opencode-suite plugin in this profile',
      'NO_SUITE',
    )
  }
  return suite
}

/* ------------------------------------------------------------------ *
 * Suite status / pool
 * ------------------------------------------------------------------ */

function suiteStatusTool(resolve) {
  return {
    name: 'oc_suite_status',
    description:
      'Report the OpenCode suite state: whether the pooled adapter has taken over the opencode-go route, '
      + 'the key pool (roster, per-key lifecycle state, active key, last switch), per-key Go-plan quota '
      + '(5-hour rolling / weekly / monthly used percent and reset time), which models the pooled route '
      + 'currently exposes, and the live free-tier listing drift. Fetches the OpenCode usage and models '
      + 'endpoints right now. Read-only; use oc_suite_pool to switch keys and oc_model_* to change catalogs.',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: { type: 'object' },
      render(_args, value) {
        if (value.error !== undefined) return [{ type: 'text', text: value.error }]
        const lines = [`OpenCode suite @ ${value.fetchedAt}`]

        lines.push('')
        lines.push(`Takeover: ${value.takeover} (route "${value.route}")`)
        if (value.takeoverHint !== null && value.takeoverHint !== undefined) {
          lines.push(`  ${value.takeoverHint}`)
        }
        lines.push(`  policy: preemptAtPercent ${value.preemptAtPercent}`
          + ` · switchAfterConsecutiveFailures ${value.switchAfterConsecutiveFailures}`)

        lines.push('')
        if (value.keys.length === 0) {
          lines.push('Key pool: empty — add a key in Settings → OpenCode 套件 → Key 管理.')
        } else {
          lines.push(`Key pool: ${value.keys.length} key(s), ${value.usableCount} usable`
            + `${value.activeId ? `, active "${value.activeId}"` : ''}`)
          for (const key of value.keys) {
            const marks = [key.state]
            if (key.active) marks.push('ACTIVE')
            if (!key.credentialSet) marks.push('no credential')
            lines.push(`  - ${key.id} (${key.label}) [${marks.join(', ')}]`)
            if (key.usage !== null) {
              lines.push(`      usage: ${renderUsageWindows(key.usage)}`)
            } else if (key.usageError !== null) {
              lines.push(`      usage unavailable: ${key.usageError}`)
            }
            if (key.lastFailure !== null) {
              lines.push(`      last failure: ${key.lastFailure.code} @ ${key.lastFailure.at}`)
            }
          }
          if (value.lastSwitch !== null && value.lastSwitch !== undefined) {
            lines.push(`  last switch: ${value.lastSwitch.from ?? '(none)'} → ${value.lastSwitch.to ?? '(none)'}`
              + ` (${value.lastSwitch.reason}) @ ${value.lastSwitch.at}`)
          }
        }

        lines.push('')
        // The watch block belongs here too: this is the tool a person asks
        // first, and it was the one place that stayed silent about new models.
        appendModelNews(lines, value.modelWatch)

        lines.push(`Pooled catalog (${value.modelMode} mode, ${value.availableModels.length} entries,`
          + ` ${value.availableModels.filter(m => m.enabled).length} exposed):`)
        for (const model of value.availableModels) {
          const flags = []
          if (!model.enabled) flags.push('hidden')
          if (model.dynamic) flags.push('fetched')
          if (Array.isArray(model.inputs) && model.inputs.includes('image')) flags.push('image')
          const capacities = capacitiesFor(model.id, value.modelCapacities)
          lines.push(`  - ${model.id}${flags.length > 0 ? ` [${flags.join(', ')}]` : ''}`
            + ` · ctx ${capacities.contextWindow} / out ${capacities.maxTokens} (${capacities.source})`)
        }

        lines.push('')
        appendTierReport(lines, value.freeTier)

        lines.push('')
        lines.push('Session headers: ' + (value.sessionHeaders.enabled
          ? `ON — injecting [${value.sessionHeaders.headers.join(', ')}]`
            + ` on [${value.sessionHeaders.hosts.join(', ')}]`
            + ` using nanoid${value.sessionHeaders.nanoidLength}(${value.sessionHeaders.nanoidAlphabet})`
            + `; ${value.sessionHeaders.injected} wire request(s) tagged this process`
          : `OFF — opencode requests go out untagged`))

        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    timeoutMs: 45000,
    async execute() {
      try {
        return await requireSuite(resolve).status()
      } catch (error) {
        return { error: messageOf(error) }
      }
    },
  }
}

/** Render the three quota windows on one line. */
/** The watcher's news, in the tool's plain text. */
function appendModelNews(lines, watch) {
  if (watch === undefined || watch === null) {
    lines.push('Model watch: no report in this payload')
    return
  }
  if (watch.enabled === false) {
    lines.push('Model watch: OFF — listing changes only show when something asks.')
    return
  }
  const go = watch.tiers.go
  const free = watch.tiers.free
  const unadopted = ['go', 'free'].flatMap(tierId => watch.tiers[tierId].unconfigured ?? [])
  if (unadopted.length > 0) {
    lines.push(`Online but NOT adopted (${unadopted.length}) — not new, so never announced: ${unadopted.join(', ')}`)
  }
  if (go.pending.length === 0 && go.gone.length === 0 && free.pending.length === 0 && free.gone.length === 0) {
    lines.push(`Model watch: nothing new · last checked ${watch.lastCheckedAt ?? 'never'}`)
    return
  }
  lines.push(`Model watch (last checked ${watch.lastCheckedAt ?? 'never'}, every ${Math.round(watch.intervalMs / 60000)} min):`)
  for (const [label, tier] of [['go', go], ['free', free]]) {
    if (tier.pending.length === 0 && tier.gone.length === 0) continue
    lines.push(`  ${label}: ${tier.pending.length} new online, ${tier.gone.length} delisted`)
    for (const item of tier.pending) lines.push(`    + ${item.id} (first seen ${item.firstSeenAt})`)
    for (const item of tier.gone) lines.push(`    - ${item.id} (gone since ${item.firstSeenAt})`)
  }
}

function renderUsageWindows(usage) {
  const render = (label, window) => {
    if (window === null || window === undefined) return `${label} n/a`
    if (window.percent === null) return `${label} ${window.status ?? 'unknown'}`
    const reset = window.resetsAt === null ? '' : ` reset ${window.resetsAt}`
    return `${label} ${window.percent}% used (${100 - window.percent}% left)${reset}`
  }
  return [render('5h', usage.rolling), render('week', usage.weekly), render('month', usage.monthly)].join(' · ')
}

/**
 * Append the free-tier drift block for `oc_suite_status`, which reports the
 * `freeTier()` shape: `exists` rather than `routeExists`, and `configured` /
 * `live` as the model-entry and id lists themselves rather than as pre-counted
 * numbers. `oc_model_status` renders the other shape; see `renderTierBlock`.
 */
function appendTierReport(lines, report) {
  const tier = TIERS[report.tier]
  lines.push(`${tier.label} (route "${report.route}")`)
  if (report.error !== undefined && report.error !== null) {
    lines.push(`  ${report.error}`)
    return
  }
  if (report.exists === false) {
    lines.push('  route not declared under llm-pi-ai.providers; declare it (apiKeyEnv/baseURL) on the Models page first')
    return
  }
  lines.push(`  configured ${report.configured.length} · live ${report.live.length}`)
  if (report.added.length > 0) lines.push(`  + online, not configured (${report.added.length}): ${report.added.join(', ')}`)
  else lines.push('  + nothing new online')
  if (report.stale.length > 0) lines.push(`  - delisted, still configured (${report.stale.length}): ${report.stale.join(', ')}`)
}

/* ------------------------------------------------------------------ *
 * Local token accounting
 * ------------------------------------------------------------------ */

/** One token-count row, right-aligned so a table stays readable. */
function renderCountRow(label, row, share) {
  const pct = share === undefined || share === null ? '' : `  ${(share * 100).toFixed(1)}%`
  return `  ${label.padEnd(34)} ${String(row.calls).padStart(6)} calls`
    + `  in ${String(row.input).padStart(12)}  cache ${String(row.cacheRead).padStart(13)}`
    + `  out ${String(row.output).padStart(10)}${pct}`
    + `  (total ${row.total})`
}

function usageModelsTool(resolve) {
  return {
    name: 'oc_usage_models',
    description:
      'Report local token usage per day and per model — counted live from this host\'s own streams by default, '
      + 'or folded from the durable session log when usageLogSource is "log". '
      + 'Use it to answer "which model is expensive" or "how much did today cost": the Go usage endpoint '
      + '(oc_suite_status) reports plan windows per KEY and never a model breakdown, so this tool is the '
      + 'only place a per-model answer comes from. Read-only; it changes no key, model, or config.',
    parameters: {
      type: 'object',
      properties: {
        days: {
          type: 'integer',
          minimum: 1,
          maximum: 365,
          description: 'Window in days, newest day last. Defaults to the configured card window.',
        },
        perDay: {
          type: 'boolean',
          description: 'Include the per-day breakdown as well as the per-model totals (default true).',
        },
      },
    },
    output: {
      schema: { type: 'object' },
      render(_args, value) {
        if (value.error !== undefined && value.error !== null) return [{ type: 'text', text: value.error }]
        const lines = []
        lines.push(`Local token usage (${value.source}) · last ${value.windowDays} day(s) · updated ${value.updatedAt ?? 'never'}`)
        if (value.source === 'live') {
          lines.push('Source: what this host streamed while the plugin was on. There is no history from before that,')
          lines.push('and a call that failed before completing still reports the tokens the provider billed.')
        }
        lines.push(`Sessions ${value.sweep.sessions} · changed ${value.sweep.changed}`
          + ` · folded this sweep ${value.sweep.processed} · unreadable ${value.sweep.failed}`
          + `${value.sweep.complete ? '' : ' · sweep incomplete, more sessions queued'}`)
        lines.push('')
        if (value.models.length === 0) {
          lines.push('No model calls in this window. The log holds no assistant message with usage,')
          lines.push('which is what a fresh profile or a window before the first call looks like.')
          return [{ type: 'text', text: lines.join('\n') }]
        }
        lines.push('By model (share of the window):')
        for (const row of value.models) lines.push(renderCountRow(row.model, row, row.share))
        lines.push(renderCountRow('TOTAL', value.totals, null))
        const cacheShare = value.totals.total === 0 ? 0 : value.totals.cacheRead / value.totals.total
        lines.push('')
        lines.push(`Cache reads are ${(cacheShare * 100).toFixed(1)}% of all tokens in this window — `
          + 'on a subscription plan that share, not output volume, is what burns the window.')
        if (value.days.length > 0) {
          lines.push('')
          lines.push('By day:')
          for (const day of value.days) {
            lines.push(renderCountRow(day.date, day, null))
            for (const row of day.models) lines.push(renderCountRow(`  ${row.model}`, row, row.share))
          }
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    timeoutMs: 60000,
    async execute(args) {
      try {
        const days = args && Number.isSafeInteger(args.days) && args.days > 0 ? args.days : undefined
        // The service takes the window positionally, the way the gateway calls it.
        const result = await requireSuite(resolve).usageBreakdown(days)
        if (args && args.perDay === false) return { ...result, days: [] }
        return result
      } catch (error) {
        return { error: messageOf(error) }
      }
    },
  }
}

const POOL_ACTIONS = ['switch', 'disable', 'enable', 'clear-invalid', 'clear-exhausted']

function suitePoolTool(resolve) {
  return {
    name: 'oc_suite_pool',
    description:
      'Change the OpenCode Go key pool. Actions: "switch" makes one key active now; "disable" takes a key out '
      + 'of selection without deleting it; "enable" puts it back; "clear-invalid" forgets an invalid/401 mark '
      + 'after the credential was fixed; "clear-exhausted" forgets a quota-exhausted mark (normally the usage '
      + 'endpoint revives such a key by itself once the 5-hour window resets). The key id comes from '
      + 'oc_suite_status. Never touches the stored secret.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: POOL_ACTIONS, description: 'what to do with the key' },
        keyId: { type: 'string', description: 'the pool key id, as reported by oc_suite_status' },
      },
      required: ['action', 'keyId'],
    },
    output: {
      schema: { type: 'object' },
      render(_args, value) {
        if (value.error !== undefined) return [{ type: 'text', text: value.error }]
        return [{ type: 'text', text: value.message }]
      },
    },
    timeoutMs: 15000,
    async execute(args) {
      const action = typeof args.action === 'string' ? args.action : ''
      const keyId = typeof args.keyId === 'string' ? args.keyId : ''
      if (!POOL_ACTIONS.includes(action)) {
        return { error: `unknown action "${String(args.action)}"; use one of ${POOL_ACTIONS.join(', ')}` }
      }
      if (keyId.length === 0) return { error: 'pass the key id reported by oc_suite_status' }
      try {
        return await requireSuite(resolve).poolAction(action, keyId)
      } catch (error) {
        return { error: messageOf(error) }
      }
    },
  }
}

/* ------------------------------------------------------------------ *
 * oc_model_status
 * ------------------------------------------------------------------ */

function modelStatusTool(resolve) {
  return {
    name: 'oc_model_status',
    description:
      'Report OpenCode model configuration versus the live endpoint listings, per tier. Fetches '
      + 'https://opencode.ai/zen/v1/models (free tier, route "opencode") and '
      + 'https://opencode.ai/zen/go/v1/models (Go tier, route "opencode-go") right now, then lists: how many '
      + 'models are configured, how many are listed online, which online ids are not configured yet, and '
      + 'which configured ids have been delisted. The Go tier is served by this plugin\'s pooled adapter, so '
      + 'its "configured" answer is the pooled catalog policy, not an llm-pi-ai models list. It also reports '
      + 'what the background listing watch is still holding as unhandled (new online ids, delisted ids). '
      + 'Read-only; use oc_model_add / oc_model_remove / oc_model_sync to change anything.',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: { type: 'object' },
      render(_args, value) {
        if (value.error !== undefined) return [{ type: 'text', text: value.error }]
        const lines = [`OpenCode model status @ ${value.fetchedAt}`]
        for (const tierId of TIER_IDS) {
          lines.push('')
          lines.push(...renderTierBlock(value.tiers[tierId]))
        }
        // The watcher's memory separates "nothing changed" from "changed and
        // nobody acted": the drift above is recomputed on every call, while this
        // is what a pass noticed and still holds.
        lines.push('')
        appendModelNews(lines, value.modelWatch)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    timeoutMs: 45000,
    async execute(_args, exec) {
      try {
        const suite = requireSuite(resolve)
        // The watch report rides THIS payload. Without it the renderer above had
        // nothing to read and always printed "no report in this payload".
        const modelWatch = await suite.modelWatchReport()
        const tiers = {}
        for (const tierId of TIER_IDS) {
          try {
            tiers[tierId] = await suite.modelTierReport(tierId, exec.signal)
          } catch (error) {
            tiers[tierId] = { tier: tierId, route: TIERS[tierId].route, error: messageOf(error) }
          }
        }
        return { fetchedAt: new Date().toISOString(), tiers, modelWatch }
      } catch (error) {
        return { error: messageOf(error) }
      }
    },
  }
}

/** Render one tier's status block as text lines. */
function renderTierBlock(report) {
  const tier = TIERS[report.tier]
  const lines = [`${tier.label} (route "${report.route}", ${tier.baseURL})`]
  if (report.error !== undefined && report.error !== null) {
    lines.push(`  ${report.error}`)
    return lines
  }
  lines.push(`  configured ${report.configuredCount} · live ${report.liveCount}`)
  if (report.added.length > 0) lines.push(`  + online, not configured (${report.added.length}): ${report.added.join(', ')}`)
  else lines.push('  + nothing new online')
  if (report.stale.length > 0) lines.push(`  - delisted, still configured (${report.stale.length}): ${report.stale.join(', ')}`)
  if (Array.isArray(report.assumedCapacityIds) && report.assumedCapacityIds.length > 0) {
    lines.push(`  ! assumed capacities on: ${report.assumedCapacityIds.join(', ')}`
      + ` (ctx ${DEFAULT_CONTEXT_WINDOW} / out ${DEFAULT_MAX_TOKENS}) — correct them with oc_model_add`)
  }
  return lines
}

/* ------------------------------------------------------------------ *
 * oc_model_add
 * ------------------------------------------------------------------ */

const ENTRY_PROPERTIES = {
  id: { type: 'string', description: 'model id exactly as the endpoint serves it' },
  name: { type: 'string' },
  contextWindow: { type: 'integer', minimum: 1 },
  maxTokens: { type: 'integer', minimum: 1 },
  input: { type: 'array', items: { type: 'string', enum: ['text', 'image'] } },
  reasoningEfforts: {
    type: 'object',
    description: 'keys off/low/medium/high/xhigh/max → wire spelling; null value means "do not send"',
    additionalProperties: { type: ['string', 'null'] },
  },
}

function modelAddTool(resolve) {
  return {
    name: 'oc_model_add',
    description:
      'Add models to one OpenCode tier (effective on the next request; no restart). Pass the tier ("free" or '
      + '"go") and either `ids` copied verbatim from oc_model_status\'s live listing, or full `models` entries. '
      + 'Tier behaviour differs: on the Go tier the pooled adapter owns the route, so an unknown id is adopted '
      + 'into the synthesized catalog and enabled; on the free tier the entry is written into '
      + 'llm-pi-ai.providers.opencode.models. Both listings disclose ids only, so `ids` without capacities need '
      + '`assumeDefaults: true` — every assumed figure is reported and should be corrected later. An id that is '
      + 'absent from this tier\'s live listing but present in the other tier\'s is refused: the two tiers use '
      + 'different ids (the free tier adds "-free"), never mix them.',
    parameters: {
      type: 'object',
      properties: {
        tier: { type: 'string', enum: TIER_IDS, description: 'which tier to edit' },
        ids: { type: 'array', items: { type: 'string' }, description: 'live listing ids to adopt' },
        models: { type: 'array', items: { type: 'object', properties: ENTRY_PROPERTIES, required: ['id'] }, description: 'fully specified entries (contextWindow/maxTokens/input)' },
        assumeDefaults: { type: 'boolean', description: 'fill missing contextWindow/maxTokens/input with documented assumptions' },
      },
      required: ['tier'],
    },
    output: {
      schema: { type: 'object' },
      render(_args, value) {
        if (value.error !== undefined) return [{ type: 'text', text: `${value.tier}: ${value.error}` }]
        const lines = []
        if (value.addedIds.length > 0) lines.push(`Added to ${TIERS[value.tier].label} (${value.route}): ${value.addedIds.join(', ')}`)
        else lines.push(`Nothing added to ${TIERS[value.tier].label}.`)
        if (value.skippedIds.length > 0) lines.push(`Already present, left untouched: ${value.skippedIds.join(', ')}`)
        if (value.assumedCapacityIds.length > 0) {
          lines.push(`Assumed capacities (ctx ${value.assumedContextWindow}, out ${value.assumedMaxTokens})`
            + ` — correct them when known: ${value.assumedCapacityIds.join(', ')}`)
        }
        for (const rejection of value.rejected) lines.push(`Refused "${rejection.id}": ${rejection.reason}`)
        if (value.mode !== undefined && value.mode !== null) lines.push(`Pooled catalog mode is now "${value.mode}".`)
        if (value.revision !== undefined) lines.push(`Settings revision now ${value.revision}.`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    timeoutMs: 45000,
    async execute(args, exec) {
      const tier = TIERS[args.tier]
      if (tier === undefined) {
        return { tier: String(args.tier), error: `unknown tier; use one of ${TIER_IDS.join(', ')}` }
      }
      const ids = Array.isArray(args.ids) ? [...new Set(args.ids.filter(id => typeof id === 'string'))] : []
      const models = Array.isArray(args.models) ? args.models : []
      if (ids.length === 0 && models.length === 0) {
        return { tier: args.tier, error: 'pass `ids` (from oc_model_status) or full `models` entries' }
      }
      try {
        const suite = requireSuite(resolve)
        return await suite.addTierModels(args.tier, {
          ids,
          models,
          assumeDefaults: args.assumeDefaults === true,
          signal: exec.signal,
        })
      } catch (error) {
        return { tier: args.tier, error: messageOf(error) }
      }
    },
  }
}

/* ------------------------------------------------------------------ *
 * oc_model_remove
 * ------------------------------------------------------------------ */

function modelRemoveTool(resolve) {
  return {
    name: 'oc_model_remove',
    description:
      'Remove models from one OpenCode tier (effective on the next request). Pass the tier ("free" or "go") and '
      + 'the exact ids; run oc_model_status first to see them. Delisted time-limited models should be removed '
      + 'this way. On the Go tier removing a model switches the pooled catalog to "custom" mode listing exactly '
      + 'the models that stay exposed, because that route has no separate per-model list to trim; the tool '
      + 'reports the new mode.',
    parameters: {
      type: 'object',
      properties: {
        tier: { type: 'string', enum: TIER_IDS, description: 'which tier to edit' },
        ids: { type: 'array', items: { type: 'string' }, description: 'configured ids to drop' },
      },
      required: ['tier', 'ids'],
    },
    output: {
      schema: { type: 'object' },
      render(_args, value) {
        if (value.error !== undefined) return [{ type: 'text', text: `${value.tier}: ${value.error}` }]
        const lines = []
        if (value.removedIds.length > 0) lines.push(`Removed from ${TIERS[value.tier].label} (${value.route}): ${value.removedIds.join(', ')}`)
        else lines.push(`Nothing removed from ${TIERS[value.tier].label}.`)
        if (value.notFoundIds.length > 0) lines.push(`Not configured there (ignored): ${value.notFoundIds.join(', ')}`)
        if (value.mode !== undefined && value.mode !== null) lines.push(`Pooled catalog mode is now "${value.mode}".`)
        if (value.revision !== undefined) lines.push(`Settings revision now ${value.revision}.`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    timeoutMs: 30000,
    async execute(args) {
      const tier = TIERS[args.tier]
      if (tier === undefined) {
        return { tier: String(args.tier), error: `unknown tier; use one of ${TIER_IDS.join(', ')}` }
      }
      const ids = Array.isArray(args.ids) ? [...new Set(args.ids.filter(id => typeof id === 'string'))] : []
      if (ids.length === 0) return { tier: args.tier, error: 'pass at least one id' }
      try {
        return await requireSuite(resolve).removeTierModels(args.tier, ids)
      } catch (error) {
        return { tier: args.tier, error: messageOf(error) }
      }
    },
  }
}

/* ------------------------------------------------------------------ *
 * oc_model_sync
 * ------------------------------------------------------------------ */

function modelSyncTool(resolve) {
  return {
    name: 'oc_model_sync',
    description:
      'Bring both OpenCode tiers up to date with the live endpoint listings. Without `apply` this is a preview: '
      + 'it reports what would be added (online, not configured) and removed (delisted, still configured) per '
      + 'tier. With `apply: true` every online-not-configured id is adopted — capacities are assumed because the '
      + 'listing does not disclose them, and every assumption is reported. Delisted entries are removed only with '
      + '`pruneStale: true`.',
    parameters: {
      type: 'object',
      properties: {
        tiers: { type: 'array', items: { type: 'string', enum: TIER_IDS }, description: 'default: both tiers' },
        apply: { type: 'boolean', description: 'default false — preview only' },
        pruneStale: { type: 'boolean', description: 'with apply: also remove delisted ids; default false' },
      },
    },
    output: {
      schema: { type: 'object' },
      render(_args, value) {
        if (value.error !== undefined) return [{ type: 'text', text: value.error }]
        const lines = [value.applied ? 'Sync applied.' : 'Preview (pass apply: true to apply).']
        for (const tierId of TIER_IDS) {
          const report = value.routes[tierId]
          if (report === undefined) continue
          const tier = TIERS[tierId]
          if (report.error !== undefined && report.error !== null) {
            lines.push(`${tier.label}: ${report.error}`)
            continue
          }
          lines.push(`${tier.label}: would add ${report.planAdd.length}`
            + `${report.appliedAdd.length > 0 ? `, added ${report.appliedAdd.length}` : ''}`
            + ` · delisted ${report.planRemove.length}`
            + `${report.appliedRemove.length > 0 ? `, removed ${report.appliedRemove.length}` : ''}`)
          if (report.planAdd.length > 0 && report.appliedAdd.length === 0) lines.push(`  add: ${report.planAdd.join(', ')}`)
          if (report.planRemove.length > 0 && report.appliedRemove.length === 0) lines.push(`  remove: ${report.planRemove.join(', ')}`)
          if (report.assumedCapacityIds.length > 0) lines.push(`  assumed capacities on: ${report.assumedCapacityIds.join(', ')}`)
          if (report.mode !== undefined && report.mode !== null) lines.push(`  pooled catalog mode is now "${report.mode}"`)
          if (report.error2 !== undefined && report.error2 !== null) lines.push(`  write failed: ${report.error2}`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    timeoutMs: 90000,
    async execute(args, exec) {
      const requested = Array.isArray(args.tiers) ? args.tiers.filter(id => TIER_IDS.includes(id)) : []
      if (Array.isArray(args.tiers) && args.tiers.length > 0 && requested.length === 0) {
        return { applied: false, error: `tiers must be drawn from ${TIER_IDS.join(', ')}` }
      }
      const tierIds = requested.length > 0 ? requested : [...TIER_IDS]
      try {
        const suite = requireSuite(resolve)
        const routes = {}
        for (const tierId of tierIds) {
          try {
            routes[tierId] = await suite.syncTier(tierId, {
              apply: args.apply === true,
              pruneStale: args.pruneStale === true,
              signal: exec.signal,
            })
          } catch (error) {
            routes[tierId] = {
              tier: tierId,
              planAdd: [],
              planRemove: [],
              appliedAdd: [],
              appliedRemove: [],
              assumedCapacityIds: [],
              error: messageOf(error),
            }
          }
        }
        return { applied: args.apply === true, routes }
      } catch (error) {
        return { applied: false, error: messageOf(error) }
      }
    },
  }
}
