import { pluginError } from './errors.js'
import { isPlainObject } from './values.js'
import {
  PROVIDER_ID_PATTERN,
  instantiateProvider,
} from './provider.js'

const TOP_LEVEL_KEYS = ['provider', 'providers', 'tool']
const TOOL_KEYS = ['maxResults', 'maxQueries', 'timeoutMs']
const TOOL_DEFAULTS = { maxResults: 6, maxQueries: 3 }

function integerInRange(value, { min, max, path }) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw pluginError(`config.${path} must be an integer between ${min} and ${max}`)
  }
  return value
}

function rejectUnknownKeys(object, known, path) {
  const label = path.length === 0 ? 'config' : `config.${path}`
  for (const key of Object.keys(object)) {
    if (!known.includes(key)) {
      throw pluginError(`${label} has unknown key "${key}"; supported keys: ${known.join(', ')}`)
    }
  }
}

function normalizeToolConfig(raw) {
  const tool = { ...TOOL_DEFAULTS }
  if (raw === undefined) return tool
  if (!isPlainObject(raw)) throw pluginError('config.tool must be an object')
  rejectUnknownKeys(raw, TOOL_KEYS, 'tool')
  if (raw.maxResults !== undefined) {
    tool.maxResults = integerInRange(raw.maxResults, { min: 1, max: 10, path: 'tool.maxResults' })
  }
  if (raw.maxQueries !== undefined) {
    tool.maxQueries = integerInRange(raw.maxQueries, { min: 1, max: 10, path: 'tool.maxQueries' })
  }
  if (raw.timeoutMs !== undefined) {
    tool.timeoutMs = integerInRange(raw.timeoutMs, { min: 10_000, max: 900_000, path: 'tool.timeoutMs' })
  }
  return tool
}

function normalizeProviderSections(raw, definitions) {
  const sections = new Map()
  if (raw === undefined) return sections
  if (!isPlainObject(raw)) {
    throw pluginError('config.providers must be an object keyed by provider id')
  }
  const knownIds = definitions.map(definition => definition.id)
  for (const [id, value] of Object.entries(raw)) {
    if (!knownIds.includes(id)) {
      throw pluginError(
        `config.providers has unknown provider "${id}"; registered providers: ${knownIds.length === 0 ? '(none)' : knownIds.join(', ')}`,
      )
    }
    if (!isPlainObject(value)) {
      throw pluginError(`config.providers.${id} must be an object`)
    }
    if (value.enabled !== undefined && typeof value.enabled !== 'boolean') {
      throw pluginError(`config.providers.${id}.enabled must be a boolean`)
    }
    sections.set(id, value)
  }
  return sections
}

/**
 * Resolve the plugin's config into normalized tool settings plus one runtime
 * entry per enabled provider, in registry order (the order shown to users).
 *
 * Provider-specific settings are delegated to each provider's
 * `normalizeConfig`; `enabled` is the only generic per-provider key.
 */
export function normalizeConfig(rawConfig, definitions) {
  if (rawConfig === undefined || rawConfig === null) rawConfig = {}
  if (!isPlainObject(rawConfig)) throw pluginError('plugin config must be an object')
  rejectUnknownKeys(rawConfig, TOP_LEVEL_KEYS, '')

  const tool = normalizeToolConfig(rawConfig.tool)
  const sections = normalizeProviderSections(rawConfig.providers, definitions)

  const entries = []
  for (const definition of definitions) {
    const section = sections.get(definition.id) ?? {}
    if (section.enabled === false) continue
    const providerConfig = { ...section }
    delete providerConfig.enabled
    entries.push(instantiateProvider(definition, providerConfig))
  }
  if (entries.length === 0) {
    throw pluginError('no web search providers are enabled; enable at least one provider in config.providers')
  }

  let provider
  if (rawConfig.provider !== undefined) {
    provider = rawConfig.provider
    if (typeof provider !== 'string' || !PROVIDER_ID_PATTERN.test(provider)) {
      throw pluginError('config.provider must be a provider id (lowercase letters, digits, and hyphens)')
    }
    if (!entries.some(entry => entry.definition.id === provider)) {
      throw pluginError(
        `config.provider "${provider}" is not an enabled provider; available providers: ${entries.map(entry => entry.definition.id).join(', ')}`,
      )
    }
  } else {
    provider = entries[0].definition.id
  }

  return { provider, tool, entries }
}
