import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  PROVIDER_ID_PATTERN,
  assertProviderDefinition,
  assertProviderInstance,
  instantiateProvider,
  readProviderStatus,
} from '../lib/provider.js'

function validDefinition(overrides = {}) {
  return {
    id: 'alpha',
    title: 'Alpha',
    description: { en: 'Alpha provider description', zh: 'Alpha 提供方说明' },
    create: () => ({
      status: () => ({ available: true }),
      async search() {
        return { sources: [], truncated: false }
      },
    }),
    ...overrides,
  }
}

test('accepts and normalizes a valid definition', () => {
  const definition = validDefinition({ id: '  alpha-2  ', title: '  Alpha 2  ' })
  const normalized = assertProviderDefinition(definition, 'providers/alpha-2.js')
  assert.equal(normalized.id, 'alpha-2')
  assert.equal(normalized.title, 'Alpha 2')
  assert.deepEqual(normalized.description, {
    en: 'Alpha provider description',
    zh: 'Alpha 提供方说明',
  })
  assert.equal(typeof normalized.create, 'function')
  assert.equal(normalized.normalizeConfig, undefined)
})

test('accepts a plain-string description', () => {
  const normalized = assertProviderDefinition(validDefinition({ description: 'one line' }), 'providers/x.js')
  assert.deepEqual(normalized.description, { en: 'one line' })
})

test('rejects malformed definitions', () => {
  const cases = [
    [null, /must export a provider definition object/],
    [{ ...validDefinition(), id: 'Alpha' }, /invalid id "Alpha"/],
    [{ ...validDefinition(), id: 'alpha beta' }, /invalid id/],
    [{ ...validDefinition(), id: '' }, /id must be a non-empty string/],
    [{ ...validDefinition(), id: 'a'.repeat(33) }, /invalid id/],
    [{ ...validDefinition(), title: '' }, /title must be a non-empty string/],
    [{ ...validDefinition(), title: 'x'.repeat(65) }, /title must be at most 64 characters/],
    [{ ...validDefinition(), description: {} }, /description\.en must be a non-empty string/],
    [{ ...validDefinition(), description: { en: 'ok', fr: 'bonjour' } }, /description has unknown locale key "fr"/],
    [{ ...validDefinition(), description: { en: 'ok', zh: '' } }, /description\.zh must be a non-empty string/],
    [{ ...validDefinition(), create: undefined }, /must implement create\(config\)/],
    [{ ...validDefinition(), create: 'nope' }, /must implement create\(config\)/],
    [{ ...validDefinition(), normalizeConfig: {} }, /normalizeConfig must be a function/],
  ]
  for (const [definition, pattern] of cases) {
    assert.throws(() => assertProviderDefinition(definition, 'providers/alpha.js'), pattern)
  }
})

test('provider id pattern matches the documented rules', () => {
  assert.equal(PROVIDER_ID_PATTERN.test('agy'), true)
  assert.equal(PROVIDER_ID_PATTERN.test('my-provider-2'), true)
  assert.equal(PROVIDER_ID_PATTERN.test('a'), true)
  assert.equal(PROVIDER_ID_PATTERN.test('A'), false)
  assert.equal(PROVIDER_ID_PATTERN.test('2fast'), false)
  assert.equal(PROVIDER_ID_PATTERN.test('a'.repeat(33)), false)
})

test('instantiates a provider and passes the normalized config through', () => {
  let received
  const definition = assertProviderDefinition(
    validDefinition({
      normalizeConfig(raw) {
        assert.deepEqual(raw, { marker: 1 })
        return { marker: 2 }
      },
      create(config) {
        received = config
        return {
          status: () => ({ available: true }),
          async search() {
            return { sources: [], truncated: false }
          },
        }
      },
    }),
    'providers/alpha.js',
  )
  const entry = instantiateProvider(definition, { marker: 1 })
  assert.deepEqual(received, { marker: 2 })
  assert.deepEqual(entry.config, { marker: 2 })
  assert.equal(entry.definition.id, 'alpha')
  assert.equal(typeof entry.instance.search, 'function')
})

test('instantiation errors carry the provider id', () => {
  const definition = assertProviderDefinition(
    validDefinition({
      normalizeConfig() {
        throw new Error('bad marker')
      },
    }),
    'providers/alpha.js',
  )
  assert.throws(
    () => instantiateProvider(definition, {}),
    /provider "alpha" has invalid config: bad marker/,
  )
  assert.throws(
    () => instantiateProvider(assertProviderDefinition(validDefinition({
      create() {
        throw new Error('cannot start')
      },
    }), 'providers/alpha.js'), {}),
    /provider "alpha" failed to initialize: cannot start/,
  )
  assert.throws(
    () => instantiateProvider(assertProviderDefinition(validDefinition({ create: () => null }), 'providers/x.js'), {}),
    /provider "alpha" create\(config\) must return an object/,
  )
})

test('accepts a valid provider instance and returns it', () => {
  const status = () => ({ available: true })
  const search = async () => ({ sources: [], truncated: false })
  const instance = { status, search }
  assert.equal(assertProviderInstance(instance, 'alpha'), instance)

  const full = {
    status,
    search,
    ready: async () => true,
    searchMany: async () => ({ sources: [], truncated: false }),
    toolTimeoutMs: () => 120_000,
    dispose: async () => {},
  }
  assert.equal(assertProviderInstance(full, 'alpha'), full)
})

test('rejects malformed provider instances', () => {
  const status = () => ({ available: true })
  const search = async () => ({ sources: [], truncated: false })
  for (const [instance, pattern] of [
    [null, /must return an object/],
    [{ search }, /must implement status\(\)/],
    [{ status }, /must implement search\(\)/],
    [{ status, search, ready: 1 }, /ready must be a function when present/],
    [{ status, search, searchMany: 'x' }, /searchMany must be a function when present/],
    [{ status, search, toolTimeoutMs: 1 }, /toolTimeoutMs must be a function when present/],
    [{ status, search, dispose: true }, /dispose must be a function when present/],
  ]) {
    assert.throws(() => assertProviderInstance(instance, 'alpha'), pattern)
  }
})

test('readProviderStatus passes through reason and trims it', () => {
  const entry = {
    definition: { id: 'alpha' },
    instance: {
      status: () => ({ available: false, reason: '  not logged in  ' }),
    },
  }
  assert.deepEqual(readProviderStatus(entry), { available: false, reason: 'not logged in' })

  entry.instance.status = () => ({ available: true })
  assert.deepEqual(readProviderStatus(entry), { available: true })

  entry.instance.status = () => ({ available: true, reason: 'ignored' })
  assert.deepEqual(readProviderStatus(entry), { available: true, reason: 'ignored' })

  entry.instance.status = () => ({ available: false, reason: 7 })
  assert.deepEqual(readProviderStatus(entry), { available: false })
})

test('readProviderStatus validates and wraps failures', () => {
  const read = status => readProviderStatus({ definition: { id: 'alpha' }, instance: { status } })
  assert.throws(() => read(() => ({ available: 'yes' })), /status\(\) must return \{ available: boolean, reason\?: string \}/)
  assert.throws(() => read(() => null), /status\(\) must return/)
  assert.throws(() => read(() => {
    throw new Error('probe exploded')
  }), /provider "alpha" could not report its status: probe exploded/)
})
