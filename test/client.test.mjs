import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import test from 'node:test'

// Client-bundle execution tests: the bundle is only REGISTERED by the module
// loader, so a syntax check proves nothing about it. These tests actually
// EXECUTE it (window stub + react), run apply() against a mock slot/locale/
// remote context, and server-render the captured settings section plus its
// inner cards. They skip when react/react-dom are absent (fresh clone without
// the DSH node_modules).

const here = dirname(fileURLToPath(import.meta.url))
const clientPath = join(here, '..', 'client.js')
const clientUrl = pathToFileURL(clientPath).href

async function loadReact(t) {
  let React, renderToString
  try {
    React = (await import('react')).default
    ;({ renderToString } = await import('react-dom/server'))
  } catch {
    t.skip('react/react-dom not installed')
    return null
  }
  return { React, renderToString }
}

/** Execute the bundle under a window stub; returns its registration spec. */
async function loadClientBundle(t) {
  let spec
  const previousWindow = globalThis.window
  globalThis.window = {
    __ModuleLoader__: {
      load: entry => { spec = entry },
    },
  }
  try {
    // Cache-busting query: each test gets a fresh evaluation of the bundle.
    await import(`${clientUrl}?case=${Date.now()}-${Math.random()}`)
  } finally {
    globalThis.window = previousWindow
  }
  assert.ok(spec, 'bundle registers its factory')
  assert.equal(spec.id, 'dsh-opencode-suite')
  return spec
}

/** Bundle exports, materialized with a react-only require. */
async function loadModule(t) {
  const harness = await loadReact(t)
  if (!harness) return null
  const spec = await loadClientBundle(t)
  const module = spec.factory(name => {
    if (name === 'react') return harness.React
    throw new Error(`unexpected require: ${name}`)
  })
  return { ...harness, spec, module }
}

/** Depth-first walk over a React element tree, yielding every element. */
function* walk(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return
  if (Array.isArray(node)) {
    for (const child of node) yield* walk(child)
    return
  }
  if (typeof node !== 'object' || !node.props) return
  yield node
  yield* walk(node.props.children)
}

/** Flatten an element subtree to its concatenated text. */
function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node !== 'object' || !node.props) return ''
  return textOf(node.props.children)
}

/** The first button whose visible text contains `needle`. */
function buttonWith(root, needle) {
  for (const node of walk(root)) {
    if (node.type === 'button' && textOf(node).includes(needle)) return node
  }
  return null
}

/* ------------------------------------------------------------------ *
 * Registration and locale hygiene
 * ------------------------------------------------------------------ */

test('bundle executes and apply() registers one settings section with a scoped nav label', async (t) => {
  const loaded = await loadModule(t)
  if (!loaded) return
  const { React, renderToString, module } = loaded

  let registration
  module.apply({
    remote: { $mount: async () => {} },
    effect: fn => { const dispose = fn(); return () => (typeof dispose === 'function' ? dispose() : undefined) },
    locale: { register: () => () => {}, bind: () => key => key },
    slots: {
      register: (opts, component) => { registration = { ...opts, component } },
      inject: (_name, factory) => { factory() },
    },
    get: () => null,
  })

  assert.equal(registration.name, 'settings.section')
  assert.equal(registration.id, 'opencode-suite')
  assert.equal(registration.order, 42)
  assert.equal(registration.locale, module.NS)
  assert.equal(module.NS, 'settings.opencodeSuite')
  assert.equal(typeof registration.component, 'function')

  // The nav label is a React element: the suite mark plus the localized text.
  const labelHtml = renderToString(React.createElement(React.Fragment, null, registration.label()))
  assert.ok(labelHtml.includes('dsh-ocs-nav-mark'), 'nav label carries the suite mark')
  assert.ok(labelHtml.includes('nav'), 'nav label carries the localized text')

  // The injected rule must target exactly our mark, so the shell gear is
  // hidden on this row only and never on a built-in row.
  assert.deepEqual(module.inject, ['slots', 'locale', 'remote'])
  const source = readFileSync(clientPath, 'utf8')
  assert.ok(source.includes('button:has(.dsh-ocs-nav-mark) > svg'), 'nav rule scoped to our mark')
})

test('zh and en dictionaries carry identical key sets', async (t) => {
  const loaded = await loadModule(t)
  if (!loaded) return
  const { zh, en } = loaded.module.__test
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())
})

test('every t() key the page uses exists in both dictionaries', async (t) => {
  const loaded = await loadModule(t)
  if (!loaded) return
  const { zh, en } = loaded.module.__test
  const source = readFileSync(clientPath, 'utf8')
  const used = new Set()
  // The lookbehind keeps `createElement('style')` from reading as `t('style')`.
  for (const match of source.matchAll(/(?<![A-Za-z0-9_$])t\('([A-Za-z][A-Za-z0-9]*)'\)/g)) used.add(match[1])
  assert.ok(used.size > 100, `the page uses the dictionary heavily (found ${used.size})`)
  const missing = [...used].filter(key => !(key in zh) || !(key in en)).sort()
  assert.deepEqual(missing, [], 'no page key is missing from a dictionary')
})

/* ------------------------------------------------------------------ *
 * Remote contribution
 * ------------------------------------------------------------------ */

test('every Remote descriptor carries strict codecs (client binder requirement)', async (t) => {
  const loaded = await loadModule(t)
  if (!loaded) return
  const { TYPERT_REMOTE } = loaded.module.__test
  assert.equal(TYPERT_REMOTE.package, 'dsh-opencode-suite')
  assert.equal(TYPERT_REMOTE.descriptors.length, 19)
  for (const descriptor of TYPERT_REMOTE.descriptors) {
    assert.equal(descriptor.result.mode, 'strict', `${descriptor.method} result must be strict`)
    assert.equal(typeof descriptor.result.schema.parse, 'function')
    assert.equal(descriptor.service, 'opencodeSuite', `${descriptor.method} targets the right service`)
    assert.equal(descriptor.namespace, 'opencodeSuite')
    for (const parameter of descriptor.parameters) {
      assert.equal(parameter.codec.mode, 'strict', `${descriptor.method} parameter ${parameter.name} must be strict`)
      assert.equal(parameter.source, 'json')
    }
  }
})

test('the client descriptors mirror the host manifest method-for-method', async (t) => {
  const loaded = await loadModule(t)
  if (!loaded) return
  let TYPERT
  try {
    ;({ TYPERT } = await import('../typert.host.js'))
  } catch {
    t.skip('the host manifest is unavailable (zod missing)')
    return
  }
  const host = TYPERT.invocations.map(inv => inv.method).sort()
  const client = loaded.module.__test.TYPERT_REMOTE.descriptors.map(d => d.method).sort()
  assert.deepEqual(client, host, 'every host invocation is reachable from the page and vice versa')
  // Parameter arity must match too: a card calling with the wrong number of
  // arguments fails at the wire, not at mount.
  const arity = list => Object.fromEntries(list.map(entry => [entry.method, entry.parameters.length]))
  assert.deepEqual(
    arity(loaded.module.__test.TYPERT_REMOTE.descriptors),
    arity(TYPERT.invocations.map(inv => ({ method: inv.method, parameters: inv.parameters }))),
  )
})

test('unwrapRemote handles the typert result envelope', async (t) => {
  const loaded = await loadModule(t)
  if (!loaded) return
  const { unwrapRemote } = loaded.module.__test
  assert.deepEqual(unwrapRemote({ ok: true, value: { keys: [] } }), { keys: [] })
  assert.throws(() => unwrapRemote({ ok: false, error: { message: 'host refused' } }), /host refused/)
  assert.equal(unwrapRemote(undefined), undefined)
  assert.deepEqual(unwrapRemote({ ok: true }), { ok: true })
})

test('the bundle exposes no literal secrets anywhere', () => {
  const source = readFileSync(clientPath, 'utf8')
  assert.ok(!/sk-opencode-[A-Za-z0-9]+/.test(source), 'no literal OpenCode keys in the bundle')
  assert.ok(!/sk-[A-Za-z0-9]{20,}/.test(source), 'no literal sk- token in the bundle')
})

/* ------------------------------------------------------------------ *
 * Page shell
 * ------------------------------------------------------------------ */

test('the settings page renders its initial loading state', async (t) => {
  const loaded = await loadModule(t)
  if (!loaded) return
  const { React, renderToString } = loaded
  let registration
  loaded.module.apply({
    remote: { $mount: async () => {} },
    effect: fn => { fn(); return () => {} },
    locale: { register: () => () => {}, bind: () => key => key },
    slots: {
      register: (opts, component) => { registration = { ...opts, component } },
      inject: (_name, factory) => { factory() },
    },
    get: () => null,
  })

  const html = renderToString(React.createElement(registration.component, {
    t: key => key,
    api: async () => ({ status: async () => ({}) }),
  }))
  assert.ok(html.includes('title'), 'renders the page title')
  assert.ok(html.includes('loading'), 'renders the loading state')
})

/* ------------------------------------------------------------------ *
 * Key pool
 * ------------------------------------------------------------------ */

const USAGE_KEY = {
  id: 'acc-a',
  label: '主号',
  apiKeyEnv: 'OPENCODE_GO_KEY_A',
  state: 'healthy',
  active: true,
  usage: {
    rolling: { status: 'ok', percent: 9, resetsAt: null },
    weekly: { status: 'ok', percent: 12, resetsAt: null },
    monthly: { status: 'ok', percent: 6, resetsAt: null },
  },
  usageError: null,
  fetchedAt: null,
  credentialSet: true,
  lastFailure: null,
}

test('KeyCard renders usage bars, badges, and reset countdowns', async (t) => {
  const loaded = await loadModule(t)
  if (!loaded) return
  const { React, renderToString } = loaded
  const { KeyCard } = loaded.module.__test

  const resetTarget = Date.now() + (2 * 60 + 13) * 60000 + 10000 // +10s margin against floor()
  const item = {
    ...USAGE_KEY,
    usage: {
      rolling: { status: 'ok', percent: 9, resetsAt: new Date(resetTarget).toISOString() },
      weekly: { status: 'ok', percent: 12, resetsAt: new Date(resetTarget).toISOString() },
      monthly: { status: 'ok', percent: 6, resetsAt: new Date(resetTarget).toISOString() },
    },
  }
  const html = renderToString(React.createElement(KeyCard, {
    item, t: key => key, tick: Date.now(), busy: null, onAction: () => {},
  }))
  assert.ok(html.includes('主号'), 'shows the label')
  assert.ok(html.includes('OPENCODE_GO_KEY_A'), 'shows the credential ref')
  assert.ok(html.includes('activeBadge'), 'shows the in-use badge')
  assert.ok(html.includes('rolling') && html.includes('weekly') && html.includes('monthly'), 'shows all three windows')
  assert.ok(html.includes('9%'), 'rolling used percent')
  assert.ok(html.includes('91%'), 'rolling remaining percent')
  assert.ok(html.includes('2h 13m'), 'reset countdown renders')
  assert.ok(!html.includes('switchNow'), 'no switch button while this key is active')
  assert.ok(!html.includes('clearExhausted'), 'no exhausted action on a healthy key')
})

test('KeyCard offers exactly the actions the key state allows', async (t) => {
  const loaded = await loadModule(t)
  if (!loaded) return
  const { React, renderToString } = loaded
  const { KeyCard } = loaded.module.__test

  const render = item => renderToString(React.createElement(KeyCard, {
    item, t: key => key, tick: Date.now(), busy: null, onAction: () => {},
  }))

  // Exhausted: usage failed, the error text explains why, and the only way back
  // is the explicit clear action.
  const exhausted = render({
    ...USAGE_KEY,
    id: 'acc-b',
    label: '备用2',
    active: false,
    state: 'exhausted',
    usage: null,
    usageError: 'http-503',
    lastFailure: { code: 'QUOTA', message: 'quota', at: new Date().toISOString() },
  })
  assert.ok(exhausted.includes('exhaustedBadge'), 'shows the exhausted badge')
  assert.ok(exhausted.includes('httpError'), 'shows the usage error text')
  assert.ok(exhausted.includes('lastFailure'), 'shows the failure cause')
  assert.ok(exhausted.includes('clearExhausted'), 'offers the exhausted clear')
  assert.ok(!exhausted.includes('switchNow'), 'no manual switch on an unusable key')

  // Healthy + idle: the manual switch appears next to disable.
  const idle = render({ ...USAGE_KEY, id: 'acc-c', label: '备用3', active: false })
  assert.ok(idle.includes('switchNow'), 'manual switch offered on a usable idle key')
  assert.ok(idle.includes('disable'), 'offers disable')

  // Disabled: the toggle flips to enable, and nothing else is offered.
  const disabled = render({ ...USAGE_KEY, id: 'acc-d', label: '备用4', active: false, state: 'disabled' })
  assert.ok(disabled.includes('enable'), 'offers enable')
  assert.ok(!disabled.includes('switchNow'), 'no switch on a disabled key')
  assert.ok(!disabled.includes('clearExhausted'), 'no exhausted clear on a disabled key')

  // Invalid: the clear-invalid repair path, and the missing-credential marker.
  const invalid = render({
    ...USAGE_KEY,
    id: 'acc-e',
    label: '备用5',
    active: false,
    state: 'invalid',
    usage: null,
    usageError: 'no-api-key',
    credentialSet: false,
  })
  assert.ok(invalid.includes('invalidBadge'), 'shows the invalid badge')
  assert.ok(invalid.includes('credentialMissing'), 'marks the credential as unset')
  assert.ok(invalid.includes('clearInvalid'), 'offers the invalid clear')
  assert.ok(invalid.includes('noApiKey'), 'explains the missing credential')
})

test('the key editor refuses a ref name that is really a secret', async (t) => {
  const loaded = await loadModule(t)
  if (!loaded) return
  const { Editor } = loaded.module.__test

  const saved = []
  const base = {
    t: key => key, busy: null, existingKeys: [USAGE_KEY],
    setDraft: () => {},
    onSave: (rows, invalidMessage) => saved.push({ rows, invalidMessage }),
  }
  const submit = draft => {
    const tree = Editor({ ...base, draft })
    const button = buttonWith(tree, 'save')
    assert.ok(button, 'the save button renders')
    button.props.onClick()
  }

  // A bare label: the secret field is empty and the ref name is left to the host.
  submit([{ id: 'key-1', label: '主号', apiKeyEnv: '', secret: '' }])
  assert.equal(saved.length, 1)
  assert.deepEqual(saved[0].rows, [{ id: 'key-1', label: '主号', apiKeyEnv: '', secret: '' }])
  assert.equal(saved[0].invalidMessage, undefined)

  // A pasted secret in the ref-name field is refused with the field hint.
  saved.length = 0
  submit([{ id: 'key-2', label: '主号', apiKeyEnv: 'sk-opencode-live-abcdef', secret: '' }])
  assert.equal(saved.length, 1)
  assert.equal(saved[0].rows, null)
  assert.equal(saved[0].invalidMessage, 'envInvalidHint')

  // A missing label is refused before anything else.
  saved.length = 0
  submit([{ id: 'key-3', label: '  ', apiKeyEnv: '', secret: '' }])
  assert.equal(saved[0].rows, null)
  assert.equal(saved[0].invalidMessage, 'labelPlaceholder')

  // The row list is trimmed on the way out, so a stray space never becomes a
  // distinct key id.
  saved.length = 0
  submit([{ id: 'key-4', label: '  主号  ', apiKeyEnv: '  ', secret: '  sk-live  ' }])
  assert.deepEqual(saved[0].rows, [{ id: 'key-4', label: '主号', apiKeyEnv: '', secret: 'sk-live' }])
})

test('the key editor confirms before dropping an already-saved key', async (t) => {
  const loaded = await loadModule(t)
  if (!loaded) return
  const { Editor } = loaded.module.__test

  const saved = []
  const base = {
    t: key => key, busy: null, existingKeys: [USAGE_KEY],
    setDraft: () => {},
    onSave: (rows, invalidMessage) => saved.push({ rows, invalidMessage }),
  }
  const submit = draft => {
    const tree = Editor({ ...base, draft })
    buttonWith(tree, 'save').props.onClick()
  }

  const previousWindow = globalThis.window
  let asked = 0
  try {
    globalThis.window = { confirm: () => { asked += 1; return false } }
    // Removing the only existing key must ask first; a refusal saves nothing.
    submit([])
    assert.equal(asked, 1, 'the removal was confirmed first')
    assert.equal(saved.length, 0, 'a refused confirmation saves nothing')

    globalThis.window = { confirm: () => { asked += 1; return true } }
    submit([])
    assert.equal(asked, 2)
    assert.deepEqual(saved[0].rows, [], 'an accepted confirmation sends the emptied list')

    // An unchanged list never asks, so a routine save cannot delete a key by
    // accident.
    asked = 0
    saved.length = 0
    globalThis.window = { confirm: () => { asked += 1; return true } }
    submit([{ id: 'acc-a', label: '主号', apiKeyEnv: 'OPENCODE_GO_KEY_A', secret: '' }])
    assert.equal(asked, 0, 'no confirmation for a non-destructive save')
    assert.equal(saved.length, 1)
  } finally {
    globalThis.window = previousWindow
  }
})

/* ------------------------------------------------------------------ *
 * Model card
 * ------------------------------------------------------------------ */

const MODEL_DATA = {
  modelMode: 'custom',
  modelCapacities: {},
  availableModels: [
    { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', enabled: true, dynamic: false, inputs: ['text', 'image'], catalogInputs: ['text'], contextWindow: 128000, maxTokens: 32000, capacitySource: 'catalog' },
    { id: 'glm-5.3', name: 'GLM-5.3', enabled: false, dynamic: true, inputs: ['text'], catalogInputs: ['text'], contextWindow: 128000, maxTokens: 32000, capacitySource: 'default' },
  ],
}

test('ModelCard is collapsed by default and expands to the checkbox list', async (t) => {
  const loaded = await loadModule(t)
  if (!loaded) return
  const { React, renderToString } = loaded
  const { ModelCard } = loaded.module.__test

  const collapsed = renderToString(React.createElement(ModelCard, {
    t: key => key, data: MODEL_DATA, sel: null, setSel: () => {}, busy: null, onSave: () => {},
  }))
  assert.ok(collapsed.includes('modelTitle'), 'collapsed card still shows the title')
  assert.ok(collapsed.includes('modelExpand'), 'collapsed card shows the expand toggle')
  assert.ok(!collapsed.includes('allModels'), 'collapsed card hides the master switch')
  assert.ok(!collapsed.includes('DeepSeek V4 Pro'), 'collapsed card hides the model list')

  const html = renderToString(React.createElement(ModelCard, {
    t: key => key, data: MODEL_DATA, sel: null, setSel: () => {}, busy: null, onSave: () => {}, defaultOpen: true,
  }))
  assert.ok(html.includes('modelCollapse'), 'expanded card shows the collapse toggle')
  assert.ok(html.includes('allModels'), 'renders the master all-models switch')
  assert.ok(html.includes('DeepSeek V4 Pro') && html.includes('glm-5.3'), 'lists the catalog models')
  assert.ok(html.includes('modelCount'), 'renders the enabled-count badge')
  assert.ok(html.includes('dynamicTag'), 'a fetched model is tagged dynamic')
  assert.ok(html.includes('capacityTitle'), 'offers the capacity editor')
})

test('ModelCard renders the master switch checked-all lock and the fetch action', async (t) => {
  const loaded = await loadModule(t)
  if (!loaded) return
  const { React, renderToString } = loaded
  const { ModelCard } = loaded.module.__test

  const allHtml = renderToString(React.createElement(ModelCard, {
    t: key => key, data: MODEL_DATA,
    sel: { mode: 'all', ids: ['deepseek-v4-pro', 'glm-5.3'] },
    setSel: () => {}, busy: null, onSave: () => {}, defaultOpen: true,
  }))
  assert.ok(allHtml.includes('disabled'), 'per-model checkboxes are locked in all-mode')

  const fetchHtml = renderToString(React.createElement(ModelCard, {
    t: key => key, data: MODEL_DATA, sel: null, setSel: () => {}, busy: null, onSave: () => {},
    onFetchModels: () => {}, defaultOpen: true,
  }))
  assert.ok(fetchHtml.includes('modelFetch'), 'renders the fetch-models button')
})

test('ModelCard reports image capability and declares only what the catalog does not', async (t) => {
  const loaded = await loadModule(t)
  if (!loaded) return
  const { React, renderToString } = loaded
  const { ModelCard, imageModelsPatch } = loaded.module.__test

  const availableModels = [
    // Shipped text-only row: the declaration has to come from the card.
    { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', enabled: true, dynamic: false, inputs: ['text', 'image'], catalogInputs: ['text'] },
    // Shipped vision row: the catalog owns the answer, so the box is locked.
    { id: 'kimi-k3', name: 'Kimi K3', enabled: false, dynamic: false, inputs: ['text', 'image'], catalogInputs: ['text', 'image'] },
    // Fetched row, still undeclared.
    { id: 'deepseek-flash', name: 'DeepSeek Flash', enabled: false, dynamic: true, inputs: ['text'], catalogInputs: ['text'] },
  ]
  const html = renderToString(React.createElement(ModelCard, {
    t: key => key,
    data: { modelMode: 'custom', modelCapacities: {}, availableModels },
    sel: { mode: 'custom', ids: ['deepseek-v4-pro'], images: ['deepseek-v4-pro', 'kimi-k3'] },
    setSel: () => {}, busy: null, onSave: () => {}, defaultOpen: true,
  }))
  assert.ok(html.includes('imageCapable'), 'the image column renders')
  assert.ok(html.includes('modelImageHint'), 'the column explains itself')
  assert.ok(html.includes('modelImageCount'), 'the badge reports image declarations')

  // The patch restates nothing the shipped catalog already answers.
  assert.deepEqual(imageModelsPatch(availableModels, ['deepseek-v4-pro', 'kimi-k3']), ['deepseek-v4-pro'])
  assert.deepEqual(imageModelsPatch(availableModels, ['deepseek-flash', 'kimi-k3']), ['deepseek-flash'])
  assert.deepEqual(imageModelsPatch(availableModels, []), [])
  // Card data from a host that predates the field declares nothing.
  assert.deepEqual(imageModelsPatch([{ id: 'deepseek-v4-pro' }], ['deepseek-v4-pro']), ['deepseek-v4-pro'])
})

test('capacity editing covers exactly the models this plugin owns', async (t) => {
  const loaded = await loadModule(t)
  if (!loaded) return
  const { capacityEditable, capacityDraft, buildCapacityPatch } = loaded.module.__test

  // A catalog-served descriptor owns its numbers; a fetched one does not.
  assert.equal(capacityEditable({ id: 'a', capacitySource: 'catalog' }), false)
  assert.equal(capacityEditable({ id: 'b', capacitySource: 'default' }), true)
  assert.equal(capacityEditable({ id: 'c', capacitySource: 'configured' }), true)
  assert.equal(capacityEditable({ id: 'd', capacitySource: null }), false)
  assert.equal(capacityEditable(null), false)

  const available = [
    { id: 'shipped', capacitySource: 'catalog', contextWindow: 1000000, maxTokens: 131072 },
    { id: 'fetched', capacitySource: 'default', contextWindow: 128000, maxTokens: 32000 },
    { id: 'corrected', capacitySource: 'configured', contextWindow: 200000, maxTokens: 64000 },
  ]

  // Drafts cover only the editable rows, seeded from the live numbers.
  assert.deepEqual(capacityDraft(available, {}), {
    fetched: { contextWindow: '128000', maxTokens: '32000' },
    corrected: { contextWindow: '200000', maxTokens: '64000' },
  })
  // An override in settings shows through instead of the effective value.
  assert.deepEqual(capacityDraft(available, { fetched: { contextWindow: 999, maxTokens: 111 } }), {
    fetched: { contextWindow: '999', maxTokens: '111' },
    corrected: { contextWindow: '200000', maxTokens: '64000' },
  })

  const tt = key => key
  // A save sends the WHOLE map: the host replaces the dict, so dropping an
  // unrelated row would silently un-correct it.
  const patch = buildCapacityPatch({ other: { contextWindow: 1, maxTokens: 2 } }, available, capacityDraft(available, {}), tt)
  assert.deepEqual(patch, {
    ok: true,
    value: {
      other: { contextWindow: 1, maxTokens: 2 },
      fetched: { contextWindow: 128000, maxTokens: 32000 },
      corrected: { contextWindow: 200000, maxTokens: 64000 },
    },
  })

  // Non-integers and non-positive numbers are refused with the field name.
  for (const bad of [
    { fetched: { contextWindow: '12.5', maxTokens: '1' } },
    { fetched: { contextWindow: '0', maxTokens: '1' } },
    { fetched: { contextWindow: '', maxTokens: '1' } },
    { fetched: { contextWindow: '128000', maxTokens: '-3' } },
  ]) {
    const refused = buildCapacityPatch({}, available, bad, tt)
    assert.equal(refused.ok, false, JSON.stringify(bad))
    assert.match(refused.error, /capacityInvalid: fetched/)
  }
})

/* ------------------------------------------------------------------ *
 * Free tier
 * ------------------------------------------------------------------ */

const FREE_DATA = {
  tier: 'free',
  route: 'opencode',
  baseURL: 'https://opencode.ai/zen/v1',
  exists: true,
  apiKeyEnv: 'OPENCODE_ZEN_KEY',
  configured: [
    { id: 'big-pickle', name: 'Big Pickle', contextWindow: 200000, maxTokens: 32000, input: ['text'] },
    { id: 'grok-code', name: 'Grok Code', contextWindow: 256000, maxTokens: 64000, input: ['text', 'image'] },
  ],
  live: ['big-pickle', 'grok-code', 'new-flash'],
  added: ['new-flash'],
  stale: [],
  revision: 7,
  error: null,
}

test('buildFreeTierEntries keeps configured values and adopts bare ids', async (t) => {
  const loaded = await loadModule(t)
  if (!loaded) return
  const { buildFreeTierEntries } = loaded.module.__test

  // Only the configured rows are sent, with their own names and capacities.
  assert.deepEqual(buildFreeTierEntries(FREE_DATA.configured, ['big-pickle']), [
    { id: 'big-pickle', name: 'Big Pickle', contextWindow: 200000, maxTokens: 32000, input: ['text'] },
  ])
  // An adopted id rides as a bare { id } and lets the host fill defaults in.
  assert.deepEqual(buildFreeTierEntries(FREE_DATA.configured, ['big-pickle', 'new-flash']), [
    { id: 'big-pickle', name: 'Big Pickle', contextWindow: 200000, maxTokens: 32000, input: ['text'] },
    { id: 'new-flash' },
  ])
  // Order follows the configured list first, then the adoptions in selection order.
  assert.deepEqual(buildFreeTierEntries(FREE_DATA.configured, ['new-flash', 'grok-code']).map(e => e.id), ['grok-code', 'new-flash'])
  assert.deepEqual(buildFreeTierEntries(FREE_DATA.configured, []), [])
  // A configured row that lost its modalities falls back to text.
  assert.deepEqual(buildFreeTierEntries([{ id: 'x', input: [] }], ['x']), [
    { id: 'x', name: 'x', contextWindow: undefined, maxTokens: undefined, input: ['text'] },
  ])
})

test('FreeTierCard lists both sources and refuses an empty write', async (t) => {
  const loaded = await loadModule(t)
  if (!loaded) return
  const { React, renderToString } = loaded
  const { FreeTierCard } = loaded.module.__test

  const html = renderToString(React.createElement(FreeTierCard, {
    t: key => key, data: FREE_DATA, sel: null, setSel: () => {}, busy: null,
    onApply: () => {}, onFetch: () => {}, fetching: false,
  }))
  assert.ok(html.includes('Big Pickle'), 'lists a configured model')
  assert.ok(html.includes('new-flash'), 'lists an online model that is not configured')
  assert.ok(html.includes('freeAdded'), 'reports the adoptable count')
  assert.ok(html.includes('freeRevision'), 'shows the settings revision')
  assert.ok(html.includes('imageCapable'), 'marks the configured image modality')

  // The empty selection is refused before it reaches the host, because
  // putFreeTierModels rejects an empty list outright.
  const calls = []
  const tree = FreeTierCard({
    t: key => key, data: FREE_DATA, sel: [], setSel: () => {}, busy: null,
    onApply: (entries, invalidMessage) => calls.push({ entries, invalidMessage }),
  })
  const applyButton = buttonWith(tree, 'freeApply')
  assert.ok(applyButton, 'the apply button renders')
  applyButton.props.onClick()
  assert.deepEqual(calls, [{ entries: null, invalidMessage: 'freeNothing' }])

  // With a selection, the button sends the full entry list and the host fills
  // the adopted row's capacities in.
  calls.length = 0
  const okTree = FreeTierCard({
    t: key => key, data: FREE_DATA, sel: ['big-pickle', 'new-flash'], setSel: () => {}, busy: null,
    onApply: (entries, invalidMessage) => calls.push({ entries, invalidMessage }),
  })
  buttonWith(okTree, 'freeApply').props.onClick()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].invalidMessage, null)
  assert.deepEqual(calls[0].entries, [
    { id: 'big-pickle', name: 'Big Pickle', contextWindow: 200000, maxTokens: 32000, input: ['text'] },
    { id: 'new-flash' },
  ])
})

test('FreeTierCard surfaces a missing route, a read error, and delisted rows', async (t) => {
  const loaded = await loadModule(t)
  if (!loaded) return
  const { React, renderToString } = loaded
  const { FreeTierCard } = loaded.module.__test
  const render = data => renderToString(React.createElement(FreeTierCard, {
    t: key => key, data, sel: null, setSel: () => {}, busy: null, onApply: () => {},
  }))

  assert.ok(render({ ...FREE_DATA, exists: false, configured: [], live: [] }).includes('freeMissing'))
  assert.ok(render({ ...FREE_DATA, error: 'BOOM' }).includes('BOOM'))
  const delisted = render({ ...FREE_DATA, live: ['big-pickle'], stale: ['grok-code'] })
  assert.ok(delisted.includes('freeDelistedHint'), 'warns about delisted but configured models')
  assert.ok(delisted.includes('freeStale'), 'tags the delisted row')
  assert.ok(render({ ...FREE_DATA, configured: [], live: [] }).includes('freeEmpty'))
})

/* ------------------------------------------------------------------ *
 * Session headers
 * ------------------------------------------------------------------ */

const SESSION_DATA = {
  enabled: true,
  providers: ['opencode', 'opencode-go'],
  hosts: ['opencode.ai'],
  baseURLs: [],
  headers: ['x-opencode-session', 'x-session-affinity', 'x-client-request-id', 'x-session-id'],
  extraHeaders: { 'x-opencode-client': 'native' },
  userAgent: '',
  nanoidSessionId: true,
  nanoidLength: 8,
  nanoidAlphabet: 'alphanumeric',
  seedSessionId: false,
  verbose: true,
  injected: 2,
  recent: [
    { at: new Date('2026-09-14T08:00:00Z').toISOString(), url: 'https://opencode.ai/zen/go/v1/chat/completions', headers: ['x-opencode-session'], sessionId: 'sess-1', token: 'AbC123xy', error: null },
    { at: new Date('2026-09-14T08:00:01Z').toISOString(), url: 'https://opencode.ai/zen/v1/models', headers: [], sessionId: 'sess-1', token: 'AbC123xy', error: 'boom' },
  ],
}

test('the session card renders the controls, the counters and the diagnostics table', async (t) => {
  const loaded = await loadModule(t)
  if (!loaded) return
  const { React, renderToString } = loaded
  const { SessionCard } = loaded.module.__test

  const html = renderToString(React.createElement(SessionCard, {
    t: key => key, session: SESSION_DATA, form: null, setForm: () => {}, busy: null,
    onSave: () => {}, onClear: () => {}, notice: null,
  }))
  assert.ok(html.includes('sessionEnabled'), 'renders the master switch')
  assert.ok(html.includes('sessionNanoid'), 'renders the nanoid toggle')
  assert.ok(html.includes('sessionSeed'), 'renders the seed toggle')
  assert.ok(html.includes('sessionVerbose'), 'renders the verbose toggle')
  assert.ok(html.includes('x-opencode-session, x-session-affinity'), 'shows the header list')
  assert.ok(html.includes('x-opencode-client: native'), 'shows the extra fixed headers')
  assert.ok(html.includes('AbC123xy'), 'shows the sent digest rather than the session id alone')
  assert.ok(html.includes('sess-1'), 'shows the session id')
  assert.ok(html.includes('boom'), 'shows a per-injection error')
  assert.ok(html.includes('sessionInjected'), 'shows the injection counter')
  assert.ok(html.includes('sessionClear'), 'offers the log clear')

  // Disabled: the whole body collapses to the explanatory line, so a
  // switched-off injector cannot look half-configured.
  const off = renderToString(React.createElement(SessionCard, {
    t: key => key, session: { ...SESSION_DATA, enabled: false }, form: null, setForm: () => {}, busy: null,
    onSave: () => {}, onClear: () => {}, notice: null,
  }))
  assert.ok(off.includes('sessionDisabledHint'), 'explains the disabled state')
  assert.ok(!off.includes('sessionNanoid'), 'hides the controls while disabled')
})

test('the session form refuses a bad digest length and a bad extra-header line', async (t) => {
  const loaded = await loadModule(t)
  if (!loaded) return
  const { React } = loaded
  const { SessionCard } = loaded.module.__test

  const save = (form) => {
    const calls = []
    const tree = SessionCard({
      t: key => key, session: SESSION_DATA, form, setForm: () => {}, busy: null,
      onSave: (patch, invalidMessage) => calls.push({ patch, invalidMessage }), onClear: () => {},
    })
    tree.props.children // touch nothing; find the save button by walking
    const button = buttonWith(tree, 'save')
    assert.ok(button, 'the save button renders')
    button.props.onClick()
    return calls
  }

  const base = {
    enabled: true,
    nanoidSessionId: true,
    seedSessionId: false,
    verbose: false,
    nanoidLength: '8',
    nanoidAlphabet: 'alphanumeric',
    providers: 'opencode, opencode-go',
    hosts: 'opencode.ai',
    headers: 'x-opencode-session, x-session-id',
    extraHeaders: '',
    userAgent: '',
  }

  // A digest length outside 4..32 never reaches the host.
  let calls = save({ ...base, nanoidLength: '99' })
  assert.deepEqual(calls, [{ patch: null, invalidMessage: 'sessionLengthInvalid' }])
  calls = save({ ...base, nanoidLength: '8.5' })
  assert.equal(calls[0].invalidMessage, 'sessionLengthInvalid')

  // A typo'd extra header line is refused rather than silently dropped.
  calls = save({ ...base, extraHeaders: 'x-opencode-client native' })
  assert.deepEqual(calls, [{ patch: null, invalidMessage: 'sessionExtraInvalid' }])

  // A clean form produces a fully normalized patch.
  calls = save({ ...base, extraHeaders: 'x-opencode-client: native\n# comment\nx-trace: abc' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].invalidMessage, null)
  assert.deepEqual(calls[0].patch, {
    enabled: true,
    nanoidSessionId: true,
    seedSessionId: false,
    verbose: false,
    nanoidLength: 8,
    nanoidAlphabet: 'alphanumeric',
    providers: ['opencode', 'opencode-go'],
    hosts: ['opencode.ai'],
    headers: ['x-opencode-session', 'x-session-id'],
    extraHeaders: { 'x-opencode-client': 'native', 'x-trace': 'abc' },
    userAgent: '',
  })

  // An emptied list falls back to the documented default rather than sending
  // `[]`, which the host would read as "match nothing".
  calls = save({ ...base, providers: '  ', hosts: '' })
  assert.deepEqual(calls[0].patch.providers, ['opencode', 'opencode-go'])
  assert.deepEqual(calls[0].patch.hosts, ['opencode.ai'])

  assert.ok(React, 'react is loaded')
})

test('list and header text helpers round-trip and reject junk', async (t) => {
  const loaded = await loadModule(t)
  if (!loaded) return
  const { parseList, formatList, parseHeaderLines, formatHeaderLines } = loaded.module.__test

  assert.deepEqual(parseList('a, b  c,d'), ['a', 'b', 'c', 'd'])
  assert.deepEqual(parseList('a, a, b'), ['a', 'b'], 'de-duplicates')
  assert.deepEqual(parseList('   '), [])
  assert.deepEqual(parseList(undefined), [])
  assert.deepEqual(parseList(null), [])
  assert.equal(formatList(['a', 'b']), 'a, b')
  assert.equal(formatList(undefined), '')

  assert.deepEqual(parseHeaderLines('a: 1\nb:2\n\n# note\nno-colon'), { a: '1', b: '2' })
  assert.deepEqual(parseHeaderLines(''), {})
  assert.deepEqual(parseHeaderLines('   : value'), {}, 'a blank name is dropped')
  assert.deepEqual(parseHeaderLines(':value'), {})
  assert.equal(formatHeaderLines({ a: '1', b: '2' }), 'a: 1\nb: 2')
  assert.equal(formatHeaderLines(undefined), '')

  // Round-trip: text → map → text preserves every pair.
  const text = 'x-opencode-client: native\nx-trace: abc'
  assert.equal(formatHeaderLines(parseHeaderLines(text)), text)
})

test('switch reasons and formatting stay localized', async (t) => {
  const loaded = await loadModule(t)
  if (!loaded) return
  const { switchReasonText, fmtNumber, fmtReset, barColor, usageErrorText } = loaded.module.__test
  const tr = key => key

  assert.equal(switchReasonText('quota', tr), 'switchQuota')
  assert.equal(switchReasonText('invalid', tr), 'switchInvalid')
  assert.equal(switchReasonText('consecutive', tr), 'switchConsecutive')
  assert.equal(switchReasonText('whatever', tr), 'switchManual')

  assert.equal(fmtNumber(128000), '128k')
  assert.equal(fmtNumber(1000000), '1M')
  assert.equal(fmtNumber(999), '999')
  assert.equal(fmtNumber(null), '—')
  assert.equal(fmtNumber(undefined), '—')

  assert.equal(fmtReset(null, tr, Date.now()), 'unknown')
  assert.equal(fmtReset('not-a-date', tr, Date.now()), 'not-a-date')
  assert.equal(fmtReset(new Date(Date.now() - 1000).toISOString(), tr, Date.now()), 'unknown')
  const future = new Date(Date.now() + 45 * 60000 + 10000).toISOString()
  assert.equal(fmtReset(future, tr, Date.now()), '45m')

  assert.equal(barColor(0), 'var(--dsw-alias-state-business-primary)')
  assert.equal(barColor(95), '#d97706')
  assert.equal(barColor(100), 'var(--dsw-alias-state-error-primary)')

  assert.equal(usageErrorText('no-api-key', tr), 'noApiKey')
  assert.equal(usageErrorText('unauthorized', tr), 'unauthorized')
  assert.equal(usageErrorText('network', tr), 'network')
  assert.equal(usageErrorText('bad-json', tr), 'badJson')
  assert.equal(usageErrorText('http-429', tr), 'httpError')
  assert.equal(usageErrorText('mystery', tr), 'unknown')
})

/* ------------------------------------------------------------------ *
 * Composer dock
 * ------------------------------------------------------------------ */

const DOCK_STATE = (over) => ({ news: null, usage: null, error: null, suppressed: 0, ...over })

function dockPills(react, loaded, state, extra = {}) {
  const { React, renderToString } = react
  const { DockPills: Component } = loaded.module.__test
  return renderToString(React.createElement(Component, {
    t: key => key,
    useDockState: selector => (selector ? selector(state) : state),
    dismissNews: () => {},
    ...extra,
  }))
}

test('the dock shows a new-model nudge only while something is unseen', async (t) => {
  const react = await loadReact(t)
  const loaded = await loadModule(t)
  if (!loaded || react === null) return

  const fresh = dockPills(react, loaded, DOCK_STATE({ news: { pendingTotal: 3, tiers: {} } }))
  assert.ok(fresh.includes('dockNews'), 'an unseen notice renders the pill')
  assert.ok(fresh.includes('>3<') || fresh.includes('3'), 'the pill carries the count')

  const seen = dockPills(react, loaded, DOCK_STATE({ news: { pendingTotal: 3, tiers: {} }, suppressed: 3 }))
  assert.ok(!seen.includes('dockNews'), 'a dismissed nudge stays hidden')

  const none = dockPills(react, loaded, DOCK_STATE({ news: { pendingTotal: 3, tiers: {} }, suppressed: 1 }))
  assert.ok(none.includes('dockNews'), 'one dismissed id still leaves two unseen')
  assert.ok(!none.includes('>3<'), 'and it counts only what is left')
})

test('the dock shows today\'s tokens with its source, and nothing before the first call', async (t) => {
  const react = await loadReact(t)
  const loaded = await loadModule(t)
  if (!loaded || react === null) return

  const used = dockPills(react, loaded, DOCK_STATE({ usage: { tokens: 53250, calls: 120, source: 'live' } }))
  assert.ok(used.includes('dockUsage'), 'the usage pill renders')
  assert.ok(used.includes('dockSourceLive'), 'and names where the numbers come from')
  assert.ok(!used.includes('dockSourceLog'), 'the live source is not labelled as the log')

  const fromLog = dockPills(react, loaded, DOCK_STATE({ usage: { tokens: 900, calls: 4, source: 'log' } }))
  assert.ok(fromLog.includes('dockSourceLog'), 'the log source is labelled as such')

  const empty = dockPills(react, loaded, DOCK_STATE({ usage: { tokens: 0, calls: 0, source: 'live' } }))
  assert.ok(!empty.includes('dockUsage'), 'a day with no calls shows no number')

  const unknown = dockPills(react, loaded, DOCK_STATE({ error: 'boom' }))
  assert.ok(unknown.includes('dockFailed'), 'a failed read says so instead of going blank')
})

test('the dock source keeps one snapshot reference until a fact moves', async (t) => {
  const loaded = await loadModule(t)
  if (!loaded) return
  const source = loaded.module.__test.createDockState()
  const before = source.getSnapshot()
  assert.equal(source.getSnapshot(), before, 'a fresh source answers the same object')

  const seen = []
  const off = source.subscribe(() => seen.push(source.getSnapshot()))
  source.patch({ news: { pendingTotal: 1, tiers: {} } })
  assert.equal(seen.length, 1, 'a patch notifies once')
  assert.notEqual(source.getSnapshot(), before, 'and publishes a new snapshot')
  assert.equal(seen[0].news.pendingTotal, 1)

  source.patch({ usage: { tokens: 5, calls: 1, source: 'live' } })
  assert.equal(seen.length, 2)
  assert.equal(seen[1].news.pendingTotal, 1, 'the other fact survives the next patch')

  off()
  source.patch({ error: 'x' })
  assert.equal(seen.length, 2, 'unsubscribing stops the notifications')
})

test('the dock registers into the composer slot behind the stats pills', async (t) => {
  const loaded = await loadModule(t)
  if (!loaded) return
  const registered = []
  const remote = {
    calls: [],
    status: async () => ({ modelWatch: { pendingTotal: 2, tiers: {} } }),
    usageBreakdown: async days => {
      remote.calls.push(['usageBreakdown', days])
      return { enabled: true, source: 'live', days: [{ date: '2026-09-26', total: 4000, calls: 3 }] }
    },
    dismissModelNews: async tier => { remote.calls.push(['dismissModelNews', tier]); return 0 },
  }
  loaded.module.apply({
    remote: { $mount: async () => {} },
    effect: fn => { fn(); return () => {} },
    locale: { register: () => () => {}, bind: () => key => key },
    slots: {
      register: (opts) => { registered.push(opts); return () => {} },
      inject: (_name, factory) => { factory() },
    },
    get: key => (key === 'remote.opencodeSuite' ? remote : null),
  })
  const dock = registered.find(entry => entry.name === 'conversation.composer.dock')
  assert.ok(dock, 'the composer dock is a registered extension position')
  assert.equal(dock.id, 'model-news')
  assert.ok(dock.order > 0, 'it renders after the stats pills, not before them')
  assert.equal(dock.locale, 'settings.opencodeSuite', 'its copy comes from this plugin\'s dictionary')

  const injected = dock.inject()
  assert.equal(typeof injected.hooks.dockState.getSnapshot, 'function', 'the live facts arrive as a bare observable')
  assert.equal(typeof injected.hooks.dockState.subscribe, 'function')
  assert.equal(typeof injected.dismissNews, 'function', 'the nudge is dismissed by callback, not by the component fetching')

  // The one behaviour the dock owns: dismissing hides the nudge HERE and must
  // leave the host's pending list alone, because that list is the work list the
  // settings card acts on.
  await new Promise(resolve => setImmediate(resolve))
  const source = injected.hooks.dockState
  assert.equal(source.getSnapshot().news.pendingTotal, 2, 'the poller filled the news fact')
  assert.equal(source.getSnapshot().usage.tokens, 4000, 'and the today total')
  injected.dismissNews()
  assert.equal(source.getSnapshot().suppressed, 2, 'the nudge is now seen')
  // Let any async work the callback started land before reading the call log:
  // a dismiss that quietly called the host would do it after this tick.
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.deepEqual(remote.calls.filter(call => call[0] === 'dismissModelNews'), [],
    'and the host was never told to clear its work list')
})

test('the IM row offers the discovered targets and explains an empty one', async (t) => {
  const react = await loadReact(t)
  const loaded = await loadModule(t)
  if (!loaded || react === null) return
  const { React, renderToString } = react
  const { ImNotifyRow: Row } = loaded.module.__test
  const render = props => renderToString(React.createElement(Row, {
    t: key => key, busy: null, testing: false, onPick: () => {}, onTest: () => {},
    ...props,
  }))
  const config = { enabled: false, botId: '', targetId: '' }

  const ready = render({
    config: { ...config, botId: 'bot_1', targetId: 'release-alerts' },
    report: {
      available: true,
      reason: null,
      bots: [{ botId: 'bot_1', channel: 'telegram', targets: [{ targetId: 'release-alerts', name: '发布提醒', kind: 'chat' }] }],
    },
  })
  assert.ok(ready.includes('imTest'), 'a configured target offers the test button')
  // The placeholder is always in the list, so the honest question is which
  // option the select actually shows: the chosen target, or the placeholder.
  assert.match(ready, /<option value="release-alerts" selected/,
    'a chosen target is the selected option')
  assert.ok(!/<option value="" selected/.test(ready), 'not the placeholder')

  // The regression: an unconfigured row must not LOOK configured. Falling back
  // to the first bot filled the dropdown, so a user who only pressed the test
  // button was told no bot was chosen.
  const unconfigured = render({
    config,
    report: {
      available: true,
      reason: null,
      bots: [{ botId: 'bot_1', channel: 'telegram', targets: [{ targetId: 'release-alerts', name: '发布提醒', kind: 'chat' }] }],
    },
  })
  assert.match(unconfigured, /<option value="" selected/,
    'nothing chosen shows the placeholder as the selected option')
  // ONE bot must still be selectable: the regression that made this row
  // unusable rendered the bot dropdown only when there were two or more, and
  // captioned a single bot as "no bot" while one was listed.
  const oneBot = {
    available: true,
    reason: null,
    bots: [{ botId: 'bot_1', channel: 'weixin', targets: [{ targetId: 'release-alerts', name: 'Ops', kind: 'chat' }] }],
  }
  const single = unconfigured.replace('', '')
  assert.ok(!/imNone/.test(single), 'a single bot is never captioned as none')
  assert.match(single, /<option value="bot_1"/,
    'a single bot is offered in the bot dropdown')
  assert.match(render({ config, report: oneBot }), /<option value="bot_1"/,
    'one bot, nothing chosen: the bot is still selectable')

  // A bot that was removed upstream must not resurrect a stale selection either.
  const stale = render({
    config: { ...config, botId: 'bot_gone', targetId: 'whatever' },
    report: {
      available: true,
      reason: null,
      bots: [{ botId: 'bot_1', channel: 'telegram', targets: [{ targetId: 'release-alerts', name: '发布提醒', kind: 'chat' }] }],
    },
  })
  assert.match(stale, /<option value="" selected/,
    'a bot that no longer exists reads as unchosen, not as a stale selection')

  // Two bots are needed for the bot dropdown to render at all; with one, the row
  // shows a caption instead and a silent fallback to that bot cannot be seen.
  const twoBots = {
    available: true,
    reason: null,
    bots: [
      { botId: 'bot_1', channel: 'telegram', targets: [{ targetId: 't1', name: 'T1', kind: 'chat' }] },
      { botId: 'bot_2', channel: 'slack', targets: [{ targetId: 't2', name: 'T2', kind: 'chat' }] },
    ],
  }
  // Both dropdowns carry a placeholder, so "a placeholder is selected" says
  // nothing on its own; what must not happen is a REAL bot looking selected.
  assert.ok(!/<option value="bot_[0-9a-z]+" selected/.test(render({ config, report: twoBots })),
    'two bots, nothing chosen: no real bot is shown as selected')
  assert.match(render({ config: { ...config, botId: 'bot_2', targetId: 't2' }, report: twoBots }),
    /<option value="bot_2" selected/,
    'two bots, bot_2 chosen: bot_2 is the selected bot')

  const empty = render({ config, report: { available: true, reason: 'no bot', bots: [] } })
  assert.ok(empty.includes('no bot'), 'the reason is shown instead of an empty picker')
  assert.ok(!empty.includes('imTest'), 'and there is nothing to test')

  const absent = render({ config, report: { available: false, reason: 'dsh-im is not enabled', bots: [] } })
  assert.ok(absent.includes('dsh-im is not enabled'), 'a missing plugin reads as missing, not as empty')

  const chain = 'delivery-failed \u2190 send-rejected: Weixin text delivery failed (http=2xx) \u2190 send-rejected: \u5fae\u4fe1\u670d\u52a1\u62d2\u7edd\u4e86\u56de\u590d\u6d88\u606f\u3002'
  const failed = render({
    config,
    report: { available: true, reason: null, bots: [{ botId: 'bot_1', channel: 'telegram', targets: [{ targetId: 't', name: 'T', kind: 'chat' }] }] },
    lastResult: { sent: false, error: chain },
  })
  // The identity `t` returns the key, so the failure row is asserted by its key
  // and the split by the channel's own sentence appearing without the codes.
  assert.ok(failed.includes('imFailed'), 'a refused send renders its failure row on the card')
  assert.ok(!failed.includes('imSent'), 'and is never dressed up as sent')
  assert.ok(failed.includes('\u5fae\u4fe1\u670d\u52a1\u62d2\u7edd\u4e86\u56de\u590d\u6d88\u606f'), 'the channel sentence is the headline')
  assert.ok(failed.includes('send-rejected: Weixin text delivery failed'), 'the codes stay as detail')
  assert.ok(!/imFailed[^<]*<\/p><\/div><div[^>]*>.{0,40}delivery-failed/.test(failed),
    'the public code is not the sentence the person reads first')
})
