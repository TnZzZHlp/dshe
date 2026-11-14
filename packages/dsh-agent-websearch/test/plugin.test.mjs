import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'

import { apply, inject, name } from '../index.js'
import { providers as builtinProviders, default as defaultProviders } from '../providers/index.js'
import { AGY_PROVIDER_ID } from '../providers/agy.js'

async function makeContext(t) {
  const searchProviders = []
  const registeredTools = []
  const root = new Context()
  t.after(() => root.fiber.dispose())
  root.provide('web', {
    registerSearchProvider(provider) {
      searchProviders.push(provider)
      return () => {
        const index = searchProviders.indexOf(provider)
        if (index >= 0) searchProviders.splice(index, 1)
      }
    },
  })
  root.provide('tools', {
    register(definition) {
      registeredTools.push(definition)
      return () => {
        const index = registeredTools.indexOf(definition)
        if (index >= 0) registeredTools.splice(index, 1)
      }
    },
  })
  await root.plugin(TypertRegistry)
  return {
    searchProviders,
    registeredTools,
    async apply(config) {
      return root.plugin(Object.assign(ctx => apply(ctx, config), { inject }))
    },
  }
}

test('plugin metadata matches the bundle', () => {
  assert.equal(name, 'dsh-agent-websearch')
  assert.deepEqual(inject, ['web', 'tools', 'typert'])
})

test('provider registry validates built-in provider definitions', () => {
  assert.equal(builtinProviders, defaultProviders)
  assert.equal(builtinProviders.length, 1)
  assert.equal(builtinProviders[0].id, AGY_PROVIDER_ID)
})

test('registers search providers and tools', async (t) => {
  const ctx = await makeContext(t)
  await ctx.apply({})

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

  assert.equal(ctx.registeredTools.length, 2)
  assert.equal(ctx.registeredTools[1].name, 'agy_list_models')
  assert.equal(ctx.registeredTools[0].name, 'agent_web_search')
  assert.deepEqual(ctx.registeredTools[0].parameters.properties.provider.enum, ['agy'])
  assert.ok(ctx.registeredTools[0].timeoutMs >= 120_000)
})

test('defaults the config argument to an empty object', async (t) => {
  const ctx = await makeContext(t)
  await ctx.apply()
  assert.equal(ctx.searchProviders.length, 1)
})

test('rejects a web search request without a query before touching agy', async (t) => {
  const ctx = await makeContext(t)
  await ctx.apply({})
  const provider = ctx.searchProviders[0]
  await assert.rejects(provider.search({}, undefined), /web search provider "agy" received an empty query/)
  await assert.rejects(provider.search({ query: '   ' }, undefined), /web search provider "agy" received an empty query/)
  await assert.rejects(provider.search('query', undefined), /received an empty query/)
})

test('registers nothing when every provider is disabled', async (t) => {
  const ctx = await makeContext(t)
  await assert.rejects(
    ctx.apply({ providers: { agy: { enabled: false } } }),
    /no web search providers are enabled; enable at least one provider in config\.providers/,
  )
  assert.equal(ctx.searchProviders.length, 0)
  assert.equal(ctx.registeredTools.length, 0)
})

test('registers nothing when the config is invalid', async (t) => {
  const ctx = await makeContext(t)
  await assert.rejects(ctx.apply({ tool: { maxResults: 0 } }), /config\.tool\.maxResults must be an integer between 1 and 10/)
  assert.equal(ctx.searchProviders.length, 0)
  assert.equal(ctx.registeredTools.length, 0)

  const unknown = await makeContext(t)
  await assert.rejects(unknown.apply({ nope: true }), /config has unknown key "nope"/)
  assert.equal(unknown.searchProviders.length, 0)
})

test('registers a provider with disposal', async (t) => {
  const ctx = await makeContext(t)
  await ctx.apply({})
  assert.equal(ctx.searchProviders.length, 1)
})
