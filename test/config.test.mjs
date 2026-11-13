import { test } from 'node:test'
import assert from 'node:assert/strict'

import { normalizeConfig } from '../lib/config.js'

function defineProvider(id, { config = {}, instance } = {}) {
  const seen = []
  return {
    id,
    title: `Provider ${id}`,
    description: { en: `Provider ${id} description` },
    normalizeConfig(raw) {
      seen.push({ ...raw })
      return { ...raw, ...config }
    },
    create() {
      return instance ?? {
        status: () => ({ available: true }),
        async search() {
          return { sources: [], truncated: false }
        },
      }
    },
    seen,
  }
}

function alpha(extra) {
  return defineProvider('alpha', extra)
}

function beta(extra) {
  return defineProvider('beta', extra)
}

test('applies defaults and keeps registry order', () => {
  const a = alpha()
  const b = beta()
  const config = normalizeConfig({}, [a, b])

  assert.equal(config.provider, 'alpha')
  assert.deepEqual(config.tool, { maxResults: 6, maxQueries: 3 })
  assert.deepEqual(
    config.entries.map(entry => entry.definition.id),
    ['alpha', 'beta'],
  )
  assert.deepEqual(config.entries[0].config, {})
  assert.deepEqual(config.entries[1].config, {})
})

test('missing config object is allowed (bundle defaults apply)', () => {
  assert.equal(normalizeConfig(undefined, [alpha()]).provider, 'alpha')
  assert.equal(normalizeConfig(null, [alpha()]).provider, 'alpha')
})

test('rejects config that is not an object', () => {
  for (const value of ['agy', 7, [], true]) {
    assert.throws(
      () => normalizeConfig(value, [alpha()]),
      /plugin config must be an object/,
    )
  }
})

test('rejects unknown top-level keys', () => {
  assert.throws(
    () => normalizeConfig({ search: {} }, [alpha()]),
    /config has unknown key "search"; supported keys: provider, providers, tool/,
  )
})

test('applies tool overrides and bounds', () => {
  const config = normalizeConfig({ tool: { maxResults: 2, maxQueries: 4, timeoutMs: 60_000 } }, [alpha()])
  assert.deepEqual(config.tool, { maxResults: 2, maxQueries: 4, timeoutMs: 60_000 })

  for (const [tool, pattern] of [
    [{ maxResults: 0 }, /config\.tool\.maxResults must be an integer between 1 and 10/],
    [{ maxResults: 11 }, /config\.tool\.maxResults must be an integer between 1 and 10/],
    [{ maxResults: 2.5 }, /config\.tool\.maxResults must be an integer between 1 and 10/],
    [{ maxQueries: 0 }, /config\.tool\.maxQueries must be an integer between 1 and 10/],
    [{ maxQueries: 11 }, /config\.tool\.maxQueries must be an integer between 1 and 10/],
    [{ timeoutMs: 9_999 }, /config\.tool\.timeoutMs must be an integer between 10000 and 900000/],
    [{ timeoutMs: 900_001 }, /config\.tool\.timeoutMs must be an integer between 10000 and 900000/],
    [{ maxResults: '3' }, /config\.tool\.maxResults must be an integer/],
  ]) {
    assert.throws(() => normalizeConfig({ tool }, [alpha()]), pattern)
  }

  assert.throws(() => normalizeConfig({ tool: { limit: 3 } }, [alpha()]), /config\.tool has unknown key "limit"/)
  assert.throws(() => normalizeConfig({ tool: [] }, [alpha()]), /config\.tool must be an object/)
})

test('enabled:false skips a provider and makes the next one the default', () => {
  const config = normalizeConfig({ providers: { alpha: { enabled: false } } }, [alpha(), beta()])
  assert.deepEqual(
    config.entries.map(entry => entry.definition.id),
    ['beta'],
  )
  assert.equal(config.provider, 'beta')
})

test('all providers disabled is an explicit error', () => {
  assert.throws(
    () => normalizeConfig({ providers: { alpha: { enabled: false } } }, [alpha()]),
    /no web search providers are enabled; enable at least one provider in config\.providers/,
  )
  assert.throws(() => normalizeConfig({}, []), /no web search providers are enabled/)
})

test('enabled is stripped before provider normalizeConfig runs', () => {
  const a = alpha()
  normalizeConfig({ providers: { alpha: { enabled: true, marker: 'x' } } }, [a])
  assert.deepEqual(a.seen, [{ marker: 'x' }])
})

test('provider sections must be objects keyed by known ids', () => {
  assert.throws(
    () => normalizeConfig({ providers: { alpha: { enabled: false }, gamma: { enabled: true } } }, [alpha()]),
    /config\.providers has unknown provider "gamma"; registered providers: alpha/,
  )
  assert.throws(
    () => normalizeConfig({ providers: { alpha: true } }, [alpha()]),
    /config\.providers\.alpha must be an object/,
  )
  assert.throws(
    () => normalizeConfig({ providers: { alpha: { enabled: 'yes' } } }, [alpha()]),
    /config\.providers\.alpha\.enabled must be a boolean/,
  )
  assert.throws(() => normalizeConfig({ providers: [] }, [alpha()]), /config\.providers must be an object/)
})

test('periodic provider config typo is reported by the provider factory', () => {
  const definition = defineProvider('alpha')
  definition.normalizeConfig = () => {
    throw new Error('bad config from alpha')
  }
  assert.throws(
    () => normalizeConfig({ providers: { alpha: { nope: 1 } } }, [definition]),
    /provider "alpha" has invalid config: bad config from alpha/,
  )
})

test('explicit provider must be enabled', () => {
  assert.throws(
    () => normalizeConfig({ provider: 'alpha', providers: { alpha: { enabled: false } } }, [alpha(), beta()]),
    /config\.provider "alpha" is not an enabled provider; available providers: beta/,
  )
  assert.throws(
    () => normalizeConfig({ provider: 'Alpha' }, [alpha()]),
    /config\.provider must be a provider id/,
  )
  assert.equal(normalizeConfig({ provider: 'beta' }, [alpha(), beta()]).provider, 'beta')
})

test('a provider normalizeConfig result is passed to create', () => {
  let created
  const definition = defineProvider('alpha')
  definition.create = config => {
    created = config
    return {
      status: () => ({ available: true }),
      async search() {
        return { sources: [], truncated: false }
      },
    }
  }
  normalizeConfig({ providers: { alpha: { marker: 1 } } }, [definition])
  assert.deepEqual(created, { marker: 1 })
})

