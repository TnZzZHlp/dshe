import { pluginError } from './errors.js'
import { readProviderStatus } from './provider.js'
import { clampMaxResults, isPlainObject } from './values.js'
import { MAX_PROVIDER_SOURCES, normalizeSearchResult } from './search.js'

function providerAvailable(entry) {
  try {
    return readProviderStatus(entry).available
  } catch {
    return false
  }
}

export function createWebSearchProvider(entry, recordSearch) {
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
      return recordSearch({ entry: 'web', provider: definition.id, queries: 1 }, signal, async () => {
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
      })
    },
  }
}

