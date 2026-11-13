import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'

import { assertProviderDefinition } from '../lib/provider.js'
import {
  AGY_DEFAULTS,
  AGY_PROVIDER_ID,
  AGY_SEARCH_TOOL,
  agyProvider,
  buildPrompt,
  create,
  normalizeConfig,
  normalizeResultPayload,
  parseAgyEnvelope,
} from '../providers/agy.js'

const MAX_PROVIDER_SOURCES = 12

test('the agy provider definition satisfies the provider contract', () => {
  const normalized = assertProviderDefinition(agyProvider, 'providers/agy.js')
  assert.equal(normalized.id, AGY_PROVIDER_ID)
  assert.equal(normalized.id, 'agy')
  assert.equal(normalized.title, 'agy (local CLI)')
  assert.match(normalized.description.en, /search_web/)
  assert.match(normalized.description.zh, /search_web/)
  assert.equal(typeof normalized.create, 'function')
  assert.equal(typeof normalized.normalizeConfig, 'function')
})

test('defaults are documented and applied', () => {
  assert.deepEqual(AGY_DEFAULTS, {
    effort: 'low',
    timeoutMs: 120_000,
    maxResults: 6,
    maxConcurrent: 3,
  })
  assert.deepEqual(normalizeConfig({}), AGY_DEFAULTS)
  assert.notEqual(normalizeConfig({}), AGY_DEFAULTS)
})

test('resolves documented config overrides', () => {
  const extraArgs = ['--verbose', '--foo=bar']
  const config = normalizeConfig({
    agyPath: './bin/agy',
    home: '/tmp/agy-home',
    sourceHome: '/tmp/agy-source',
    effort: 'high',
    model: '  gemini-3-pro  ',
    logFile: './agy.log',
    extraArgs,
    timeoutMs: 180_000,
    maxResults: 4,
    maxConcurrent: 2,
  })

  assert.equal(config.agyPath, path.resolve('./bin/agy'))
  assert.equal(config.home, '/tmp/agy-home')
  assert.equal(config.sourceHome, '/tmp/agy-source')
  assert.equal(config.logFile, path.resolve('./agy.log'))
  assert.equal(config.effort, 'high')
  assert.equal(config.model, 'gemini-3-pro')
  assert.deepEqual(config.extraArgs, extraArgs)
  assert.equal(config.timeoutMs, 180_000)
  assert.equal(config.maxResults, 4)
  assert.equal(config.maxConcurrent, 2)
  extraArgs.push('--mutated')
  assert.deepEqual(config.extraArgs, ['--verbose', '--foo=bar'])
})

test('rejects malformed agy config with actionable messages', () => {
  const cases = [
    ['agy', /agy provider config must be an object/],
    [null, /agy provider config must be an object/],
    [{ nope: true }, /agy provider config has unknown key "nope"; supported keys: enabled, agyPath, home, sourceHome, effort, model, logFile, extraArgs, timeoutMs, maxResults, maxConcurrent/],
    [{ agyPath: '' }, /agy provider config "agyPath" must be a non-empty string/],
    [{ agyPath: 7 }, /agy provider config "agyPath" must be a non-empty string/],
    [{ home: ' ' }, /agy provider config "home" must be a non-empty string/],
    [{ sourceHome: false }, /agy provider config "sourceHome" must be a non-empty string/],
    [{ effort: 'turbo' }, /agy provider config "effort" must be one of: low, medium, high, xhigh, max/],
    [{ effort: 'LOW' }, /agy provider config "effort" must be one of:/],
    [{ model: '   ' }, /agy provider config "model" must be a non-empty string/],
    [{ extraArgs: '--verbose' }, /agy provider config "extraArgs" must be an array of strings/],
    [{ extraArgs: ['ok', 2] }, /agy provider config "extraArgs\[1\]" must be a string/],
    [{ timeoutMs: 9_999 }, /agy provider config "timeoutMs" must be an integer between 10000 and 900000/],
    [{ timeoutMs: 900_001 }, /agy provider config "timeoutMs" must be an integer between 10000 and 900000/],
    [{ timeoutMs: 1.5 }, /agy provider config "timeoutMs" must be an integer/],
    [{ maxResults: 0 }, /agy provider config "maxResults" must be an integer between 1 and 10/],
    [{ maxResults: 11 }, /agy provider config "maxResults" must be an integer between 1 and 10/],
    [{ maxConcurrent: 0 }, /agy provider config "maxConcurrent" must be an integer between 1 and 5/],
    [{ maxConcurrent: 6 }, /agy provider config "maxConcurrent" must be an integer between 1 and 5/],
  ]
  for (const [raw, pattern] of cases) {
    assert.throws(() => normalizeConfig(raw), pattern)
  }
})

test('buildPrompt forces exactly one search_web call and JSON-only output', () => {
  const query = 'latest "dsh" release? \nnewline'
  const config = { ...AGY_DEFAULTS, maxResults: 6 }
  const prompt = buildPrompt(query, config)

  assert.ok(prompt.includes(JSON.stringify(query)))
  assert.ok(prompt.includes(`Call the built-in ${AGY_SEARCH_TOOL} tool exactly once`))
  assert.match(prompt, /Do not run shell commands and do not read or write files\./)
  assert.match(prompt, /- "results": exactly 5 entries/)
  assert.match(prompt, /Use only URLs returned by the search and do not invent URLs\./)
  assert.match(prompt, /same language as the query/)

  assert.match(buildPrompt('q', { ...config, maxResults: 1 }), /exactly 2 entries/)
  assert.match(buildPrompt('q', { ...config, maxResults: 10 }), /exactly 5 entries/)
})

test('normalizes provider payloads and deduplicates sources', () => {
  const value = normalizeResultPayload({
    answer: 'A concise answer.',
    results: [
      { title: ' One ', url: 'https://one.test', snippet: ' first ' },
      { url: 'https://one.test', snippet: 'duplicate' },
      'https://two.test',
      { link: 'https://three.test' },
      { url: 'ftp://invalid.test' },
      { url: 'javascript:alert(1)' },
      null,
      'not a url',
    ],
  })

  assert.equal(value.content, 'A concise answer.')
  assert.equal(value.truncated, false)
  assert.deepEqual(value.sources, [
    { url: 'https://one.test', title: 'One', snippet: 'first' },
    { url: 'https://two.test' },
    { url: 'https://three.test' },
  ])
})

test('parses a JSON-string results field and falls back to summary', () => {
  const value = normalizeResultPayload({
    summary: '  From the summary.  ',
    results: JSON.stringify([{ title: 'T', url: 'https://example.test' }]),
  })
  assert.equal(value.content, 'From the summary.')
  assert.deepEqual(value.sources, [{ url: 'https://example.test', title: 'T' }])
})

test('extracts source URLs from the answer when results are missing', () => {
  const value = normalizeResultPayload({
    answer: 'See https://one.test/path, and also https://two.test/page.',
  })
  assert.deepEqual(value.sources, [
    { url: 'https://one.test/path' },
    { url: 'https://two.test/page' },
  ])
})

test('cleans fenced JSON answers', () => {
  const value = normalizeResultPayload({ answer: '```json\n{"answer":"Clean text."}\n```' })
  assert.equal(value.content, 'Clean text.')
  assert.deepEqual(value.sources, [])
})

test('caps the provider source list and flags truncation', () => {
  const results = Array.from({ length: 15 }, (_, index) => ({
    url: `https://site.test/${index}`,
  }))
  const value = normalizeResultPayload({ answer: 'answer', results })
  assert.equal(value.sources.length, MAX_PROVIDER_SOURCES)
  assert.equal(value.truncated, true)
  assert.equal(value.sources[0].url, 'https://site.test/0')
})

test('ignores payloads that are not plain objects', () => {
  for (const payload of [null, 'answer', 7, []]) {
    assert.deepEqual(normalizeResultPayload(payload), { sources: [], truncated: false })
  }
})

test('parses a successful agy envelope', () => {
  const stdout = JSON.stringify({
    status: 'SUCCESS',
    structured_output: {
      answer: 'The answer.',
      results: [
        { title: 'One', url: 'https://one.test', snippet: 'snippet one' },
        { title: 'Two', url: 'https://two.test', snippet: 'snippet two' },
      ],
    },
  })
  const value = parseAgyEnvelope(stdout)
  assert.equal(value.content, 'The answer.')
  assert.deepEqual(value.sources.map(source => source.url), ['https://one.test', 'https://two.test'])
  assert.equal(value.truncated, false)
})

test('accepts response, content, and fenced structured_output fallbacks', () => {
  const payload = { answer: 'answer', results: [{ url: 'https://one.test' }] }
  assert.equal(parseAgyEnvelope(JSON.stringify({ response: payload })).content, 'answer')
  assert.equal(parseAgyEnvelope(JSON.stringify({ content: payload })).sources.length, 1)
  assert.equal(
    parseAgyEnvelope(JSON.stringify({ status: 'SUCCESS', structured_output: '```json\n' + JSON.stringify(payload) + '\n```' }))
      .content,
    'answer',
  )
  assert.equal(
    parseAgyEnvelope(JSON.stringify({ status: 'SUCCESS', structured_output: JSON.stringify(payload) })).sources.length,
    1,
  )
})

test('rejects failed and unusable envelopes', () => {
  assert.throws(() => parseAgyEnvelope(''), /agy returned no output/)
  assert.throws(() => parseAgyEnvelope('   '), /agy returned no output/)
  assert.throws(() => parseAgyEnvelope('<html>oops</html>'), /agy returned non-JSON output: <html>oops<\/html>/)
  assert.throws(() => parseAgyEnvelope('[]'), /agy returned a non-object JSON envelope/)
  assert.throws(
    () => parseAgyEnvelope(JSON.stringify({
      status: 'FAILED',
      error: 'boom',
      denied_actions: [{ name: 'search_web', reason: 'denied' }, 'extra'],
    })),
    /agy search failed with status FAILED: boom; search_web: denied; extra/,
  )
  assert.throws(() => parseAgyEnvelope(JSON.stringify({ status: 'SUCCESS' })), /agy returned no structured result/)
  assert.throws(
    () => parseAgyEnvelope(JSON.stringify({ status: 'SUCCESS', structured_output: 'not json at all' })),
    /agy returned an unparsable structured result: not json at all/,
  )
  assert.throws(
    () => parseAgyEnvelope(JSON.stringify({ status: 'SUCCESS', structured_output: [1, 2] })),
    /agy returned a structured result that is not a JSON object/,
  )
  assert.throws(
    () => parseAgyEnvelope(JSON.stringify({ status: 'SUCCESS', structured_output: {} })),
    /agy search returned neither an answer nor usable source URLs; the search tool may have been denied, or the query returned no results/,
  )
})

test('create returns the documented provider instance', async () => {
  const instance = create(normalizeConfig({}))
  assert.equal(typeof instance.status, 'function')
  assert.equal(typeof instance.ready, 'function')
  assert.equal(typeof instance.search, 'function')
  assert.equal(typeof instance.searchMany, 'function')
  assert.equal(typeof instance.toolTimeoutMs, 'function')
  assert.equal(typeof instance.dispose, 'function')

  const status = instance.status()
  assert.equal(typeof status.available, 'boolean')
  if (!status.available) assert.match(status.reason, /agy/i)

  assert.equal(instance.toolTimeoutMs(1), 150_000)
  assert.equal(instance.toolTimeoutMs(4), 270_000)
  assert.equal(await instance.ready(), status.available)
})
