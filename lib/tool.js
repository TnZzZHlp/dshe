import { abortError, isAbortError, isPluginError, messageOf, pluginError } from './errors.js'
import { isPlainObject } from './values.js'
import { readProviderStatus } from './provider.js'
import { combineSignals } from './signals.js'
import {
  MAX_TOOL_SOURCES,
  SEARCH_RESULT_SCHEMA,
  formatSearchValue,
  mergeSearchResults,
  normalizeSearchResult,
  sourceLabel,
} from './search.js'

export const TOOL_NAME = 'agent_web_search'
const TOOL_KEYS = ['queries', 'provider', 'maxResults']

function providerIds(entries) {
  return entries.map(entry => entry.definition.id)
}

function queriesFromArgs(args) {
  if (!isPlainObject(args) || !Array.isArray(args.queries)) return undefined
  const queries = []
  for (const value of args.queries) {
    if (typeof value !== 'string') return undefined
    const query = value.trim()
    if (query.length > 0) queries.push(query)
  }
  return queries.length === 0 ? undefined : queries
}

function titleFromArgs(args) {
  const queries = queriesFromArgs(args)
  return queries === undefined ? TOOL_NAME : queries.join(', ')
}

function resolveProviderEntry(entries, requested) {
  const entry = entries.find(item => item.definition.id === requested)
  if (entry === undefined) {
    throw pluginError(
      `${TOOL_NAME}: unknown search provider "${requested}"; available providers: ${providerIds(entries).join(', ')}`,
    )
  }
  return entry
}

function parseToolArgs(args, config, entries, defaultProvider) {
  if (!isPlainObject(args)) throw pluginError(`${TOOL_NAME}: arguments must be an object`)
  for (const key of Object.keys(args)) {
    if (!TOOL_KEYS.includes(key)) {
      throw pluginError(`${TOOL_NAME}: unknown argument "${key}"; supported arguments: ${TOOL_KEYS.join(', ')}`)
    }
  }

  if (!Array.isArray(args.queries)) {
    throw pluginError(`${TOOL_NAME}: "queries" must be an array of 1-${config.tool.maxQueries} non-empty strings`)
  }
  if (args.queries.length === 0 || args.queries.length > config.tool.maxQueries) {
    throw pluginError(`${TOOL_NAME}: "queries" must contain 1-${config.tool.maxQueries} queries (received ${args.queries.length})`)
  }

  const queries = []
  const seen = new Set()
  for (const value of args.queries) {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw pluginError(`${TOOL_NAME}: every query must be a non-empty string`)
    }
    const query = value.trim()
    if (seen.has(query)) continue
    seen.add(query)
    queries.push(query)
  }

  let provider = defaultProvider
  if (args.provider !== undefined) {
    if (typeof args.provider !== 'string' || args.provider.trim().length === 0) {
      throw pluginError(`${TOOL_NAME}: "provider" must be a non-empty provider id; available providers: ${providerIds(entries).join(', ')}`)
    }
    provider = args.provider.trim()
    resolveProviderEntry(entries, provider)
  }

  let maxResults
  if (args.maxResults !== undefined) {
    if (!Number.isInteger(args.maxResults) || args.maxResults < 1 || args.maxResults > MAX_TOOL_SOURCES) {
      throw pluginError(`${TOOL_NAME}: "maxResults" must be an integer between 1 and ${MAX_TOOL_SOURCES}`)
    }
    maxResults = args.maxResults
  }

  return {
    queries,
    provider,
    ...(maxResults === undefined ? {} : { maxResults }),
  }
}

async function searchInParallel(instance, queries, maxResults, signal) {
  const controller = new AbortController()
  const combined = combineSignals(signal, controller.signal)
  let failure
  const runs = queries.map(async query => {
    try {
      const value = await instance.search({ query, maxResults }, combined.signal)
      return normalizeSearchResult(value, { maxResults })
    } catch (error) {
      if (failure === undefined) failure = error
      controller.abort()
      throw error
    }
  })
  const settled = await Promise.allSettled(runs)
  combined.dispose()
  if (failure !== undefined) throw failure
  const results = settled.map(item => item.value)
  return mergeSearchResults(queries, results, maxResults)
}

async function runProviderSearch(entry, request, signal) {
  const instance = entry.instance
  try {
    if (typeof instance.searchMany === 'function') {
      return normalizeSearchResult(await instance.searchMany(request, signal), {
        maxResults: request.maxResults,
      })
    }
    if (request.queries.length === 1) {
      return normalizeSearchResult(
        await instance.search({ query: request.queries[0], maxResults: request.maxResults }, signal),
        { maxResults: request.maxResults },
      )
    }
    return searchInParallel(instance, request.queries, request.maxResults, signal)
  } catch (error) {
    if (isPluginError(error) || isAbortError(error)) throw error
    throw pluginError(`provider "${entry.definition.id}" search failed: ${messageOf(error)}`, error)
  }
}

function narrowSources(sources) {
  const result = []
  const seen = new Set()
  for (const source of Array.isArray(sources) ? sources : []) {
    if (!isPlainObject(source) || typeof source.url !== 'string' || seen.has(source.url)) continue
    seen.add(source.url)
    const narrowed = { url: source.url }
    for (const key of ['title', 'snippet', 'publishedAt']) {
      if (typeof source[key] === 'string' && source[key].trim().length > 0) {
        narrowed[key] = source[key].trim()
      }
    }
    result.push(narrowed)
  }
  return result
}

function toolTimeoutMs(config, entries) {
  if (config.tool.timeoutMs !== undefined) return config.tool.timeoutMs
  const hints = []
  for (const entry of entries) {
    if (typeof entry.instance.toolTimeoutMs !== 'function') continue
    try {
      const hint = entry.instance.toolTimeoutMs(config.tool.maxQueries)
      if (Number.isFinite(hint) && hint > 0) hints.push(hint)
    } catch {}
  }
  return Math.max(120_000, ...hints)
}

function describeProviders(entries) {
  return entries
    .map(entry => `${entry.definition.id} (${entry.definition.title})`)
    .join(', ')
}

/**
 * Build the dedicated provider-neutral search tool. The tool resolves the
 * provider at execution time, because provider availability (a local CLI login,
 * for example) can change while the host is running.
 */
export function createToolDefinition(config) {
  const { entries, provider: defaultProvider } = config
  const providerList = providerIds(entries)
  const timeoutMs = toolTimeoutMs(config, entries)

  return {
    name: TOOL_NAME,
    description:
      `Search the web through a local search provider registered by the dsh-agent-websearch bundle. ` +
      `Registered providers: ${describeProviders(entries)}. ` +
      `Each query runs the provider locally (agy takes roughly 15-30 seconds); multiple queries run in parallel and their results are merged. ` +
      `Returns an optional synthesized answer plus source URLs with titles and snippets. ` +
      `Use this tool to select a provider explicitly or when the built-in web_search is unavailable; ` +
      `when the built-in web_search already uses the provider you want, prefer it.`,
    parameters: {
      type: 'object',
      properties: {
        queries: {
          type: 'array',
          description: `Search queries to run; 1-${config.tool.maxQueries} queries are allowed and duplicates are ignored.`,
          items: { type: 'string', description: 'One non-empty search query.' },
          minItems: 1,
          maxItems: config.tool.maxQueries,
        },
        provider: {
          type: 'string',
          description: `Optional search provider id: ${providerList.join(', ')}. Defaults to "${defaultProvider}".`,
          enum: providerList,
        },
        maxResults: {
          type: 'integer',
          description: `Maximum number of source URLs to return (1-${MAX_TOOL_SOURCES}); defaults to ${config.tool.maxResults}.`,
          minimum: 1,
          maximum: MAX_TOOL_SOURCES,
        },
      },
      required: ['queries'],
      additionalProperties: false,
    },
    output: {
      schema: SEARCH_RESULT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: formatSearchValue(value) }],
      presentationMeta: (_args, value) => ({
        sources: narrowSources(value.sources),
        truncated: value.truncated === true,
        ...(typeof value.content === 'string' ? { answer: value.content } : {}),
      }),
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    presentCall(args) {
      return {
        card: 'generic',
        title: titleFromArgs(args),
        kind: 'search',
        rawInput: isPlainObject(args) ? args : {},
      }
    },
    presentResult(args, result) {
      const meta = isPlainObject(result?.meta) ? result.meta : {}
      const queries = queriesFromArgs(args)
      return {
        card: 'web',
        title: queries === undefined ? TOOL_NAME : queries.join(', '),
        sources: narrowSources(meta.sources).map(source => ({
          ...source,
          title: sourceLabel(source),
        })),
        truncated: meta.truncated === true,
        ...(typeof meta.answer === 'string' && meta.answer.trim().length > 0
          ? { answer: meta.answer.trim() }
          : {}),
      }
    },
    async execute(args, exec) {
      if (exec?.signal?.aborted) throw abortError()
      const parsed = parseToolArgs(args, config, entries, defaultProvider)
      const entry = resolveProviderEntry(entries, parsed.provider)
      const status = readProviderStatus(entry)
      if (!status.available) {
        throw pluginError(
          `${TOOL_NAME} cannot use provider "${entry.definition.id}": ${status.reason ?? 'its local prerequisite is unavailable'}`,
        )
      }
      if (exec?.signal?.aborted) throw abortError()

      const request = {
        queries: parsed.queries,
        maxResults: parsed.maxResults ?? config.tool.maxResults,
      }
      const value = await runProviderSearch(entry, request, exec?.signal)
      return normalizeSearchResult(value, { maxResults: request.maxResults })
    },
  }
}
