import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

// Cordis-context smoke tests. They exercise the real plugin against mocked
// seams, but need the DeepSeek Harness peer dependencies installed. In a
// checkout that does not have them (e.g. `node --test` on a fresh clone), every
// test skips instead of failing: the pure module tests already cover the
// dependency-free logic.

/** Point DSH_HOME at a fresh temp dir so tests never touch the real state file. */
function isolateHome(t) {
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-opencode-suite-'))
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  })
}

async function loadHarness(t) {
  isolateHome(t)
  let Context, OpenCodeSuite
  try {
    ;({ Context } = await import('@deepseek-ai/cordis'))
    ;({ OpenCodeSuite } = await import('../index.js'))
  } catch {
    t.skip('harness peer deps not installed — link the DSH node_modules to run smoke tests')
    return null
  }
  return { Context, OpenCodeSuite }
}

/* ------------------------------------------------------------------ *
 * Doubles
 * ------------------------------------------------------------------ */

function makeMockLlms() {
  return {
    registered: [],
    adapter: null,
    registerAdapter(routes, adapter) {
      this.registered.push([...routes])
      this.adapter = adapter
      return {
        replace: next => { this.registered.push([...next]) },
      }
    },
  }
}

/**
 * The settings service double for the 0.1.7 contract. The removed owner scope is
 * gone on purpose: this plugin keeps the Config references the Loader resolved
 * for it and persists through `update(ns, patch)`.
 *
 * `update` is real: it commits the patch into those very references through
 * cosmokit's `write` symbol — the same thing the Loader does when it reconciles
 * a profile patch — and then fires `loader/volatile-update`, which is what makes
 * the plugin re-read the section in production. A double that swallowed either
 * half would make every settings write look like a no-op.
 *
 * `configOf` is late-bound because the references only exist once the plugin is
 * mounted (the schema materializes them during config resolution).
 */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

function makeMockSettings(configOf, { sections = {}, onUpdate } = {}) {
  const store = { ...sections }
  return {
    writable: true,
    describe: () => Object.keys(store).map(ns => ({ ns, revision: store[ns]?.__revision ?? 7, value: store[ns] })),
    update: async (ns, patch) => {
      if (ns === 'opencode-suite') {
        const config = configOf()
        for (const [key, value] of Object.entries(patch)) config[key][VOLATILE_WRITE](value)
        onUpdate?.(patch)
        return
      }
      store[ns] = { ...(store[ns] ?? {}), ...patch }
      store[ns].__revision = (store[ns].__revision ?? 7) + 1
    },
    __store: store,
  }
}

/** A tools registry double that records what the plugin registers. */
function makeMockTools() {
  return {
    tools: [],
    register(definition) {
      this.tools.push(definition)
      return () => {}
    },
  }
}

const BASE_CONFIG = {
  route: 'opencode-go',
  keys: [],
  preemptAtPercent: 100,
  switchAfterConsecutiveFailures: 0,
  modelMode: 'all',
  models: [],
  imageModels: [],
  modelCapacities: {},
  usageBaseUrl: 'https://opencode.ai/zen/go/v1/usage',
  modelsBaseUrl: 'https://opencode.ai/zen/go/v1/models',
  freeModelsBaseUrl: 'https://opencode.ai/zen/v1/models',
  usageRefreshMs: 30000,
  timeoutMs: 15000,
}

/** The llm-pi-ai section a real deployment has, for the free-tier path. */
function freeTierSection(models = []) {
  return {
    providers: {
      opencode: {
        apiKeyEnv: 'PI_AI_API_KEY',
        baseURL: 'https://opencode.ai/zen/v1',
        api: 'openai-completions',
        models,
      },
    },
    __revision: 7,
  }
}

async function boot(OpenCodeSuite, Context, { config = {}, sections, llm } = {}) {
  const root = new Context()
  const llms = llm ?? makeMockLlms()
  let suite
  const settings = makeMockSettings(() => suite.config, {
    sections,
    // The Loader announces a committed volatile update on this event; the plugin
    // re-applies the section from the references it already holds.
    onUpdate: () => root.emit('loader/volatile-update', []),
  })
  const tools = makeMockTools()
  root.provide('llm', llms)
  root.provide('settings', settings)
  root.provide('credentials', { resolve: async () => undefined })
  root.provide('tools', tools)
  // Plain values in: the schema materializes the volatile references the live
  // host would have handed over.
  await root.plugin(OpenCodeSuite, { ...BASE_CONFIG, ...config })
  suite = root.get('opencodeSuite')
  return { root, llms, settings, tools, plugin: suite }
}

const TWO_KEYS = [
  { id: 'acc-a', label: '主号', apiKeyEnv: 'OPENCODE_GO_KEY_A' },
  { id: 'acc-b', label: '备用2', apiKeyEnv: 'OPENCODE_GO_KEY_B' },
]

const REQUEST = {
  provider: 'opencode-go',
  model: 'deepseek-v4-flash',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
}

/* ------------------------------------------------------------------ *
 * Mount, route ownership, catalog
 * ------------------------------------------------------------------ */

test('the plugin takes over the opencode-go route and serves the pi-ai catalog', async (t) => {
  const harness = await loadHarness(t)
  if (!harness) return
  const { root, llms, plugin } = await boot(harness.OpenCodeSuite, harness.Context)

  assert.equal(plugin.takeoverState(), 'serving')
  assert.deepEqual(llms.registered[0], ['opencode-go'])

  const models = await llms.adapter.listModels('opencode-go')
  assert.ok(Array.isArray(models) && models.length > 0, 'the catalog lists models')
  assert.ok(models.map(m => m.id).includes('deepseek-v4-flash'))

  // providerInfo must echo the route it owns, or the harness rejects the route.
  assert.equal(llms.adapter.providerInfo('opencode-go').id, 'opencode-go')
  await root.fiber.dispose()
})

test('the plugin registers all seven agent tools with unique names', async (t) => {
  const harness = await loadHarness(t)
  if (!harness) return
  const { root, tools } = await boot(harness.OpenCodeSuite, harness.Context)
  const names = tools.tools.map(tool => tool.name).sort()
  assert.deepEqual(names, [
    'oc_model_add',
    'oc_model_remove',
    'oc_model_status',
    'oc_model_sync',
    'oc_suite_pool',
    'oc_suite_status',
    'oc_usage_models',
  ])
  for (const tool of tools.tools) {
    assert.equal(typeof tool.execute, 'function', `${tool.name} is executable`)
    assert.ok(tool.description.length > 40, `${tool.name} carries a real description`)
    assert.equal(typeof tool.output.render, 'function', `${tool.name} renders its own output`)
  }
  await root.fiber.dispose()
})

test('a dry pool yields one terminal quota error instead of making a request', async (t) => {
  const harness = await loadHarness(t)
  if (!harness) return
  const { root, llms } = await boot(harness.OpenCodeSuite, harness.Context)

  const chunks = []
  for await (const chunk of llms.adapter.stream(REQUEST)) chunks.push(chunk)
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].type, 'finish')
  assert.equal(chunks[0].reason.kind, 'error')
  assert.equal(chunks[0].reason.failure.code, 'QUOTA')
  await root.fiber.dispose()
})

test('a key whose credential cannot be resolved fails loud', async (t) => {
  const harness = await loadHarness(t)
  if (!harness) return
  // The mock credentials service resolves nothing, so the pool key is unusable
  // and the failure must be MISSING_CREDENTIAL rather than a silent fallback to
  // some ambient environment key.
  const { root, llms } = await boot(harness.OpenCodeSuite, harness.Context, { config: { keys: [TWO_KEYS[0]] } })
  await assert.rejects(async () => {
    for await (const _chunk of llms.adapter.stream(REQUEST)) { /* drain */ }
  }, err => err.code === 'MISSING_CREDENTIAL')
  await root.fiber.dispose()
})

/* ------------------------------------------------------------------ *
 * Takeover protocol
 * ------------------------------------------------------------------ */

test('dormant while the route is owned elsewhere, and it takes over on adapters-updated', async (t) => {
  const harness = await loadHarness(t)
  if (!harness) return
  const llms = makeMockLlms()
  let blocked = true
  const recorded = []
  llms.registerAdapter = (routes, adapter) => {
    if (blocked) throw new Error('llm: duplicate adapter for provider "opencode-go"')
    llms.adapter = adapter
    recorded.push([...routes])
    return { replace: next => { recorded.push([...next]) } }
  }

  const { root, plugin } = await boot(harness.OpenCodeSuite, harness.Context, { llm: llms })
  assert.equal(plugin.takeoverState(), 'waiting')
  const waiting = await plugin.status()
  assert.equal(waiting.takeover, 'waiting')
  assert.ok(waiting.takeoverHint, 'the refusal reason rides the card hint')

  blocked = false
  root.emit('llm/adapters-updated')
  assert.equal(plugin.takeoverState(), 'serving')
  assert.deepEqual(recorded, [['opencode-go']])
  const serving = await plugin.status()
  assert.equal(serving.takeover, 'serving')
  assert.equal(serving.takeoverHint, null)
  await root.fiber.dispose()
})

/* ------------------------------------------------------------------ *
 * Failover
 * ------------------------------------------------------------------ */

/** Scripted fake inner adapter: each stream() call consumes one script step. */
class FakeInnerAdapter {
  constructor(script) {
    this.script = script
    this.calls = 0
  }

  async *stream(_options) {
    const step = this.script[Math.min(this.calls++, this.script.length - 1)]
    for (const chunk of step) yield chunk
  }
}

const quotaFinish = {
  type: 'finish',
  reason: { kind: 'error', failure: { code: 'QUOTA', message: 'quota exhausted' } },
}
const successChunks = [
  { type: 'text-delta', index: 0, text: 'hello' },
  { type: 'finish', reason: { kind: 'stop' } },
]

/**
 * The gateway answers a dead key and an unservable model on the same 401, and a
 * region block on 403 — so the harness labels all three `AUTH` and the payload
 * is the only thing that tells them apart. Both captured live from zen/go/v1.
 */
const GATEWAY_AUTH_ERROR = 'OpenAI API error (401): {"type":"error","error":{"type":"AuthError","message":"Invalid API key."}}'
const GATEWAY_REGION_ERROR = 'OpenAI API error (403): {"type":"RegionError","message":"This model is not available in your country."}'

test('failover: a pre-content quota failure silently retries with the next key', async (t) => {
  const harness = await loadHarness(t)
  if (!harness) return
  const { root, llms, plugin } = await boot(harness.OpenCodeSuite, harness.Context, {
    config: { keys: TWO_KEYS },
  })

  const fake = new FakeInnerAdapter([[quotaFinish], successChunks])
  plugin.makeAttemptAdapter = () => fake

  const chunks = []
  for await (const chunk of llms.adapter.stream(REQUEST)) chunks.push(chunk)

  // The consumer sees exactly one successful stream — no error ever surfaced.
  assert.equal(chunks.length, 2)
  assert.deepEqual(chunks[0], { type: 'text-delta', index: 0, text: 'hello' })
  assert.equal(chunks[1].reason.kind, 'stop')
  assert.equal(fake.calls, 2, 'one attempt per key')
  assert.equal(plugin.pool.stateOf('acc-a').state, 'exhausted')
  assert.equal(plugin.pool.activeId, 'acc-b')
  assert.equal(plugin.pool.lastSwitch.reason, 'quota')
  await root.fiber.dispose()
})

test('failover: a mid-stream quota failure surfaces the error but still rotates', async (t) => {
  const harness = await loadHarness(t)
  if (!harness) return
  const { root, llms, plugin } = await boot(harness.OpenCodeSuite, harness.Context, {
    config: { keys: TWO_KEYS },
  })

  // Content was already emitted → a silent retry would duplicate it.
  const fake = new FakeInnerAdapter([[
    { type: 'text-delta', index: 0, text: 'partial' },
    quotaFinish,
  ]])
  plugin.makeAttemptAdapter = () => fake

  const chunks = []
  for await (const chunk of llms.adapter.stream(REQUEST)) chunks.push(chunk)

  assert.equal(chunks.length, 2)
  assert.equal(chunks[0].type, 'text-delta')
  assert.equal(chunks[1].reason.failure.code, 'QUOTA')
  assert.equal(fake.calls, 1, 'no silent retry after content was emitted')
  assert.equal(plugin.pool.activeId, 'acc-b', 'the pool still rotates for the next request')
  await root.fiber.dispose()
})

test('failover: exhausting every key surfaces one terminal dry-pool error', async (t) => {
  const harness = await loadHarness(t)
  if (!harness) return
  const { root, llms, plugin } = await boot(harness.OpenCodeSuite, harness.Context, {
    config: { keys: TWO_KEYS },
  })
  const fake = new FakeInnerAdapter([[quotaFinish]])
  plugin.makeAttemptAdapter = () => fake

  const chunks = []
  for await (const chunk of llms.adapter.stream(REQUEST)) chunks.push(chunk)
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].reason.failure.code, 'QUOTA')
  assert.equal(fake.calls, 2, 'one attempt per key')
  assert.equal(plugin.pool.usableCount(), 0)
  await root.fiber.dispose()
})

test('failover: a non-rotation failure keeps the key and surfaces immediately', async (t) => {
  const harness = await loadHarness(t)
  if (!harness) return
  const { root, llms, plugin } = await boot(harness.OpenCodeSuite, harness.Context, {
    config: { keys: TWO_KEYS },
  })
  const fake = new FakeInnerAdapter([[
    { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: 'slow down' } } },
  ]])
  plugin.makeAttemptAdapter = () => fake

  const chunks = []
  for await (const chunk of llms.adapter.stream(REQUEST)) chunks.push(chunk)
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].reason.failure.code, 'RATE_LIMIT')
  assert.equal(fake.calls, 1, 'no rotation retry for a transient code')
  assert.equal(plugin.pool.stateOf('acc-a').state, 'healthy')
  assert.equal(plugin.pool.activeId, 'acc-a')
  await root.fiber.dispose()
})

test('failover: a thrown credential rejection also rotates while nothing was emitted', async (t) => {
  const harness = await loadHarness(t)
  if (!harness) return
  const { root, llms, plugin } = await boot(harness.OpenCodeSuite, harness.Context, {
    config: { keys: TWO_KEYS },
  })
  let calls = 0
  plugin.makeAttemptAdapter = () => ({
    async *stream() {
      calls += 1
      if (calls === 1) {
        const error = new Error(GATEWAY_AUTH_ERROR)
        error.code = 'AUTH'
        throw error
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  })

  const chunks = []
  for await (const chunk of llms.adapter.stream(REQUEST)) chunks.push(chunk)
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].reason.kind, 'stop')
  assert.equal(calls, 2)
  assert.equal(plugin.pool.stateOf('acc-a').state, 'invalid')
  await root.fiber.dispose()
})

test('failover: a region-blocked model is reported once and leaves every key healthy', async (t) => {
  const harness = await loadHarness(t)
  if (!harness) return
  const { root, llms, plugin } = await boot(harness.OpenCodeSuite, harness.Context, {
    config: { keys: TWO_KEYS },
  })
  const fake = new FakeInnerAdapter([[
    { type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH', message: GATEWAY_REGION_ERROR } } },
  ]])
  plugin.makeAttemptAdapter = () => fake

  const chunks = []
  for await (const chunk of llms.adapter.stream(REQUEST)) chunks.push(chunk)

  // Exactly one attempt: the second key would eat the same 403, so rotating
  // would only burn a request and delay the answer.
  assert.equal(fake.calls, 1)
  assert.equal(chunks.length, 1)
  const { failure } = chunks[0].reason
  assert.equal(failure.code, 'AUTH', 'the harness code is preserved for the UI')
  assert.match(failure.message, /rejected model "deepseek-v4-flash" for this account or region/)
  assert.match(failure.message, /not a credential fault/)
  assert.match(failure.message, /RegionError/, 'the provider\'s own words survive re-wording')

  // The regression this guards: a region block must never dry out the pool.
  assert.equal(plugin.pool.stateOf('acc-a').state, 'healthy')
  assert.equal(plugin.pool.currentKey().id, 'acc-a')
  assert.equal(plugin.pool.usableCount(), 2)
  await root.fiber.dispose()
})

test('failover: a model rejection does not stop the next request from using the same key', async (t) => {
  const harness = await loadHarness(t)
  if (!harness) return
  const { root, llms, plugin } = await boot(harness.OpenCodeSuite, harness.Context, {
    config: { keys: TWO_KEYS },
  })
  const fake = new FakeInnerAdapter([
    [{ type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH', message: GATEWAY_REGION_ERROR } } }],
    successChunks,
  ])
  plugin.makeAttemptAdapter = () => fake

  for await (const _chunk of llms.adapter.stream(REQUEST)) { /* drain the rejection */ }
  const chunks = []
  for await (const chunk of llms.adapter.stream(REQUEST)) chunks.push(chunk)

  assert.equal(chunks[chunks.length - 1].reason.kind, 'stop', 'the same key serves the next model fine')
  assert.equal(plugin.pool.activeId, 'acc-a')
  await root.fiber.dispose()
})

/* ------------------------------------------------------------------ *
 * Model selection gate
 * ------------------------------------------------------------------ */

test('custom mode filters listModels and refuses an unselected model', async (t) => {
  const harness = await loadHarness(t)
  if (!harness) return
  const { root, llms } = await boot(harness.OpenCodeSuite, harness.Context, {
    config: { modelMode: 'custom', models: ['deepseek-v4-flash'] },
  })

  const listed = await llms.adapter.listModels('opencode-go')
  assert.deepEqual(listed.map(entry => entry.id), ['deepseek-v4-flash'])
  await assert.rejects(
    () => llms.adapter.resolveModel('opencode-go', 'deepseek-v4-pro'),
    err => err.code === 'UNKNOWN_MODEL',
  )
  await assert.rejects(async () => {
    for await (const _chunk of llms.adapter.stream({ ...REQUEST, model: 'deepseek-v4-pro' })) { /* drain */ }
  }, err => err.code === 'UNKNOWN_MODEL')
  await root.fiber.dispose()
})

test('all mode exposes the whole catalog and gates nothing', async (t) => {
  const harness = await loadHarness(t)
  if (!harness) return
  const { root, llms } = await boot(harness.OpenCodeSuite, harness.Context)
  const listed = await llms.adapter.listModels('opencode-go')
  assert.ok(listed.length > 1)
  const resolved = await llms.adapter.resolveModel('opencode-go', listed[0].id)
  assert.equal(resolved.id, listed[0].id)
  await root.fiber.dispose()
})

test('a declared image model gains the image modality in the served catalog', async (t) => {
  const harness = await loadHarness(t)
  if (!harness) return
  const { root, llms } = await boot(harness.OpenCodeSuite, harness.Context, {
    config: { imageModels: ['deepseek-v4-flash'] },
  })
  const listed = await llms.adapter.listModels('opencode-go')
  const target = listed.find(entry => entry.id === 'deepseek-v4-flash')
  assert.ok(target.inputModalities.includes('image'), 'the declaration reaches inputModalities')
  const other = listed.find(entry => entry.id !== 'deepseek-v4-flash')
  if (other) assert.equal(other.inputModalities.includes('image'), other.inputModalities.includes('image'))
  await root.fiber.dispose()
})

test('image declarations can be changed at runtime and reverted', async (t) => {
  const harness = await loadHarness(t)
  if (!harness) return
  const { root, llms, plugin } = await boot(harness.OpenCodeSuite, harness.Context)
  const target = 'deepseek-v4-flash'
  const inputsOf = async () => (await llms.adapter.listModels('opencode-go'))
    .find(entry => entry.id === target).inputModalities

  assert.ok(!(await inputsOf()).includes('image'), 'the Go catalog declares no images by default')

  // Declaring it reaches the served catalog without a restart …
  await plugin.putConfig({ imageModels: [target] })
  assert.ok((await inputsOf()).includes('image'), 'the write is live')

  // … and withdrawing it takes effect just as directly.
  await plugin.putConfig({ imageModels: [] })
  assert.ok(!(await inputsOf()).includes('image'), 'clearing withdraws it')

  // Ids are ids: a blank one is refused rather than silently dropped.
  await assert.rejects(() => plugin.putConfig({ imageModels: [target, '  '] }), /imageModels/)
  await root.fiber.dispose()
})

/* ------------------------------------------------------------------ *
 * Session headers, end to end
 * ------------------------------------------------------------------ */

test('scopeStream makes the session id visible to a fetch issued inside the stream', async (t) => {
  const harness = await loadHarness(t)
  if (!harness) return
  // The recorder stands in for the REAL fetch, so it must be installed before
  // the plugin mounts: the plugin's wrapper chains over whatever fetch exists
  // at mount time and would otherwise be bypassed entirely.
  const realFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init })
    return { ok: true }
  }
  t.after(() => { globalThis.fetch = realFetch })
  const { root, plugin } = await boot(harness.OpenCodeSuite, harness.Context)

  // The downstream factory mirrors the real adapter: it fetches from inside its
  // own generator body, after an await, which is exactly where a scope that did
  // not propagate through async context would lose the id.
  const downstream = () => (async function* () {
    await new Promise(resolve => setImmediate(resolve))
    await globalThis.fetch('https://opencode.ai/zen/go/v1/chat/completions', { method: 'POST' })
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()

  const stream = plugin.scopeStream(
    { provider: 'opencode-go', model: 'deepseek-v4-flash', sessionId: 'session-e820d21d-1234-5678-90ab-a309f722a3bc' },
    downstream,
  )
  for await (const _chunk of stream) { /* drain */ }

  assert.equal(calls.length, 1)
  const headers = calls[0].init.headers
  assert.equal(headers.get('x-opencode-session'), 'q8GVZEKY',
    'the wire token is the deterministic nanoid(8) of the uuid, not the raw id')
  assert.equal(headers.get('x-session-affinity'), 'q8GVZEKY')
  assert.equal(calls[0].init.method, 'POST')

  const [entry] = plugin.injectionLog.list()
  assert.ok(entry, 'the injection is recorded for the card')
  assert.equal(entry.sessionId, 'session-e820d21d-1234-5678-90ab-a309f722a3bc')
  await root.fiber.dispose()
})

test('concurrent streams keep their own session ids', async (t) => {
  const harness = await loadHarness(t)
  if (!harness) return
  const realFetch = globalThis.fetch
  const seen = []
  globalThis.fetch = async (input, init) => {
    seen.push({ url: String(input), token: init.headers.get('x-opencode-session') })
    return { ok: true }
  }
  t.after(() => { globalThis.fetch = realFetch })
  const { root, plugin } = await boot(harness.OpenCodeSuite, harness.Context)

  const downstream = label => (async function* () {
    for (let i = 0; i < 3; i++) {
      await new Promise(resolve => setImmediate(resolve))
      await globalThis.fetch('https://opencode.ai/zen/go/v1/chat/completions', { method: 'POST' })
      yield { type: 'text-delta', index: i, text: label }
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()

  const a = plugin.scopeStream({ provider: 'opencode-go', sessionId: 'session-aaaaaaaa-0000-0000-0000-000000000000' }, () => downstream('a'))
  const b = plugin.scopeStream({ provider: 'opencode-go', sessionId: 'session-bbbbbbbb-0000-0000-0000-000000000000' }, () => downstream('b'))
  const ia = a[Symbol.asyncIterator]()
  const ib = b[Symbol.asyncIterator]()
  for (let i = 0; i < 4; i++) {
    await ia.next()
    await ib.next()
  }

  const tokensA = new Set(seen.filter((_, index) => index % 2 === 0).map(entry => entry.token))
  const tokensB = new Set(seen.filter((_, index) => index % 2 === 1).map(entry => entry.token))
  assert.equal(tokensA.size, 1, 'stream A used exactly one token')
  assert.equal(tokensB.size, 1, 'stream B used exactly one token')
  assert.notEqual([...tokensA][0], [...tokensB][0], 'the two conversations are distinct on the wire')
  await root.fiber.dispose()
})

test('scopeStream is an exact pass-through when both interceptors are off', async (t) => {
  const harness = await loadHarness(t)
  if (!harness) return
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  const { root, plugin } = await boot(harness.OpenCodeSuite, harness.Context, {
    // The identity guarantee belongs to the header interceptor: with local
    // usage accounting on, scopeStream also wraps the stream to read its usage
    // chunks, which no pass-through can survive.
    config: { sessionHeaders: { enabled: false }, usageLogEnabled: false },
  })

  const sentinel = (async function* () {
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
  const options = { provider: 'opencode-go', model: 'm' }
  const returned = plugin.scopeStream(options, () => sentinel)
  assert.equal(returned, sentinel, 'the very same iterable is handed back')
  assert.equal(options.sessionId, undefined, 'call options are never mutated by default')
  await root.fiber.dispose()
})

test('seedSessionId fills a missing option only for a configured opencode route', async (t) => {
  const harness = await loadHarness(t)
  if (!harness) return
  const { root, plugin } = await boot(harness.OpenCodeSuite, harness.Context, {
    config: { sessionHeaders: { seedSessionId: true } },
  })
  const opencode = { provider: 'opencode-go', model: 'm' }
  for await (const _chunk of plugin.scopeStream(opencode, () => (async function* () {
    yield { type: 'finish', reason: { kind: 'stop' } }
  })())) { /* drain */ }
  assert.equal(typeof opencode.sessionId, 'string', 'a configured opencode route gets seeded')

  const other = { provider: 'deepseek', model: 'm' }
  for await (const _chunk of plugin.scopeStream(other, () => (async function* () {
    yield { type: 'finish', reason: { kind: 'stop' } }
  })())) { /* drain */ }
  assert.equal(other.sessionId, undefined, 'an unconfigured route is never touched')
  await root.fiber.dispose()
})

/* ------------------------------------------------------------------ *
 * RPC surface
 * ------------------------------------------------------------------ */

test('status() is complete and free of undefined, so the strict codec accepts it', async (t) => {
  const harness = await loadHarness(t)
  if (!harness) return
  const { root, plugin } = await boot(harness.OpenCodeSuite, harness.Context, {
    config: { keys: TWO_KEYS },
    sections: { 'llm-pi-ai': freeTierSection([{ id: 'big-pickle', name: 'Big Pickle', contextWindow: 1, maxTokens: 1, input: ['text'] }]) },
  })
  const status = await plugin.status()

  assert.equal(status.takeover, 'serving')
  assert.equal(status.route, 'opencode-go')
  assert.equal(status.usableCount, 2)
  assert.equal(status.keys.length, 2)
  assert.ok(status.availableModels.length > 0)
  assert.equal(status.freeTier.route, 'opencode')
  assert.equal(status.freeTier.exists, true)
  assert.deepEqual(status.freeTier.configured.map(entry => entry.id), ['big-pickle'])
  assert.equal(status.sessionHeaders.enabled, true)
  assert.equal(status.sessionHeaders.nanoidLength, 8)

  // A strict codec rejects an absent member, so no field may be `undefined`:
  // an optional fact must be an explicit null.
  const walk = (value, path) => {
    if (value === undefined) assert.fail(`${path} is undefined — the strict codec would reject it`)
    if (Array.isArray(value)) value.forEach((entry, index) => walk(entry, `${path}[${index}]`))
    else if (value !== null && typeof value === 'object') {
      for (const [key, entry] of Object.entries(value)) walk(entry, `${path}.${key}`)
    }
  }
  walk(status, 'status')

  // `availableModels` carries the live usage error rather than a fake number:
  // the mock credentials resolve nothing, so each key reports "no-api-key".
  assert.equal(status.keys[0].usage, null)
  assert.equal(status.keys[0].usageError, 'no-api-key')
  assert.equal(status.keys[0].credentialSet, false)
  await root.fiber.dispose()
})

test('putConfig validates thresholds, lists, and the custom-mode invariant', async (t) => {
  const harness = await loadHarness(t)
  if (!harness) return
  const { root, plugin } = await boot(harness.OpenCodeSuite, harness.Context)

  await plugin.putConfig({ preemptAtPercent: 95 })
  assert.equal((await plugin.status()).preemptAtPercent, 95)

  // Range and enum refusal now belongs to the wire codec (test/typert-manifest
  // asserts it there, with the exact field named) and to the live Config schema
  // the settings service validates against. What the SERVICE still owns is what
  // no schema can express: list hygiene, the custom-mode invariant, an empty
  // patch, and a field that is not Config at all.
  await assert.rejects(() => plugin.putConfig({ models: ['ok', '  '] }), /non-empty/)
  // Duplicates are normalized away rather than refused, and the trimmed set is
  // what lands.
  await plugin.putConfig({ models: ['  keep  ', 'keep'] })
  assert.deepEqual(plugin.current().models, ['keep'], 'a duplicated id lands once, trimmed')
  // Custom mode with nothing selected would expose an empty catalog. Checked
  // after the id list is cleared, since the invariant is about the EFFECTIVE
  // config rather than the patch alone.
  await plugin.putConfig({ models: [] })
  await assert.rejects(() => plugin.putConfig({ modelMode: 'custom' }), /at least one model/)
  await assert.rejects(() => plugin.putConfig({}), /empty patch/)
  // A field outside the Config is the LIVE settings service's refusal ("Config
  // field ... is not volatile"); the double here does not validate, so the
  // property worth proving in this harness is the opposite one: every field a
  // card control writes must actually reach the plugin.
  for (const [patch, read] of [
    [{ usageLogEnabled: false }, status => status.usageLogEnabled],
    [{ usageLogSource: 'log' }, status => status.usageLogSource],
    [{ notifyImEnabled: true }, status => status.imNotify.enabled],
    [{ notifyImBotId: 'bot_1', notifyImTargetId: 'release-alerts' }, status => status.imNotify.targetId],
  ]) {
    await plugin.putConfig(patch)
    assert.equal(read(await plugin.status()), Object.values(patch)[Object.keys(patch).length - 1],
      `putConfig ${JSON.stringify(patch)} landed`)
  }
  await root.fiber.dispose()
})

test('putSessionHeaders round-trips through the settings document', async (t) => {
  const harness = await loadHarness(t)
  if (!harness) return
  const { root, plugin } = await boot(harness.OpenCodeSuite, harness.Context)

  await plugin.putSessionHeaders({ enabled: false, nanoidLength: 16, nanoidAlphabet: 'urlsafe' })
  const status = await plugin.status()
  assert.equal(status.sessionHeaders.enabled, false)
  assert.equal(status.sessionHeaders.nanoidLength, 16)
  assert.equal(status.sessionHeaders.nanoidAlphabet, 'urlsafe')

  await assert.rejects(() => plugin.putSessionHeaders({ nanoidLength: 99 }), /4\.\.32/)
  await assert.rejects(() => plugin.putSessionHeaders({ nanoidAlphabet: 'emoji' }), /alphanumeric/)
  await assert.rejects(() => plugin.putSessionHeaders({ extraHeaders: { 'x-a': 5 } }), /must be a string/)
  // A header name outside the RFC token grammar is dropped by normalization
  // rather than reaching the injector and silently doing nothing.
  await plugin.putSessionHeaders({ headers: ['x-opencode-session', 'not a header'] })
  assert.deepEqual((await plugin.status()).sessionHeaders.headers, ['x-opencode-session'])
  await root.fiber.dispose()
})

test('putKeys refuses a malformed roster before anything persists', async (t) => {
  const harness = await loadHarness(t)
  if (!harness) return
  const { root, plugin } = await boot(harness.OpenCodeSuite, harness.Context)
  await assert.rejects(() => plugin.putKeys([{ id: 'BAD ID', label: 'x', apiKeyEnv: 'K' }]), /must match/)
  await assert.rejects(() => plugin.putKeys([TWO_KEYS[0], TWO_KEYS[0]]), /duplicate key id/)
  await plugin.putKeys(TWO_KEYS)
  assert.equal((await plugin.status()).keys.length, 2)
  await root.fiber.dispose()
})

test('pool actions move the active key and refuse an unusable target', async (t) => {
  const harness = await loadHarness(t)
  if (!harness) return
  const { root, plugin } = await boot(harness.OpenCodeSuite, harness.Context, {
    config: { keys: TWO_KEYS },
  })
  assert.equal((await plugin.status()).activeId, 'acc-a')
  await plugin.setActive('acc-b')
  assert.equal((await plugin.status()).activeId, 'acc-b')
  await plugin.setDisabled('acc-b', true)
  assert.equal((await plugin.status()).activeId, 'acc-a')
  await assert.rejects(() => plugin.setActive('acc-b'), /not usable/)
  await assert.rejects(() => plugin.setActive('nope'), /unknown key/)
  await root.fiber.dispose()
})

/* ------------------------------------------------------------------ *
 * Free tier (llm-pi-ai owned)
 * ------------------------------------------------------------------ */

test('the free tier reports drift and writes back through the settings seam', async (t) => {
  const harness = await loadHarness(t)
  if (!harness) return
  const { root, settings, plugin } = await boot(harness.OpenCodeSuite, harness.Context, {
    sections: {
      'llm-pi-ai': freeTierSection([
        { id: 'big-pickle', name: 'Big Pickle', contextWindow: 128000, maxTokens: 32000, input: ['text'] },
        { id: 'delisted-free', name: 'Delisted', contextWindow: 1, maxTokens: 1, input: ['text'] },
      ]),
    },
  })
  // The plugin must never reach the network in a test: stub the listing.
  plugin.tierListing = async () => [
    { id: 'big-pickle', name: 'Big Pickle' },
    { id: 'ling-3.0-flash-fin-free', name: 'Ling 3.0 Flash Fin Free' },
  ]

  const free = await plugin.freeTier()
  assert.equal(free.exists, true)
  assert.equal(free.apiKeyEnv, 'PI_AI_API_KEY')
  assert.deepEqual(free.configured.map(entry => entry.id), ['big-pickle', 'delisted-free'])
  assert.deepEqual(free.added, ['ling-3.0-flash-fin-free'])
  assert.deepEqual(free.stale, ['delisted-free'])

  const written = await plugin.putFreeTierModels([
    { id: 'big-pickle', name: 'Big Pickle', contextWindow: 128000, maxTokens: 32000, input: ['text'] },
    { id: 'ling-3.0-flash-fin-free', contextWindow: 64000, maxTokens: 16000 },
  ])
  assert.equal(written.count, 2)
  assert.equal(settings.__store['llm-pi-ai'].providers.opencode.models.length, 2)
  assert.equal(settings.__store['llm-pi-ai'].providers.opencode.models[1].name, 'Ling 3.0 Flash Fin Free')

  // An entry missing capacities is refused unless the caller opts in.
  await assert.rejects(
    () => plugin.putFreeTierModels([{ id: 'x' }]),
    /contextWindow is required/,
  )
  // Emptied lists go through the Models page, not this path.
  await assert.rejects(() => plugin.putFreeTierModels([]), /cannot be emptied/)
  await root.fiber.dispose()
})

test('the Go tier adds adopt a model into the catalog and expose it', async (t) => {
  const harness = await loadHarness(t)
  if (!harness) return
  const { root, plugin } = await boot(harness.OpenCodeSuite, harness.Context)
  plugin.tierListing = async tierId => (tierId === 'go'
    ? [{ id: 'brand-new-model', name: 'Brand New Model' }]
    : [{ id: 'deepseek-v4-flash-free' }])

  const result = await plugin.addTierModels('go', {
    ids: ['brand-new-model'],
    models: [],
    assumeDefaults: true,
  })
  assert.deepEqual(result.addedIds, ['brand-new-model'])
  assert.deepEqual(result.assumedCapacityIds, ['brand-new-model'])
  assert.equal(result.rejected.length, 0)

  // The adopted model is now part of the served catalog with the documented
  // default capacities, since the listing discloses none.
  const models = await plugin.listAvailableModels(plugin.current())
  const adopted = models.find(entry => entry.id === 'brand-new-model')
  assert.ok(adopted, 'the adopted model is in the catalog')
  assert.equal(adopted.dynamic, true)
  assert.equal(adopted.contextWindow, 1000000)
  assert.equal(adopted.capacitySource, 'default')

  // The capacity override is what a caller who knows better writes.
  const better = await plugin.addTierModels('go', {
    ids: [],
    models: [{ id: 'brand-new-model', contextWindow: 256000, maxTokens: 65536 }],
    assumeDefaults: false,
  })
  assert.deepEqual(better.skippedIds, ['brand-new-model'], 'an already-adopted id is never re-added')
  assert.equal(plugin.current().modelCapacities['brand-new-model'].contextWindow, 256000)
  await root.fiber.dispose()
})

test('a free-tier id offered to the Go tier is refused with the two-tier rule', async (t) => {
  const harness = await loadHarness(t)
  if (!harness) return
  const { root, plugin } = await boot(harness.OpenCodeSuite, harness.Context)
  plugin.tierListing = async tierId => (tierId === 'go'
    ? [{ id: 'deepseek-v4-pro' }]
    : [{ id: 'deepseek-v4-flash-free' }])

  const result = await plugin.addTierModels('go', {
    ids: ['deepseek-v4-flash-free'],
    models: [],
    assumeDefaults: true,
  })
  assert.equal(result.addedIds.length, 0)
  assert.equal(result.rejected.length, 1)
  assert.match(result.rejected[0].reason, /two tiers serve different ids/)
  await root.fiber.dispose()
})

test('removing a Go-tier model narrows the catalog to custom mode', async (t) => {
  const harness = await loadHarness(t)
  if (!harness) return
  const { root, plugin } = await boot(harness.OpenCodeSuite, harness.Context)
  const before = await plugin.listAvailableModels(plugin.current())
  assert.equal(plugin.current().modelMode, 'all')

  const result = await plugin.removeTierModels('go', ['deepseek-v4-flash'])
  assert.deepEqual(result.removedIds, ['deepseek-v4-flash'])
  assert.equal(result.mode, 'custom')

  const after = await plugin.listAvailableModels(plugin.current())
  assert.equal(after.find(entry => entry.id === 'deepseek-v4-flash').enabled, false)
  assert.equal(after.filter(entry => entry.enabled).length, before.length - 1)

  // Removing an id the route never served is reported, not silently accepted.
  const missing = await plugin.removeTierModels('go', ['no-such-model'])
  assert.deepEqual(missing.notFoundIds, ['no-such-model'])
  assert.deepEqual(missing.removedIds, [])
  await root.fiber.dispose()
})

test('sync previews drift and applies additions only on request', async (t) => {
  const harness = await loadHarness(t)
  if (!harness) return
  const { root, plugin } = await boot(harness.OpenCodeSuite, harness.Context)
  plugin.tierListing = async tierId => (tierId === 'go'
    ? [{ id: 'deepseek-v4-flash' }, { id: 'surprise-model' }]
    : [])

  const preview = await plugin.syncTier('go', { apply: false, pruneStale: false })
  assert.deepEqual(preview.planAdd, ['surprise-model'])
  assert.deepEqual(preview.appliedAdd, [])
  assert.equal(plugin.dynamicModels.get('opencode-go'), undefined, 'a preview writes nothing')

  const applied = await plugin.syncTier('go', { apply: true, pruneStale: false })
  assert.deepEqual(applied.appliedAdd, ['surprise-model'])
  assert.deepEqual(applied.assumedCapacityIds, ['surprise-model'])
  await root.fiber.dispose()
})

test('refreshModels merges the live lineup and reports what was new', async (t) => {
  const harness = await loadHarness(t)
  if (!harness) return
  const { root, plugin } = await boot(harness.OpenCodeSuite, harness.Context)
  let fetched = 0
  plugin.fetchModelsImpl = async () => {
    fetched += 1
    return {
      ok: true,
      status: 200,
      async json() {
        return { object: 'list', data: [{ id: 'deepseek-v4-flash' }, { id: 'fresh-model' }] }
      },
    }
  }

  const result = await plugin.refreshModels()
  assert.equal(fetched, 1)
  assert.equal(result.count, 2)
  assert.deepEqual(result.added, ['fresh-model'], 'a shipped model is not "new"')
  // The fetched lineup survives into the served catalog.
  const models = await plugin.listAvailableModels(plugin.current())
  assert.ok(models.some(entry => entry.id === 'fresh-model' && entry.dynamic))
  await root.fiber.dispose()
})

/* ------------------------------------------------------------------ *
 * Tool wiring
 * ------------------------------------------------------------------ */

test('oc_suite_status renders a full report from the live service', async (t) => {
  const harness = await loadHarness(t)
  if (!harness) return
  const { root, tools, plugin } = await boot(harness.OpenCodeSuite, harness.Context, {
    config: { keys: TWO_KEYS },
    sections: { 'llm-pi-ai': freeTierSection([]) },
  })
  plugin.tierListing = async tierId => (tierId === 'go'
    ? [{ id: 'deepseek-v4-flash' }]
    : [{ id: 'big-pickle' }])

  const tool = tools.tools.find(entry => entry.name === 'oc_suite_status')
  const value = await tool.execute({}, { signal: undefined })
  assert.equal(value.error, undefined)
  const [block] = tool.output.render({}, value)
  assert.equal(block.type, 'text')
  assert.match(block.text, /Takeover: serving/)
  assert.match(block.text, /Key pool: 2 key\(s\)/)
  assert.match(block.text, /Session headers: ON/)
  assert.match(block.text, /OpenCode Zen 免费档/)
  // The drift block reads the `freeTier()` shape (`configured` / `live` are the
  // lists themselves), not the `modelTierReport()` one that `oc_model_status`
  // renders. Asserting the label alone passed while the block printed `null`
  // and stopped early, so the numbers are what pin this down.
  assert.match(block.text, /configured 0 · live 1/)
  assert.match(block.text, /\+ online, not configured \(1\): big-pickle/)
  await root.fiber.dispose()
})

test('a tool contains a service failure instead of throwing across the registry', async (t) => {
  const harness = await loadHarness(t)
  if (!harness) return
  const root = new harness.Context()
  const tools = makeMockTools()
  let suite
  const settings = makeMockSettings(() => suite.config, { onUpdate: () => root.emit('loader/volatile-update', []) })
  root.provide('llm', makeMockLlms())
  root.provide('settings', settings)
  root.provide('credentials', { resolve: async () => undefined })
  root.provide('tools', tools)
  await root.plugin(harness.OpenCodeSuite, { ...BASE_CONFIG })
  suite = root.get('opencodeSuite')

  const poolTool = tools.tools.find(entry => entry.name === 'oc_suite_pool')
  // An unknown action and an unknown key both come back as values, never throws.
  const bad = await poolTool.execute({ action: 'teleport', keyId: 'acc-a' }, {})
  assert.match(bad.error, /unknown action/)
  const missing = await poolTool.execute({ action: 'switch', keyId: 'ghost' }, {})
  assert.match(missing.error, /unknown key/)

  // A tool whose suite is gone teaches the fix rather than crashing the turn.
  const orphan = (await import('../tools.js')).createTools({ suite: () => undefined })
  const statusTool = orphan.find(entry => entry.name === 'oc_suite_status')
  const orphaned = await statusTool.execute({}, {})
  assert.match(orphaned.error, /is unavailable; enable the dsh-opencode-suite plugin/)
  await root.fiber.dispose()
})

test('the live source accounts a streamed call while session headers still scope it', async (t) => {
  const harness = await loadHarness(t)
  if (!harness) return
  const { root, plugin } = await boot(harness.OpenCodeSuite, harness.Context, {
    config: { sessionHeaders: { enabled: true } },
  })
  const options = { provider: 'opencode-go', model: 'grok-4.7', sessionId: 's-live' }
  const chunks = []
  for await (const chunk of plugin.scopeStream(options, () => (async function* () {
    yield { type: 'text', text: 'hi' }
    yield { type: 'usage', usage: { inputTokens: 120, outputTokens: 8, cacheReadTokens: 4000 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })())) chunks.push(chunk)

  assert.equal(chunks.length, 3, 'every chunk reaches the consumer untouched')
  const report = await plugin.usageBreakdown(1)
  assert.equal(report.source, 'live')
  assert.equal(report.error, null)
  assert.equal(report.totals.calls, 1)
  assert.equal(report.totals.cacheRead, 4000)
  assert.deepEqual(report.models.map(row => row.model), ['opencode-go/grok-4.7'])
  await root.fiber.dispose()
})

test('the log source is what reads the session log, and the two are exclusive', async (t) => {
  const harness = await loadHarness(t)
  if (!harness) return
  const { root, plugin } = await boot(harness.OpenCodeSuite, harness.Context, {
    config: { usageLogSource: 'log' },
  })
  const empty = await plugin.usageBreakdown(1)
  assert.equal(empty.source, 'log')
  // No persistence seam in this composition, and it says why instead of
  // pretending the history is empty.
  assert.equal(empty.error, 'the sessionPersistence service is unavailable in this profile')
  await root.fiber.dispose()
})

test('the live counters survive a host restart through their own state file', async (t) => {
  const harness = await loadHarness(t)
  if (!harness) return
  const stream = async (plugin, usage) => {
    const options = { provider: 'opencode-go', model: 'grok-4.7', sessionId: 's' }
    for await (const _chunk of plugin.scopeStream(options, () => (async function* () {
      yield { type: 'usage', usage }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })())) { /* drain */ }
  }
  const first = await boot(harness.OpenCodeSuite, harness.Context)
  await stream(first.plugin, { inputTokens: 100, outputTokens: 20, cacheReadTokens: 9000 })
  first.plugin.flushUsageState()
  const before = await first.plugin.usageBreakdown(1)
  assert.equal(before.totals.calls, 1)
  await first.root.fiber.dispose()

  // A second host over the same DSH_HOME: the day's totals are still there.
  const second = await boot(harness.OpenCodeSuite, harness.Context)
  const after = await second.plugin.usageBreakdown(1)
  assert.equal(after.totals.calls, 1, 'a restart must not erase the day')
  assert.equal(after.totals.cacheRead, 9000)
  await stream(second.plugin, { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 })
  const grown = await second.plugin.usageBreakdown(1)
  assert.equal(grown.totals.calls, 2, 'new turns add to the restored counters')
  await second.root.fiber.dispose()
})

/* ------------------------------------------------------------------ *
 * IM delivery
 * ------------------------------------------------------------------ */

/** A dsh-im double: the same three methods the real plugin provides. */
function imDouble({ bots = [{ botId: 'bot_1', channel: 'telegram' }], targets = {}, fail = null } = {}) {
  const sent = []
  return {
    sent,
    async send(botId, targetId, text, options) {
      sent.push({ botId, targetId, text, options })
      if (fail !== null) throw Object.assign(new Error('channel refused'), { code: fail })
      return { sent: true }
    },
    async listBots() { return bots },
    async listTargets(botId) { return targets[botId] ?? [] },
  }
}

test('the card is offered the targets dsh-im already has, and picks one without any file', async (t) => {
  const harness = await loadHarness(t)
  if (!harness) return
  const im = imDouble({ targets: { bot_1: [{ targetId: 'release-alerts', name: '发布提醒', kind: 'chat' }] } })
  const { root, plugin } = await boot(harness.OpenCodeSuite, harness.Context)
  root.provide('dshIm', im)

  const report = await plugin.imTargets()
  assert.equal(report.available, true)
  assert.equal(report.reason, null)
  assert.deepEqual(report.bots.map(bot => bot.botId), ['bot_1'])
  assert.deepEqual(report.bots[0].targets, [{ targetId: 'release-alerts', name: '发布提醒', kind: 'chat' }])
  await root.fiber.dispose()
})

test('an empty or unreachable IM is reported as a reason, never as silence', async (t) => {
  const harness = await loadHarness(t)
  if (!harness) return

  const none = await boot(harness.OpenCodeSuite, harness.Context)
  const missing = await none.plugin.imTargets()
  assert.equal(missing.available, false, 'no dsh-im in this profile')
  assert.match(missing.reason, /dsh-im/)
  await none.root.fiber.dispose()

  const empty = await boot(harness.OpenCodeSuite, harness.Context)
  empty.root.provide('dshIm', imDouble({ bots: [] }))
  const noBot = await empty.plugin.imTargets()
  assert.equal(noBot.available, true, 'dsh-im is there, it just has nothing configured')
  assert.match(noBot.reason, /no bot/)
  await empty.root.fiber.dispose()

  const noTarget = await boot(harness.OpenCodeSuite, harness.Context)
  noTarget.root.provide('dshIm', imDouble({ bots: [{ botId: 'bot_1', channel: 'slack' }], targets: {} }))
  const report = await noTarget.plugin.imTargets()
  assert.match(report.reason, /no delivery target/)
  await noTarget.root.fiber.dispose()

  // One channel that cannot answer must not hide the one that can.
  const partial = await boot(harness.OpenCodeSuite, harness.Context)
  const flaky = imDouble({ targets: { bot_2: [{ targetId: 't2', name: 'Ops', kind: 'chat' }] } })
  flaky.listBots = async () => [{ botId: 'bot_1', channel: 'dead' }, { botId: 'bot_2', channel: 'slack' }]
  flaky.listTargets = async botId => {
    if (botId === 'bot_1') throw Object.assign(new Error('401'), { code: 'unauthorized' })
    return [{ targetId: 't2', name: 'Ops', kind: 'chat' }]
  }
  partial.root.provide('dshIm', flaky)
  const mixed = await partial.plugin.imTargets()
  assert.deepEqual(mixed.bots.find(bot => bot.botId === 'bot_1').targets, [], 'the dead channel is empty, not fatal')
  assert.equal(mixed.bots.find(bot => bot.botId === 'bot_2').targets.length, 1)
  assert.equal(mixed.reason, null)
  await partial.root.fiber.dispose()
})

test('the test button sends markdown to the chosen target and names every refusal', async (t) => {
  const harness = await loadHarness(t)
  if (!harness) return
  const im = imDouble({ targets: { bot_1: [{ targetId: 'release-alerts', name: '发布提醒', kind: 'chat' }] } })

  const off = await boot(harness.OpenCodeSuite, harness.Context)
  off.root.provide('dshIm', im)
  assert.deepEqual(await off.plugin.testImNotify(), { sent: false, error: 'no IM bot is chosen' })
  assert.equal(im.sent.length, 0, 'nothing is sent before a target is chosen')
  await off.root.fiber.dispose()

  const on = await boot(harness.OpenCodeSuite, harness.Context, {
    config: { notifyImEnabled: true, notifyImBotId: 'bot_1', notifyImTargetId: 'release-alerts' },
  })
  on.root.provide('dshIm', im)
  const ok = await on.plugin.testImNotify()
  assert.equal(ok.sent, true)
  assert.equal(ok.error, null)
  assert.equal(im.sent.length, 1)
  assert.equal(im.sent[0].targetId, 'release-alerts')
  assert.equal(im.sent[0].options.format, 'markdown')
  assert.ok(im.sent[0].text.includes('OpenCode'), 'the test says what it is')
  await on.root.fiber.dispose()

  const refused = await boot(harness.OpenCodeSuite, harness.Context, {
    config: { notifyImEnabled: true, notifyImBotId: 'bot_1', notifyImTargetId: 'release-alerts' },
  })
  refused.root.provide('dshIm', imDouble({ fail: 'unauthorized' }))
  const failed = await refused.plugin.testImNotify()
  assert.equal(failed.sent, false)
  assert.match(failed.error, /unauthorized/, 'the channel code survives into the card')
  await refused.root.fiber.dispose()
})

test('a pass that finds a new model pushes it once, and never pushes the baseline', async (t) => {
  const harness = await loadHarness(t)
  if (!harness) return
  const im = imDouble({ targets: { bot_1: [{ targetId: 'release-alerts', name: '发布提醒', kind: 'chat' }] } })
  const { root, plugin } = await boot(harness.OpenCodeSuite, harness.Context, {
    config: { notifyImEnabled: true, notifyImBotId: 'bot_1', notifyImTargetId: 'release-alerts' },
  })
  root.provide('dshIm', im)
  const listings = { go: ['grok-4.7'], free: [] }
  plugin.tierListing = async tierId => (listings[tierId] ?? []).map(id => ({ id, name: id }))

  await plugin.checkModels({ fresh: true })
  assert.equal(im.sent.length, 0, 'the baseline pass says nothing')

  listings.go.push('glm-5.4')
  await plugin.checkModels({ fresh: true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(im.sent.length, 1, 'one push for one new id')
  assert.ok(im.sent[0].text.includes('glm-5.4'), 'and it names the model')

  // A later pass with nothing new must stay quiet rather than re-announce.
  await plugin.checkModels({ fresh: true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(im.sent.length, 1, 'the same id is not pushed twice')
  await root.fiber.dispose()
})

test('a refused push leaves the work list intact for the card', async (t) => {
  const harness = await loadHarness(t)
  if (!harness) return
  const { root, plugin } = await boot(harness.OpenCodeSuite, harness.Context, {
    config: { notifyImEnabled: true, notifyImBotId: 'bot_1', notifyImTargetId: 'release-alerts' },
  })
  root.provide('dshIm', imDouble({ fail: 'rate-limited' }))
  const listings = { go: ['grok-4.7'], free: [] }
  plugin.tierListing = async tierId => (listings[tierId] ?? []).map(id => ({ id, name: id }))

  await plugin.checkModels({ fresh: true })
  listings.go.push('grok-4.8')
  await plugin.checkModels({ fresh: true })
  await new Promise(resolve => setImmediate(resolve))

  const report = (await plugin.status()).modelWatch
  assert.equal(report.tiers.go.pending.length, 1, 'the refused push did not consume the news')
  assert.equal(report.error, null, 'and the listing check itself is unaffected')
  await root.fiber.dispose()
})
