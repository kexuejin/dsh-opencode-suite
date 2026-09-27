import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { TYPERT } from '../typert.host.js'

/**
 * The page's calling convention is part of the contract, and nothing else in
 * this package can see it: the smoke tests call the SERVICE (`suite.method(...)`),
 * where an object argument is exactly right, and `renderToString` never runs the
 * effects that would call the remote at all. A wrong convention therefore passes
 * the whole suite and only fails in the browser, as
 * `wire field "days" failed boundary validation`.
 *
 * So this reads the page's own call sites and checks each one against the host
 * descriptor: the client binder maps call arguments onto the declared wire
 * fields IN ORDER, which makes a scalar parameter that receives an object literal
 * a wire-level bug. There is no browser test environment in this package (no
 * jsdom, and adding one for this is not worth a dev dependency), so the source
 * is the surface under test.
 */

const here = dirname(fileURLToPath(import.meta.url))
const CLIENT_SOURCE = readFileSync(join(here, '..', 'client.js'), 'utf8')

/** Every `remote.<method>(` call site with its balanced argument list. */
function callSites() {
  const sites = []
  const pattern = /\bremote\.([A-Za-z][A-Za-z0-9]*)\(/g
  for (const match of CLIENT_SOURCE.matchAll(pattern)) {
    const open = match.index + match[0].length
    let depth = 1
    let index = open
    for (; index < CLIENT_SOURCE.length && depth > 0; index += 1) {
      const char = CLIENT_SOURCE[index]
      if (char === '(' || char === '{' || char === '[') depth += 1
      else if (char === ')' || char === '}' || char === ']') depth -= 1
    }
    sites.push({ method: match[1], args: CLIENT_SOURCE.slice(open, index - 1) })
  }
  return sites
}

/** Split an argument list on top-level commas. */
function splitArgs(text) {
  const args = []
  let depth = 0
  let current = ''
  for (const char of text) {
    if ('({['.includes(char)) depth += 1
    else if (')}]'.includes(char)) depth -= 1
    if (char === ',' && depth === 0) {
      args.push(current)
      current = ''
      continue
    }
    current += char
  }
  if (current.trim().length > 0) args.push(current)
  return args.map(arg => arg.trim())
}

/** Whether the host codec for a parameter takes a plain number. */
function takesNumber(codec) {
  const schema = typeof codec?.create === 'function' ? codec.create() : codec?.schema
  if (schema === undefined || schema === null) return false
  const def = schema._zod?.def ?? schema.def
  if (def === undefined) return false
  if (def.type === 'optional' || def.type === 'nullish') return takesNumber({ schema: def.innerType })
  return def.type === 'number'
}

test('the page passes exactly as many arguments as the client descriptor declares', () => {
  const declared = new Map(TYPERT.invocations.map(inv => [inv.method, inv.parameters]))
  const sites = callSites()
  assert.ok(sites.length >= 10, `the page calls the remote in ${sites.length} places`)
  for (const site of sites) {
    const parameters = declared.get(site.method)
    if (parameters === undefined) continue
    const args = splitArgs(site.args)
    // The CLIENT binder counts call arguments against this descriptor and
    // refuses a short call — the host's acceptsUndefined relaxes the gateway
    // only, so a short call fails in the browser with "expected N argument(s),
    // got M" no matter what the host manifest says.
    assert.equal(args.length, parameters.length,
      `remote.${site.method}() passes ${args.length} argument(s) but the client descriptor declares`
      + ` ${parameters.length} — the client binder requires all of them`)
  }
})

test('a scalar parameter never receives an object literal', () => {
  const declared = new Map(TYPERT.invocations.map(inv => [inv.method, inv]))
  for (const site of callSites()) {
    const invocation = declared.get(site.method)
    if (invocation === undefined) continue
    const args = splitArgs(site.args)
    args.forEach((arg, index) => {
      const parameter = invocation.parameters[index]
      if (parameter === undefined || !takesNumber(parameter.codec)) return
      assert.ok(!arg.startsWith('{'),
        `remote.${site.method}() passes an object to the "${parameter.name}" wire field,`
        + ' which the host validates as a number — the object would arrive as the VALUE')
    })
  }
})

/**
 * The field names of an object literal, at any nesting depth so a
 * conditional spread (`...(x ? {} : { field: v })`) still reports its field.
 * What keeps a ternary branch from being read as a field is the preceding
 * character: a field name always follows `{` or `,`, while `? false : value`
 * puts the branch right after `?`.
 */
function objectKeys(text) {
  const keys = new Set()
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (char !== '{' && char !== ',') continue
    const rest = text.slice(index + 1)
    const match = /^\s*\.\.\.([A-Za-z][A-Za-z0-9]*)/.exec(rest)
    if (match !== null) { keys.add(match[1]); continue }
    const named = /^\s*([A-Za-z][A-Za-z0-9]*)\s*:/.exec(rest)
    if (named !== null) keys.add(named[1])
  }
  return keys
}

test('every Config field the card writes survives the wire codec', () => {
  // The card sends putConfig patches as object literals, so the call sites are
  // the field list. A strict codec strips what it does not declare, and a field
  // missing from BOTH the codec and the service's own filter used to fail at
  // click time with "putConfig received no known fields" while its Config field
  // existed all along.
  const invocation = TYPERT.invocations.find(inv => inv.method === 'putConfig')
  const codec = invocation.parameters.find(parameter => parameter.name === 'config').codec.create()
  const shape = codec.shape ?? codec._zod?.def?.shape
  assert.ok(shape !== undefined, 'the config codec exposes its fields')

  const writes = callSites().filter(site => site.method === 'putConfig')
  assert.ok(writes.length >= 3, `the page writes config in ${writes.length} places`)
  const declared = new Set(Object.keys(shape))
  for (const write of writes) {
    for (const key of objectKeys(write.args)) {
      assert.ok(declared.has(key),
        `the card writes putConfig.${key}, which the wire codec does not declare — it would be stripped`
        + ' before the service ever saw it')
    }
  }
})
