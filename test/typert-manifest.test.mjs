import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

// Validates the hand-written Typert host manifest against the REAL
// typert-loader validation (the exact gate the live host runs: a rejected
// manifest fails the whole plugin activation, which surfaces as HTTP 404 for
// every /api/opencodeSuite/* route), and then against the REAL service output
// (a result schema that the loader accepts but the service cannot satisfy is a
// page that loads and then fails on every poll).
//
// Both halves skip when the harness peer deps are absent.

const EXPECTED_METHODS = [
  'status',
  'usageBreakdown',
  'checkModels',
  'dismissModelNews',
  'imTargets',
  'reseedModelNews',
  'testImNotify',
  'takeOverState',
  'setActive',
  'setDisabled',
  'clearInvalid',
  'clearExhausted',
  'putKeys',
  'putKeySecret',
  'putConfig',
  'putSessionHeaders',
  'clearSessionLog',
  'refreshModels',
  'freeTier',
  'putFreeTierModels',
]

async function loadManifest(t) {
  let validateTypertManifest, TYPERT
  try {
    ;({ validateTypertManifest } = await import('@deepseek-ai/dsh-typert-loader'))
    ;({ TYPERT } = await import('../typert.host.js'))
  } catch {
    t.skip('dsh-typert-loader not installed — link the DSH node_modules to run manifest tests')
    return null
  }
  return { validateTypertManifest, TYPERT }
}

test('the host manifest passes the real typert-loader validation', async (t) => {
  const loaded = await loadManifest(t)
  if (!loaded) return
  const validated = loaded.validateTypertManifest('dsh-opencode-suite', loaded.TYPERT)

  assert.equal(validated.package, 'dsh-opencode-suite')
  assert.equal(validated.face, 'host')
  assert.deepEqual(validated.invocations.map(inv => inv.method).sort(), [...EXPECTED_METHODS].sort())
  for (const inv of validated.invocations) {
    // src-json codecs are rejected by the loader, so every result must be a
    // strict schema — a regression here breaks the whole plugin, not one page.
    assert.equal(inv.result.mode, 'strict', `${inv.method} result must be strict`)
    assert.equal(inv.service, 'opencodeSuite', `${inv.method} dispatches the right service`)
    assert.equal(inv.namespace, 'opencodeSuite')
    for (const parameter of inv.parameters) {
      assert.equal(parameter.codec.mode, 'strict', `${inv.method}/${parameter.name} param must be strict`)
    }
  }
})

test('every invocation exists as a method on the service', async (t) => {
  const loaded = await loadManifest(t)
  if (!loaded) return
  let OpenCodeSuite
  try {
    ;({ OpenCodeSuite } = await import('../index.js'))
  } catch {
    t.skip('harness peer deps not installed')
    return
  }
  for (const method of EXPECTED_METHODS) {
    assert.equal(typeof OpenCodeSuite.prototype[method], 'function',
      `the manifest declares ${method} but the service does not implement it`)
  }
})

test('every result schema accepts the real service output', async (t) => {
  const loaded = await loadManifest(t)
  if (!loaded) return

  // Mount the plugin exactly as the smoke test does, then push real payloads
  // through the manifest's own result schemas.
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-opencode-suite-'))
  let Context, OpenCodeSuite
  try {
    ;({ Context } = await import('@deepseek-ai/cordis'))
    ;({ OpenCodeSuite } = await import('../index.js'))
  } catch {
    t.skip('harness peer deps not installed')
    return
  }

  const root = new Context()
  const llms = {
    registered: [],
    adapter: null,
    registerAdapter(routes, adapter) {
      this.registered.push([...routes])
      this.adapter = adapter
      return { replace: () => {} }
    },
  }
  const config = {
    route: 'opencode-go',
    keys: [
      { id: 'acc-a', label: '主号', apiKeyEnv: 'OPENCODE_GO_KEY_A' },
      { id: 'acc-b', label: '备用2', apiKeyEnv: 'OPENCODE_GO_KEY_B' },
    ],
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
    usageLogEnabled: true,
    usageLogSource: 'live',
    usageLogWindowDays: 7,
    usageLogRetentionDays: 90,
    usageLogSessionsPerSweep: 40,
    usageLogSweepMaxMs: 4000,
    modelWatchEnabled: true,
    modelWatchIntervalMs: 900000,
    notifyImEnabled: false,
    notifyImBotId: '',
    notifyImTargetId: '',
  }
  // The 0.1.7 settings contract: this plugin owns no settings scope any more, it
  // keeps the Config references the Loader resolved and persists through
  // `update(ns, patch)`, which commits into those references (cosmokit's shared
  // `write` symbol — the same commit the Loader performs) and then announces the
  // change. Other namespaces come back from `describe()` with a `value`.
  const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')
  let suite
  let settings = {
    writable: true,
    describe: () => [{
      ns: 'llm-pi-ai',
      revision: 3,
      value: {
        providers: {
          opencode: {
            apiKeyEnv: 'PI_AI_API_KEY',
            baseURL: 'https://opencode.ai/zen/v1',
            api: 'openai-completions',
            models: [{ id: 'big-pickle', name: 'Big Pickle', contextWindow: 128000, maxTokens: 32000, input: ['text'] }],
          },
        },
      },
    }],
    update: async (ns, patch) => {
      if (ns !== 'opencode-suite') return
      for (const [key, value] of Object.entries(patch)) suite.config[key][VOLATILE_WRITE](value)
      root.emit('loader/volatile-update', [])
    },
  }
  root.provide('llm', llms)
  root.provide('settings', settings)
  root.provide('credentials', { resolve: async () => undefined })
  root.provide('tools', { register: () => () => {} })
  await root.plugin(OpenCodeSuite, config)
  suite = root.get('opencodeSuite')

  // Keep the test off the network: the report paths go through tierListing.
  suite.tierListing = async tierId => (tierId === 'go'
    ? [{ id: 'deepseek-v4-pro', name: 'Deepseek V4 Pro' }, { id: 'brand-new', name: 'Brand New' }]
    : [{ id: 'big-pickle', name: 'Big Pickle' }])
  suite.fetchModelsImpl = async () => ({
    ok: true,
    status: 200,
    async json() {
      return { data: [{ id: 'deepseek-v4-pro' }, { id: 'brand-new' }] }
    },
  })

  // Exercise every mutation so the payloads below are non-trivial, then validate
  // each declared result against its own strict schema.
  await suite.setActive('acc-b')
  await suite.setDisabled('acc-b', false)
  await suite.clearInvalid('acc-a')
  await suite.clearExhausted('acc-a')
  await suite.putKeys(config.keys)
  await suite.putConfig({ preemptAtPercent: 90, modelMode: 'all' })
  await suite.putSessionHeaders({ enabled: true, nanoidLength: 8 })
  await suite.addTierModels('go', { ids: ['brand-new'], models: [], assumeDefaults: true })

  const invocations = new Map(loaded.TYPERT.invocations.map(inv => [inv.method, inv]))

  /** Validate one payload against the manifest's declared result codec. */
  const validateResult = (method, payload) => {
    const invocation = invocations.get(method)
    // 0.1.7 codecs carry a `create()` factory rather than the schema instance.
    const parsed = invocation.result.create().safeParse(payload)
    if (!parsed.success) {
      assert.fail(`${method} result rejected by its own strict codec: ${JSON.stringify(parsed.error.issues, null, 2)}`)
    }
  }
  /** Validate one parameter payload against the manifest's declared codec. */
  const validateParam = (method, name, payload) => {
    const invocation = invocations.get(method)
    const parameter = invocation.parameters.find(entry => entry.name === name)
    const parsed = parameter.codec.create().safeParse(payload)
    if (!parsed.success) {
      assert.fail(`${method}/${name} rejected by its own codec: ${JSON.stringify(parsed.error.issues, null, 2)}`)
    }
  }

  validateResult('status', await suite.status())
  // No `sessionPersistence` in this composition: the method must still answer
  // with a schema-valid payload that says why it is empty.
  // The live source answers from what this host streamed, so it needs no
  // persistence seam at all.
  const breakdown = await suite.usageBreakdown(30)
  assert.equal(breakdown.source, 'live')
  assert.equal(breakdown.error, null)
  // The gateway calls a strict method with the resolved wire values IN ORDER,
  // so a service that took an object here would drop the window silently. The
  // window asserted differs from the configured 7, so "fell back to the
  // default" cannot pass as "the argument arrived".
  assert.equal(breakdown.windowDays, 30, 'the positional window reaches the service')
  validateResult('usageBreakdown', breakdown)
  validateResult('checkModels', await suite.checkModels())
  // No dsh-im in this composition, and the report says so instead of pretending
  // there is nowhere to push.
  const targets = await suite.imTargets()
  assert.equal(targets.available, false)
  assert.match(targets.reason, /dsh-im/)
  validateResult('imTargets', targets)
  const delivery = await suite.testImNotify()
  assert.equal(delivery.sent, false)
  assert.match(delivery.error, /no IM bot/)
  validateResult('testImNotify', delivery)
  validateResult('takeOverState', await suite.takeOverState())
  validateResult('freeTier', await suite.freeTier())
  validateResult('refreshModels', await suite.refreshModels())
  validateResult('putFreeTierModels', await suite.putFreeTierModels([
    { id: 'big-pickle', name: 'Big Pickle', contextWindow: 128000, maxTokens: 32000, input: ['text'] },
  ]))

  validateParam('putKeys', 'keys', config.keys)
  validateParam('usageBreakdown', 'days', 30)
  const badDays = invocations.get('usageBreakdown').parameters[0].codec.create().safeParse({ days: 'a week' })
  assert.equal(badDays.success, false, 'a wrong-typed window never reaches the service')
  // An omitted window is legal end to end: the schema is optional, the
  // descriptor declares it, and the service falls back to its configured one.
  const days = invocations.get('usageBreakdown').parameters[0]
  assert.equal(days.acceptsUndefined, true, 'the gateway allows omitting an optional field')
  assert.equal(days.codec.create().parse(undefined), undefined)
  validateParam('putConfig', 'config', { preemptAtPercent: 50, models: ['a'], imageModels: ['a'], modelCapacities: { a: { contextWindow: 1, maxTokens: 1 } } })
  validateParam('putSessionHeaders', 'patch', { enabled: false, hosts: ['opencode.ai'], extraHeaders: { 'x-a': 'b' } })
  validateParam('putFreeTierModels', 'entries', [{ id: 'a', contextWindow: 1, maxTokens: 1, input: ['text'] }])

  // A payload the card must never be able to slip through: an unknown
  // nanoidLength is refused by the codec before the service ever sees it.
  const bad = invocations.get('putSessionHeaders').parameters[0].codec.create().safeParse({ nanoidLength: 'eight' })
  assert.equal(bad.success, false, 'a wrong-typed patch never reaches the service')

  await root.fiber.dispose()
})
