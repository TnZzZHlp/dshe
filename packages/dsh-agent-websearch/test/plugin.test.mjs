import { test } from 'node:test'
import assert from 'node:assert/strict'

import { apply, inject, name } from '../index.js'
import { providers as builtinProviders, default as defaultProviders } from '../providers/index.js'
import { AGY_PROVIDER_ID } from '../providers/agy.js'

function makeContext() {
  const searchProviders = []
  const registeredTools = []
  const effects = []
  return {
    searchProviders,
    registeredTools,
    effects,
    web: {
      registerSearchProvider(provider) {
        searchProviders.push(provider)
        return () => {
          const index = searchProviders.indexOf(provider)
          if (index >= 0) searchProviders.splice(index, 1)
        }
      },
    },
    tools: {
      register(definition) {
        registeredTools.push(definition)
        return () => {
          const index = registeredTools.indexOf(definition)
          if (index >= 0) registeredTools.splice(index, 1)
        }
      },
    },
    effect(factory, label) {
      const iterator = factory()
      const first = iterator.next()
      assert.equal(first.done, false)
      effects.push({ label, cleanup: first.value })
      return () => {
        iterator.return?.()
      }
    },
  }
}

test('plugin metadata matches the bundle', () => {
  assert.equal(name, 'dsh-agent-websearch')
  assert.deepEqual(inject, ['web', 'tools'])
})

test('provider registry validates built-in provider definitions', () => {
  assert.equal(builtinProviders, defaultProviders)
  assert.equal(builtinProviders.length, 1)
  assert.equal(builtinProviders[0].id, AGY_PROVIDER_ID)
})

test('registers one web search provider per enabled provider and one tool', () => {
  const ctx = makeContext()
  apply(ctx, {})

  assert.equal(ctx.searchProviders.length, 1)
  const provider = ctx.searchProviders[0]
  assert.equal(provider.id, 'agy')
  assert.equal(provider.title, 'agy (local CLI)')
  assert.equal(provider.description.en.length > 0, true)
  assert.equal(provider.description.zh.length > 0, true)
  assert.equal(typeof provider.available, 'function')
  assert.equal(typeof provider.ready, 'function')
  assert.equal(typeof provider.search, 'function')
  assert.equal(typeof provider.available(), 'boolean')

  assert.equal(ctx.registeredTools.length, 1)
  assert.equal(ctx.registeredTools[0].name, 'agent_web_search')
  assert.deepEqual(ctx.registeredTools[0].parameters.properties.provider.enum, ['agy'])
  assert.ok(ctx.registeredTools[0].timeoutMs >= 120_000)

  assert.equal(ctx.effects.length, 1)
  assert.equal(ctx.effects[0].label, 'dsh-agent-websearch provider cleanup')
  assert.equal(typeof ctx.effects[0].cleanup, 'function')
  ctx.effects[0].cleanup()
})

test('defaults the config argument to an empty object', () => {
  const ctx = makeContext()
  apply(ctx)
  assert.equal(ctx.searchProviders.length, 1)
})

test('rejects a web search request without a query before touching agy', async () => {
  const ctx = makeContext()
  apply(ctx, {})
  const provider = ctx.searchProviders[0]
  await assert.rejects(provider.search({}, undefined), /web search provider "agy" received an empty query/)
  await assert.rejects(provider.search({ query: '   ' }, undefined), /web search provider "agy" received an empty query/)
  await assert.rejects(provider.search('query', undefined), /received an empty query/)
})

test('registers nothing when every provider is disabled', () => {
  const ctx = makeContext()
  assert.throws(
    () => apply(ctx, { providers: { agy: { enabled: false } } }),
    /no web search providers are enabled; enable at least one provider in config\.providers/,
  )
  assert.equal(ctx.searchProviders.length, 0)
  assert.equal(ctx.registeredTools.length, 0)
  assert.equal(ctx.effects.length, 0)
})

test('registers nothing when the config is invalid', () => {
  const ctx = makeContext()
  assert.throws(() => apply(ctx, { tool: { maxResults: 0 } }), /config\.tool\.maxResults must be an integer between 1 and 10/)
  assert.equal(ctx.searchProviders.length, 0)
  assert.equal(ctx.registeredTools.length, 0)

  const unknown = makeContext()
  assert.throws(() => apply(unknown, { nope: true }), /config has unknown key "nope"/)
  assert.equal(unknown.searchProviders.length, 0)
})

test('skips provider disposal effects when the provider has no dispose', () => {
  const ctx = makeContext()
  apply(ctx, {})
  assert.equal(ctx.effects.length, 1)
})
