import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createToolDefinition, TOOL_NAME } from '../lib/tool.js'
import { SEARCH_RESULT_SCHEMA, MAX_TOOL_SOURCES } from '../lib/search.js'

async function caught(promise) {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected promise to reject')
}

function makeEntry(id, { status = () => ({ available: true }), search, searchMany, toolTimeoutMs } = {}) {
  const calls = { search: [], searchMany: [] }
  const instance = {
    status,
    async search(request, signal) {
      calls.search.push({ request, signal })
      if (search !== undefined) return search(request, signal)
      return { content: `answer for ${request.query}`, sources: [], truncated: false }
    },
  }
  if (searchMany !== undefined) {
    instance.searchMany = async (request, signal) => {
      calls.searchMany.push({ request, signal })
      return searchMany(request, signal)
    }
  }
  if (toolTimeoutMs !== undefined) instance.toolTimeoutMs = toolTimeoutMs
  return {
    definition: { id, title: `Provider ${id}`, description: { en: `Provider ${id}` } },
    config: {},
    instance,
    calls,
  }
}

function makeConfig(entries, tool = {}) {
  return {
    provider: entries[0].definition.id,
    tool: { maxResults: 3, maxQueries: 2, ...tool },
    entries,
  }
}

test('exposes a provider-aware tool schema and presentation', () => {
  const entries = [makeEntry('alpha'), makeEntry('beta')]
  const definition = createToolDefinition(makeConfig(entries))

  assert.equal(definition.name, TOOL_NAME)
  assert.equal(definition.name, 'agent_web_search')
  assert.equal(definition.isConcurrencySafe(), true)
  assert.equal(definition.timeoutMs, 120_000)
  assert.equal(definition.output.schema, SEARCH_RESULT_SCHEMA)

  assert.equal(definition.parameters.required[0], 'queries')
  assert.deepEqual(definition.parameters.properties.provider.enum, ['alpha', 'beta'])
  assert.equal(definition.parameters.properties.queries.maxItems, 2)
  assert.equal(definition.parameters.properties.maxResults.maximum, MAX_TOOL_SOURCES)
  assert.equal(definition.parameters.additionalProperties, false)

  const call = definition.presentCall({ queries: [' alpha query ', 'beta query'] })
  assert.equal(call.card, 'generic')
  assert.equal(call.kind, 'search')
  assert.equal(call.title, 'alpha query, beta query')
  assert.deepEqual(call.rawInput, { queries: [' alpha query ', 'beta query'] })

  const rendered = definition.output.render({}, {
    content: 'answer',
    sources: [{ url: 'https://example.com', title: 'Example', snippet: 'short' }],
    truncated: false,
  })
  assert.equal(rendered.length, 1)
  assert.equal(rendered[0].type, 'text')
  assert.match(rendered[0].text, /Sources:/)
  assert.match(rendered[0].text, /\[Example\]\(https:\/\/example\.com\) — short/)

  const meta = definition.output.presentationMeta({}, {
    content: 'answer',
    sources: [
      { url: 'https://example.com', title: '', snippet: 'snip', publishedAt: '2026-01-01' },
      { url: 'https://other.test' },
    ],
    truncated: true,
  })
  assert.equal(meta.answer, 'answer')
  assert.equal(meta.truncated, true)
  assert.deepEqual(meta.sources, [
    { url: 'https://example.com', snippet: 'snip', publishedAt: '2026-01-01' },
    { url: 'https://other.test' },
  ])
})

test('runs a single query and normalizes sources', async () => {
  const entry = makeEntry('alpha', {
    search: async () => ({
      content: 'Summary',
      sources: [
        { url: 'https://one.test', title: 'One' },
        { url: 'https://one.test', title: 'duplicate' },
        { url: 'ftp://invalid.test', title: 'ignored' },
        { url: 'https://two.test', snippet: 'two' },
        { url: 'https://three.test' },
        { url: 'https://four.test' },
      ],
      truncated: false,
    }),
  })
  const definition = createToolDefinition(makeConfig([entry]))
  const value = await definition.execute({ queries: ['  q1  '] })

  assert.equal(entry.calls.search.length, 1)
  assert.deepEqual(entry.calls.search[0].request, { query: 'q1', maxResults: 3 })
  assert.equal(value.content, 'Summary')
  assert.deepEqual(value.sources.map(source => source.url), [
    'https://one.test',
    'https://two.test',
    'https://three.test',
  ])
  assert.equal(value.truncated, true)
})

test('deduplicates queries and runs multiple queries in parallel with rank interleaving', async () => {
  const seen = []
  const entry = makeEntry('alpha', {
    search: async request => {
      seen.push(request.query)
      if (request.query === 'q1') {
        return {
          content: 'answer one',
          sources: [
            { url: 'https://a/1' },
            { url: 'https://a/2' },
            { url: 'https://a/3' },
          ],
          truncated: false,
        }
      }
      return {
        content: 'answer two',
        sources: [
          { url: 'https://b/1' },
          { url: 'https://b/2' },
        ],
        truncated: false,
      }
    },
  })
  const definition = createToolDefinition(makeConfig([entry], { maxQueries: 3 }))
  const value = await definition.execute({ queries: ['q1', ' q1 ', 'q2'] })

  assert.deepEqual(seen.sort(), ['q1', 'q2'])
  assert.equal(entry.calls.search.length, 2)
  assert.deepEqual(value.sources.map(source => source.url), [
    'https://a/1',
    'https://b/1',
    'https://a/2',
  ])
  assert.equal(value.truncated, true)
  assert.match(value.content, /### q1\n\nanswer one/)
  assert.match(value.content, /### q2\n\nanswer two/)
})

test('prefers searchMany when the provider implements it', async () => {
  const entry = makeEntry('alpha', {
    searchMany: async request => ({
      content: 'merged answer',
      sources: [{ url: 'https://one.test' }],
      truncated: false,
    }),
  })
  const definition = createToolDefinition(makeConfig([entry]))
  const value = await definition.execute({ queries: ['q1', 'q2'] })

  assert.equal(entry.calls.searchMany.length, 1)
  assert.deepEqual(entry.calls.searchMany[0].request, { queries: ['q1', 'q2'], maxResults: 3 })
  assert.equal(entry.calls.search.length, 0)
  assert.equal(value.content, 'merged answer')
})

test('resolves an explicit provider argument', async () => {
  const alpha = makeEntry('alpha')
  const beta = makeEntry('beta')
  const definition = createToolDefinition(makeConfig([alpha, beta]))
  const value = await definition.execute({ queries: ['q'], provider: 'beta' })

  assert.equal(alpha.calls.search.length, 0)
  assert.equal(beta.calls.search.length, 1)
  assert.equal(value.content, 'answer for q')
})

test('honors an explicit maxResults and the configured default', async () => {
  const entry = makeEntry('alpha', {
    search: async request => ({
      sources: Array.from({ length: 6 }, (_, index) => ({ url: `https://x/${index}` })),
      truncated: false,
    }),
  })
  const definition = createToolDefinition(makeConfig([entry], { maxResults: 2 }))
  const limited = await definition.execute({ queries: ['q'], maxResults: 1 })
  assert.equal(entry.calls.search[0].request.maxResults, 1)
  assert.equal(limited.sources.length, 1)
  assert.equal(limited.truncated, true)

  await definition.execute({ queries: ['q'] })
  assert.equal(entry.calls.search[1].request.maxResults, 2)
})

test('rejects unavailable providers with the reported reason', async () => {
  const withReason = makeEntry('alpha', {
    status: () => ({ available: false, reason: 'agy is not logged in on this machine' }),
  })
  const withoutReason = makeEntry('alpha', { status: () => ({ available: false }) })
  const definition = createToolDefinition(makeConfig([withReason]))
  await assert.rejects(
    definition.execute({ queries: ['q'] }),
    /agent_web_search cannot use provider "alpha": agy is not logged in on this machine/,
  )
  const fallback = createToolDefinition(makeConfig([withoutReason]))
  await assert.rejects(
    fallback.execute({ queries: ['q'] }),
    /agent_web_search cannot use provider "alpha": its local prerequisite is unavailable/,
  )
  assert.equal(withReason.calls.search.length, 0)
})

test('wraps provider failures once with the plugin prefix', async () => {
  const failing = makeEntry('alpha', {
    search: async () => {
      throw new Error('network down')
    },
  })
  const definition = createToolDefinition(makeConfig([failing]))
  const error = await caught(definition.execute({ queries: ['q'] }))
  assert.equal(error.name, 'AgentWebSearchError')
  assert.match(error.message, /provider "alpha" search failed: network down/)
  assert.equal((error.message.match(/\[dsh-agent-websearch\]/g) ?? []).length, 1)
})

test('status errors are reported before searching', async () => {
  const entry = makeEntry('alpha', {
    status: () => {
      throw new Error('probe exploded')
    },
  })
  const definition = createToolDefinition(makeConfig([entry]))
  await assert.rejects(definition.execute({ queries: ['q'] }), /could not report its status: probe exploded/)
  assert.equal(entry.calls.search.length, 0)
})

test('validates tool arguments', async () => {
  const entry = makeEntry('alpha')
  const definition = createToolDefinition(makeConfig([entry], { maxQueries: 2 }))
  const badCalls = [
    [undefined],
    [null],
    ['q'],
    [[]],
    [[1]],
    [{ query: 'q' }],
    [{}],
    [{ queries: 'q' }],
    [{ queries: [] }],
    [{ queries: ['q', 'q2', 'q3'] }],
    [{ queries: ['q', '  '] }],
    [{ queries: ['q', 3] }],
    [{ queries: ['q'], provider: 'gamma' }],
    [{ queries: ['q'], provider: '' }],
    [{ queries: ['q'], provider: 7 }],
    [{ queries: ['q'], maxResults: 0 }],
    [{ queries: ['q'], maxResults: 11 }],
    [{ queries: ['q'], maxResults: 2.5 }],
    [{ queries: ['q'], maxResults: '3' }],
  ]
  for (const [args] of badCalls) {
    await assert.rejects(definition.execute(args), /agent_web_search:/)
  }
  assert.equal(entry.calls.search.length, 0)
})

test('reports specific argument errors', async () => {
  const entry = makeEntry('alpha')
  const definition = createToolDefinition(makeConfig([entry], { maxQueries: 2 }))
  await assert.rejects(definition.execute({}), /"queries" must be an array of 1-2 non-empty strings/)
  await assert.rejects(definition.execute({ queries: [] }), /"queries" must contain 1-2 queries \(received 0\)/)
  await assert.rejects(definition.execute({ queries: ['q', 'r', 's'] }), /received 3/)
  await assert.rejects(definition.execute({ queries: [' '] }), /every query must be a non-empty string/)
  await assert.rejects(definition.execute({ queries: ['q'], extra: 1 }), /unknown argument "extra"/)
  await assert.rejects(definition.execute({ queries: ['q'], provider: 'gamma' }), /unknown search provider "gamma"; available providers: alpha/)
  await assert.rejects(definition.execute({ queries: ['q'], maxResults: 0 }), /"maxResults" must be an integer between 1 and 10/)
})

test('aborts before resolving or searching when the signal is already aborted', async () => {
  const entry = makeEntry('alpha')
  const definition = createToolDefinition(makeConfig([entry]))
  const controller = new AbortController()
  controller.abort()
  const error = await caught(definition.execute({ queries: ['q'] }, { signal: controller.signal }))
  assert.equal(error.name, 'AbortError')
  assert.equal(entry.calls.search.length, 0)
})

test('forwards a live abort signal to the provider', async () => {
  const entry = makeEntry('alpha', {
    search: async (request, signal) => {
      assert.equal(signal.aborted, false)
      return { sources: [], truncated: false }
    },
  })
  const definition = createToolDefinition(makeConfig([entry]))
  const controller = new AbortController()
  await definition.execute({ queries: ['q'] }, { signal: controller.signal })
  assert.equal(entry.calls.search.length, 1)
})

test('computes tool timeouts from config and provider hints', () => {
  const hinting = makeEntry('alpha', { toolTimeoutMs: maxQueries => maxQueries * 60_000 })
  assert.equal(createToolDefinition(makeConfig([hinting], { maxQueries: 3 })).timeoutMs, 180_000)
  assert.equal(
    createToolDefinition(makeConfig([hinting], { maxQueries: 3, timeoutMs: 15_000 })).timeoutMs,
    15_000,
  )
  const noHint = makeEntry('alpha', { toolTimeoutMs: () => 'bad' })
  assert.equal(createToolDefinition(makeConfig([noHint])).timeoutMs, 120_000)
})

test('presents sources with fallback titles', () => {
  const entry = makeEntry('alpha')
  const definition = createToolDefinition(makeConfig([entry]))
  const presented = definition.presentResult({ queries: ['q1', 'q2'] }, {
    meta: {
      sources: [
        { url: 'https://example.com', snippet: 'snip' },
        { url: 'https://example.com', title: 'Duplicate blocked only by narrowing' },
      ],
      truncated: true,
      answer: '  text  ',
    },
  })
  assert.equal(presented.card, 'web')
  assert.equal(presented.title, 'q1, q2')
  assert.equal(presented.truncated, true)
  assert.equal(presented.answer, 'text')
  assert.equal(presented.sources[0].title, 'example.com')
  assert.equal(presented.sources.length, 1)

  const empty = definition.presentResult({}, {})
  assert.equal(empty.card, 'web')
  assert.equal(empty.title, TOOL_NAME)
  assert.equal(empty.truncated, false)
})
