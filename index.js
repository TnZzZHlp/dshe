import { pluginError } from './lib/errors.js'
import { normalizeConfig } from './lib/config.js'
import { readProviderStatus } from './lib/provider.js'
import { createToolDefinition } from './lib/tool.js'
import { clampMaxResults, isPlainObject } from './lib/values.js'
import { MAX_PROVIDER_SOURCES, normalizeSearchResult } from './lib/search.js'
import { providers as builtinProviders } from './providers/index.js'

export const name = 'dsh-agent-websearch'
export const inject = ['web', 'tools']

function providerAvailable(entry) {
  try {
    return readProviderStatus(entry).available
  } catch {
    return false
  }
}

function createWebSearchProvider(entry) {
  const { definition, instance } = entry
  return {
    id: definition.id,
    title: definition.title,
    description: definition.description,
    available() {
      return providerAvailable(entry)
    },
    async ready() {
      if (typeof instance.ready === 'function') {
        try {
          return await instance.ready()
        } catch {
          return false
        }
      }
      return providerAvailable(entry)
    },
    async search(request, signal) {
      if (!isPlainObject(request) || typeof request.query !== 'string' || request.query.trim().length === 0) {
        throw pluginError(`web search provider "${definition.id}" received an empty query`)
      }
      const status = readProviderStatus(entry)
      if (!status.available) {
        throw pluginError(
          `web search provider "${definition.id}" is not available: ${status.reason ?? 'its local prerequisite is unavailable'}`,
        )
      }
      const query = request.query.trim()
      const maxResults = clampMaxResults(request.maxResults, MAX_PROVIDER_SOURCES)
      const value = await instance.search(
        { query, ...(maxResults === undefined ? {} : { maxResults }) },
        signal,
      )
      return normalizeSearchResult(value, {
        ...(maxResults === undefined ? {} : { maxResults }),
      })
    },
  }
}

/**
 * Register every enabled provider with the web runtime, plus one dedicated
 * provider-neutral search tool. Provider instances own their resources; the
 * fiber effect below disposes them when the plugin is unloaded or reloaded.
 */
export function apply(ctx, rawConfig = {}) {
  const config = normalizeConfig(rawConfig, builtinProviders)
  for (const entry of config.entries) {
    ctx.web.registerSearchProvider(createWebSearchProvider(entry))
  }
  ctx.tools.register(createToolDefinition(config))

  const disposable = config.entries.filter(entry => typeof entry.instance.dispose === 'function')
  if (disposable.length > 0) {
    ctx.effect(function* () {
      yield () => {
        for (const entry of disposable) {
          try {
            entry.instance.dispose()
          } catch {
            // Cleanup must not mask the original fiber disposal. The host logs
            // plugin load failures; a failing best-effort kill is not fatal.
          }
        }
      }
    }, 'dsh-agent-websearch provider cleanup')
  }
}
