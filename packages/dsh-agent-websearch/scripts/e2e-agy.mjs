#!/usr/bin/env node
/**
 * Live end-to-end check against the local agy CLI. This bypasses DSH entirely:
 * it fakes the minimal plugin context, runs `apply()` exactly like the host
 * does, then exercises the registered web-search provider and the registered
 * `agent_web_search` tool against the real agy binary.
 *
 * Usage: node scripts/e2e-agy.mjs
 */
import assert from 'node:assert/strict'

import { apply } from '../index.js'

function makeContext() {
  const registeredProviders = []
  const registeredTools = []
  const effects = []
  return {
    registeredProviders,
    registeredTools,
    effects,
    web: { registerSearchProvider: provider => registeredProviders.push(provider) },
    tools: { register: definition => registeredTools.push(definition) },
    effect(factory, label) {
      const iterator = factory()
      const first = iterator.next()
      assert.equal(first.done, false)
      effects.push({ label, cleanup: first.value })
      return () => iterator.return?.()
    },
  }
}

function clock() {
  return Number(process.hrtime.bigint() / 1_000_000n)
}

async function step(name, fn) {
  const started = clock()
  const value = await fn()
  const elapsed = clock() - started
  console.log(`✔ ${name} (${elapsed} ms)`)
  return { value, elapsed }
}

export async function main() {
  console.log('dsh-agent-websearch: live agy end-to-end check\n')

  const ctx = makeContext()
  apply(ctx, {})

  const provider = ctx.registeredProviders.find(item => item.id === 'agy')
  assert.ok(provider, 'the agy provider must be registered')
  assert.equal(provider.available(), true, 'agy must be installed and logged in for this e2e check')
  assert.equal(await provider.ready(), true)

  const tool = ctx.registeredTools.find(item => item.name === 'agent_web_search')
  assert.ok(tool, 'the agent_web_search tool must be registered')
  console.log(`provider: ${provider.title}`)
  console.log(`tool: ${tool.name} (timeout ${tool.timeoutMs} ms)\n`)

  await step('provider.search returns normalizable sources', async () => {
    const value = await provider.search({ query: 'Node.js current LTS version', maxResults: 3 })
    assert.ok(Array.isArray(value.sources) && value.sources.length >= 1, 'at least one source is required')
    assert.ok(value.sources.length <= 3, 'the source cap must hold')
    for (const source of value.sources) assert.match(source.url, /^https?:\/\//)
    assert.equal(new Set(value.sources.map(source => source.url)).size, value.sources.length, 'sources must be unique')
    console.log(`  sources: ${value.sources.map(source => source.url).join('\n           ')}`)
    console.log(`  answer: ${value.content ?? '(none)'}`)
    return value
  })

  await step('agent_web_search merges two live queries', async () => {
    const controller = new AbortController()
    const exec = { signal: controller.signal }
    const result = await tool.execute(
      {
        queries: ['DeepSeek Harness coding agent', 'Cordis dependency injection framework'],
        maxResults: 4,
      },
      exec,
    )
    assert.ok(Array.isArray(result.sources) && result.sources.length >= 1, 'merged sources are required')
    assert.ok(result.sources.length <= 4, 'the merged source cap must hold')
    assert.equal(typeof result.truncated, 'boolean')
    for (const source of result.sources) assert.match(source.url, /^https?:\/\//)
    console.log(`  sources: ${result.sources.length}, truncated: ${result.truncated}`)
    for (const source of result.sources) console.log(`  - ${source.title ?? source.url} <${source.url}>`)
    if (result.content !== undefined) {
      console.log(`  content:\n${result.content.split('\n').map(line => `    ${line}`).join('\n')}`)
    }
    return result
  })

  for (const effect of ctx.effects) effect.cleanup()
  console.log('\nALL LIVE AGY CHECKS PASSED')
}

main().catch(error => {
  console.error(`\nLIVE AGY CHECK FAILED: ${error?.stack ?? error}`)
  process.exitCode = 1
})
