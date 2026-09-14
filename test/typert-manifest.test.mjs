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
  let config = {
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
  }
  const watchers = new Set()
  const scope = {
    get: () => config,
    watch: callback => { watchers.add(callback); return () => watchers.delete(callback) },
    update: async patch => {
      config = { ...config, ...patch }
      for (const callback of watchers) await callback(config)
    },
    replace: async () => {},
  }
  root.provide('llm', llms)
  root.provide('settings', {
    writable: true,
    register: () => scope,
    get: ns => (ns === 'llm-pi-ai'
      ? {
          providers: {
            opencode: {
              apiKeyEnv: 'PI_AI_API_KEY',
              baseURL: 'https://opencode.ai/zen/v1',
              api: 'openai-completions',
              models: [{ id: 'big-pickle', name: 'Big Pickle', contextWindow: 128000, maxTokens: 32000, input: ['text'] }],
            },
          },
          __revision: 3,
        }
      : undefined),
    describe: () => [{ ns: 'llm-pi-ai', revision: 3 }],
    update: async () => {},
  })
  root.provide('credentials', { resolve: async () => undefined })
  root.provide('tools', { register: () => () => {} })
  await root.plugin(OpenCodeSuite, {})
  const suite = root.get('opencodeSuite')

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
    const schema = invocation.result.schema
    const parsed = schema.safeParse(payload)
    if (!parsed.success) {
      assert.fail(`${method} result rejected by its own strict codec: ${JSON.stringify(parsed.error.issues, null, 2)}`)
    }
  }
  /** Validate one parameter payload against the manifest's declared codec. */
  const validateParam = (method, name, payload) => {
    const invocation = invocations.get(method)
    const parameter = invocation.parameters.find(entry => entry.name === name)
    const parsed = parameter.codec.schema.safeParse(payload)
    if (!parsed.success) {
      assert.fail(`${method}/${name} rejected by its own codec: ${JSON.stringify(parsed.error.issues, null, 2)}`)
    }
  }

  validateResult('status', await suite.status())
  validateResult('takeOverState', await suite.takeOverState())
  validateResult('freeTier', await suite.freeTier())
  validateResult('refreshModels', await suite.refreshModels())
  validateResult('putFreeTierModels', await suite.putFreeTierModels([
    { id: 'big-pickle', name: 'Big Pickle', contextWindow: 128000, maxTokens: 32000, input: ['text'] },
  ]))

  validateParam('putKeys', 'keys', config.keys)
  validateParam('putConfig', 'config', { preemptAtPercent: 50, models: ['a'], imageModels: ['a'], modelCapacities: { a: { contextWindow: 1, maxTokens: 1 } } })
  validateParam('putSessionHeaders', 'patch', { enabled: false, hosts: ['opencode.ai'], extraHeaders: { 'x-a': 'b' } })
  validateParam('putFreeTierModels', 'entries', [{ id: 'a', contextWindow: 1, maxTokens: 1, input: ['text'] }])

  // A payload the card must never be able to slip through: an unknown
  // nanoidLength is refused by the codec before the service ever sees it.
  const bad = invocations.get('putSessionHeaders').parameters[0].codec.schema.safeParse({ nanoidLength: 'eight' })
  assert.equal(bad.success, false, 'a wrong-typed patch never reaches the service')

  await root.fiber.dispose()
})
