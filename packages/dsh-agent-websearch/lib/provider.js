import { pluginError, stripPluginPrefix, messageOf, isPluginError } from './errors.js'
import { isPlainObject, trimmedString } from './values.js'

/** Provider ids double as registry keys and tool argument values. */
export const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/

function assertText(value, path) {
  const text = trimmedString(value)
  if (text === undefined) throw pluginError(`${path} must be a non-empty string`)
  return text
}

function validateLocalizedText(value, path) {
  if (typeof value === 'string') return { en: assertText(value, path) }
  if (!isPlainObject(value)) {
    throw pluginError(`${path} must be a string or an object with an "en" string`)
  }
  const text = { en: assertText(value.en, `${path}.en`) }
  if (value.zh !== undefined) text.zh = assertText(value.zh, `${path}.zh`)
  for (const key of Object.keys(value)) {
    if (key !== 'en' && key !== 'zh') throw pluginError(`${path} has unknown locale key "${key}"`)
  }
  return text
}

/**
 * Validate one provider definition. Provider modules are plain data plus
 * factory functions, so this is the only place defining the required contract.
 */
export function assertProviderDefinition(definition, source) {
  if (!isPlainObject(definition)) {
    throw pluginError(`provider module ${source} must export a provider definition object`)
  }
  const id = constString(definition.id, `${source} id`)
  if (!PROVIDER_ID_PATTERN.test(id)) {
    throw pluginError(`provider module ${source} has invalid id "${id}"; use lowercase letters, digits, and hyphens (max 32 characters)`)
  }
  const title = assertText(definition.title, `provider "${id}" title`)
  if (title.length > 64) throw pluginError(`provider "${id}" title must be at most 64 characters`)
  const description = validateLocalizedText(definition.description, `provider "${id}" description`)
  if (definition.normalizeConfig !== undefined && typeof definition.normalizeConfig !== 'function') {
    throw pluginError(`provider "${id}" normalizeConfig must be a function`)
  }
  if (typeof definition.create !== 'function') {
    throw pluginError(`provider "${id}" must implement create(config)`)
  }
  return { id, title, description, normalizeConfig: definition.normalizeConfig, create: definition.create }
}

function constString(value, path) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw pluginError(`${path} must be a non-empty string`)
  }
  return value.trim()
}

/**
 * Normalize a provider's config section and instantiate its runtime object.
 * Config errors are reported with the provider id so a typo in one provider's
 * section is easy to locate.
 */
export function instantiateProvider(definition, rawConfig) {
  const section = isPlainObject(rawConfig) ? rawConfig : {}
  let config
  try {
    config = typeof definition.normalizeConfig === 'function'
      ? definition.normalizeConfig(section)
      : section
  } catch (error) {
    throw pluginError(
      `provider "${definition.id}" has invalid config: ${stripPluginPrefix(messageOf(error))}`,
      isPluginError(error) ? undefined : error,
    )
  }

  let instance
  try {
    instance = definition.create(config)
  } catch (error) {
    throw pluginError(
      `provider "${definition.id}" failed to initialize: ${stripPluginPrefix(messageOf(error))}`,
      isPluginError(error) ? undefined : error,
    )
  }

  assertProviderInstance(instance, definition.id)
  return { definition, config, instance }
}

/** Validate the runtime object a provider factory returned. */
export function assertProviderInstance(instance, id) {
  if (!isPlainObject(instance)) throw pluginError(`provider "${id}" create(config) must return an object`)
  for (const method of ['status', 'search']) {
    if (typeof instance[method] !== 'function') {
      throw pluginError(`provider "${id}" must implement ${method}()`)
    }
  }
  for (const method of ['ready', 'searchMany', 'toolTimeoutMs', 'dispose']) {
    if (instance[method] !== undefined && typeof instance[method] !== 'function') {
      throw pluginError(`provider "${id}" ${method} must be a function when present`)
    }
  }
  return instance
}

/**
 * Read a provider's synchronous availability report. `status()` runs often
 * (provider pickers, tool preflight), so it must be cheap and side-effect free.
 */
export function readProviderStatus(entry) {
  let status
  try {
    status = entry.instance.status()
  } catch (error) {
    throw pluginError(
      `provider "${entry.definition.id}" could not report its status: ${stripPluginPrefix(messageOf(error))}`,
      isPluginError(error) ? undefined : error,
    )
  }
  if (!isPlainObject(status) || typeof status.available !== 'boolean') {
    throw pluginError(`provider "${entry.definition.id}" status() must return { available: boolean, reason?: string }`)
  }
  return {
    available: status.available,
    ...(trimmedString(status.reason) === undefined ? {} : { reason: status.reason.trim() }),
  }
}
