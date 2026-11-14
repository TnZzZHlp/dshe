import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'

import { abortError, messageOf, pluginError } from '../lib/errors.js'
import { boundedStderr, runProcess } from '../lib/process.js'
import { combineSignals } from '../lib/signals.js'
import { SlotPool } from '../lib/slot-pool.js'
import {
  MAX_PROVIDER_SOURCES,
  mergeSearchResults,
  normalizeSearchResult,
} from '../lib/search.js'
import {
  clampMaxResults,
  existsAsFile,
  isExecutableFile,
  isPlainObject,
  trimmedString,
  uniquePaths,
} from '../lib/values.js'

export const AGY_PROVIDER_ID = 'agy'
export const AGY_SEARCH_TOOL = 'search_web'
export const AGY_DEFAULTS = {
  effort: 'low',
  timeoutMs: 120_000,
  maxResults: 6,
  maxConcurrent: 3,
}
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const CONFIG_KEYS = [
  'enabled',
  'agyPath',
  'home',
  'sourceHome',
  'effort',
  'model',
  'logFile',
  'extraArgs',
  'timeoutMs',
  'maxResults',
  'maxConcurrent',
]
const RUNTIME_BASE_NAME = 'agent-websearch-home'
const AGY_LOGIN_FILE = 'antigravity-oauth-token'
const AGY_INSTALLATION_FILE = 'installation_id'

const AGY_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    answer: {
      type: 'string',
      description: 'Concise answer to the query in the query language, at most 3 sentences, plain text.',
    },
    results: {
      type: 'array',
      description: 'Search results ordered by relevance.',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short page title.' },
          url: { type: 'string', description: 'Canonical http(s) URL returned by the search.' },
          snippet: { type: 'string', description: 'One-sentence summary or quote from the page.' },
        },
        required: ['title', 'url', 'snippet'],
        additionalProperties: false,
      },
    },
  },
  required: ['answer', 'results'],
  additionalProperties: false,
}
const AGY_OUTPUT_SCHEMA_JSON = JSON.stringify(AGY_OUTPUT_SCHEMA)

function assertString(value, key, { allowEmpty = false } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && value.trim().length === 0)) {
    throw pluginError(`agy provider config "${key}" must be a non-empty string`)
  }
  return allowEmpty ? value : value.trim()
}

function integerInRange(value, { key, min, max }) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw pluginError(`agy provider config "${key}" must be an integer between ${min} and ${max}`)
  }
  return value
}

function resolvePathValue(value, key) {
  const text = assertString(value, key)
  try {
    return path.resolve(text)
  } catch (error) {
    throw pluginError(`agy provider config "${key}" is not a valid path: ${messageOf(error)}`, error)
  }
}

/** Validate the provider's own config section and apply defaults. */
export function normalizeConfig(raw) {
  if (!isPlainObject(raw)) throw pluginError('agy provider config must be an object')
  for (const key of Object.keys(raw)) {
    if (!CONFIG_KEYS.includes(key)) {
      throw pluginError(`agy provider config has unknown key "${key}"; supported keys: ${CONFIG_KEYS.join(', ')}`)
    }
  }

  const config = { ...AGY_DEFAULTS }

  if (raw.agyPath !== undefined) config.agyPath = resolvePathValue(raw.agyPath, 'agyPath')
  if (raw.home !== undefined) config.home = resolvePathValue(raw.home, 'home')
  if (raw.sourceHome !== undefined) config.sourceHome = resolvePathValue(raw.sourceHome, 'sourceHome')
  if (raw.effort !== undefined) {
    if (typeof raw.effort !== 'string' || !EFFORTS.includes(raw.effort)) {
      throw pluginError(`agy provider config "effort" must be one of: ${EFFORTS.join(', ')}`)
    }
    config.effort = raw.effort
  }
  if (raw.model !== undefined) config.model = assertString(raw.model, 'model')
  if (raw.logFile !== undefined) config.logFile = resolvePathValue(raw.logFile, 'logFile')
  if (raw.extraArgs !== undefined) {
    if (!Array.isArray(raw.extraArgs)) {
      throw pluginError('agy provider config "extraArgs" must be an array of strings')
    }
    for (const [index, value] of raw.extraArgs.entries()) {
      if (typeof value !== 'string') {
        throw pluginError(`agy provider config "extraArgs[${index}]" must be a string`)
      }
    }
    config.extraArgs = [...raw.extraArgs]
  }
  if (raw.timeoutMs !== undefined) {
    config.timeoutMs = integerInRange(raw.timeoutMs, { key: 'timeoutMs', min: 10_000, max: 900_000 })
  }
  if (raw.maxResults !== undefined) {
    config.maxResults = integerInRange(raw.maxResults, { key: 'maxResults', min: 1, max: 10 })
  }
  if (raw.maxConcurrent !== undefined) {
    config.maxConcurrent = integerInRange(raw.maxConcurrent, { key: 'maxConcurrent', min: 1, max: 5 })
  }
  return config
}

function agyConfigDirIn(home) {
  return path.join(home, '.gemini', 'antigravity-cli')
}

function tokenPathIn(home) {
  return path.join(agyConfigDirIn(home), AGY_LOGIN_FILE)
}

function installationPathIn(home) {
  return path.join(agyConfigDirIn(home), AGY_INSTALLATION_FILE)
}

function hasLogin(home) {
  return existsAsFile(tokenPathIn(home))
}

function dshHomeDir() {
  const explicit = trimmedString(process.env.DSH_HOME)
  if (explicit !== undefined) return path.resolve(explicit)
  const profileDir = trimmedString(process.env.DSH_PROFILE_DIR)
  if (profileDir !== undefined) return path.dirname(path.resolve(profileDir))
  return undefined
}

/** Locate the agy CLI: explicit config, env override, PATH, common install dirs. */
export function resolveAgyPath(config) {
  const candidates = []
  if (config.agyPath !== undefined) candidates.push(config.agyPath)
  const envBinary = trimmedString(process.env.AGY_BIN)
  if (envBinary !== undefined) candidates.push(envBinary)
  const pathEnv = process.env.PATH ?? ''
  for (const dir of pathEnv.split(path.delimiter)) {
    if (dir.length === 0) continue
    candidates.push(path.join(dir, 'agy'), path.join(dir, 'agy.exe'))
  }
  const home = homedir()
  candidates.push(path.join(home, '.local', 'bin', 'agy'))
  candidates.push('/root/.local/bin/agy', '/usr/local/bin/agy', '/usr/bin/agy')
  for (const candidate of uniquePaths(candidates)) {
    if (isExecutableFile(candidate)) return candidate
  }
  return undefined
}

function sourceHomeCandidates(config) {
  return uniquePaths([
    config.sourceHome,
    trimmedString(process.env.AGY_SOURCE_HOME),
    '/root',
    homedir(),
  ])
}

/** Find a HOME directory that already holds an agy login. */
export function findSourceHome(config) {
  for (const candidate of sourceHomeCandidates(config)) {
    if (hasLogin(candidate)) return candidate
  }
  return undefined
}

function copyFileIfNeeded(source, target, mode) {
  if (!existsAsFile(source)) return false
  try {
    const sourceStat = statSync(source)
    if (existsAsFile(target)) {
      const targetStat = statSync(target)
      if (targetStat.size === sourceStat.size && targetStat.mtimeMs >= sourceStat.mtimeMs) {
        try {
          chmodSync(target, mode)
        } catch {}
        return false
      }
    }
    const buffer = readFileSync(source)
    mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
    writeFileSync(target, buffer, { mode })
    chmodSync(target, mode)
    return true
  } catch (error) {
    throw pluginError(`could not seed agy state from ${source}: ${messageOf(error)}`, error)
  }
}

/** Copy agy login state into a runtime HOME (target may be a slot directory). */
function seedRuntimeHome(sourceHome, targetHome, { forceTarget = false } = {}) {
  mkdirSync(agyConfigDirIn(targetHome), { recursive: true, mode: 0o700 })
  const sourceConfig = agyConfigDirIn(sourceHome)
  const targetConfig = agyConfigDirIn(targetHome)
  copyFileIfNeeded(path.join(sourceConfig, AGY_LOGIN_FILE), path.join(targetConfig, AGY_LOGIN_FILE), 0o600)
  copyFileIfNeeded(
    path.join(sourceConfig, AGY_INSTALLATION_FILE),
    path.join(targetConfig, AGY_INSTALLATION_FILE),
    0o600,
  )
  if (forceTarget && !hasLogin(targetHome)) {
    throw pluginError(
      `could not seed agy login into ${targetHome}: agy login files were not found in ${sourceHome}`,
    )
  }
}

/**
 * Owns the writable HOME layout used by agy runs. The layout is intentionally
 * generic, so a provider such as a future CLI wrapper can reuse the same
 * seeding idea, but agy-specific paths stay in this module.
 */
class AgyRuntime {
  constructor(config) {
    this.config = config
    this.base = undefined
    this.slotHomes = new Map()
    this.pool = undefined
    this.sourceHome = undefined
  }

  refreshSource() {
    this.sourceHome = findSourceHome(this.config)
    return this.sourceHome
  }

  writableBase() {
    if (this.base !== undefined) return this.base
    if (this.config.home !== undefined) {
      this.base = { home: this.config.home, isolated: false, explicit: true }
      return this.base
    }
    const dshHome = dshHomeDir()
    const candidates = []
    if (dshHome !== undefined) candidates.push(path.join(dshHome, RUNTIME_BASE_NAME))
    candidates.push(path.join(tmpdir(), `dsh-${RUNTIME_BASE_NAME}`))
    for (const candidate of candidates) {
      try {
        mkdirSync(candidate, { recursive: true, mode: 0o700 })
        this.base = { home: candidate, isolated: true, explicit: false }
        return this.base
      } catch {}
    }
    const source = this.refreshSource()
    if (source !== undefined) {
      this.base = { home: source, isolated: false, explicit: false }
      return this.base
    }
    throw pluginError(
      'no writable HOME for agy: set providers.agy.home to a writable directory (a seeded copy of your agy login is created there)',
    )
  }

  concurrency() {
    const base = this.writableBase()
    if (base.explicit || !base.isolated) return 1
    return Math.min(this.config.maxConcurrent, 5)
  }

  isIsolatedBase() {
    return this.writableBase().isolated === true
  }

  homeForSlot(slot) {
    if (this.config.home !== undefined) return this.config.home
    const base = this.writableBase()
    if (!base.isolated) return base.home
    let home = this.slotHomes.get(slot)
    if (home === undefined) {
      home = path.join(base.home, `slot-${slot + 1}`)
      this.slotHomes.set(slot, home)
    }
    return home
  }

  seedIfNeeded(home) {
    if (hasLogin(home)) {
      this.refreshSource()
      return home
    }
    const source = this.refreshSource()
    if (source === undefined) {
      throw pluginError(
        `agy is not logged in on this machine: no agy login was found in ${sourceHomeCandidates(this.config).join(', ')}; ` +
          'run the agy CLI once to log in, or set providers.agy.sourceHome to a HOME directory that contains the agy login',
      )
    }
    seedRuntimeHome(source, home, { forceTarget: true })
    return home
  }

  ensurePool() {
    if (this.pool === undefined) this.pool = new SlotPool(this.concurrency())
    return this.pool
  }
}

function extractUrlsFromText(text) {
  const urls = []
  const pattern = /https?:\/\/[^\s<>"'`)\]]+/g
  for (const match of String(text).matchAll(pattern)) {
    let url = match[0]
    while (/[.,;:!?]$/.test(url)) url = url.slice(0, -1)
    if (url.length > 0) urls.push(url)
  }
  return urls
}

function parseJsonObjectText(text) {
  if (typeof text !== 'string') return undefined
  const candidates = [text]
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence !== null) candidates.push(fence[1])
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1))
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate)
      if (isPlainObject(parsed)) return parsed
    } catch {}
  }
  return undefined
}

function cleanAnswer(value) {
  let text = trimmedString(value) ?? ''
  const fence = text.match(/```(?:json|text|markdown)?\s*([\s\S]*?)```/i)
  if (fence !== null) text = fence[1].trim()
  if (text.startsWith('{')) {
    const parsed = parseJsonObjectText(text)
    if (parsed !== undefined) {
      text = trimmedString(parsed.answer) ?? trimmedString(parsed.summary) ?? ''
    }
  }
  return text
}

function normalizeEntrySource(entry) {
  if (typeof entry === 'string') {
    const url = entry.trim()
    return /^https?:\/\//i.test(url) ? { url } : undefined
  }
  if (!isPlainObject(entry)) return undefined
  const url = trimmedString(entry.url) ?? trimmedString(entry.link)
  if (url === undefined || !/^https?:\/\//i.test(url)) return undefined
  const source = { url }
  const title = trimmedString(entry.title)
  if (title !== undefined) source.title = title
  const snippet = trimmedString(entry.snippet)
  if (snippet !== undefined) source.snippet = snippet
  return source
}

/** Turn agy's structured payload into sources plus an optional answer. */
export function normalizeResultPayload(payload) {
  if (!isPlainObject(payload)) return { sources: [], truncated: false }
  let answer = cleanAnswer(payload.answer)
  if (answer.length === 0) answer = cleanAnswer(payload.summary)

  let results = payload.results
  if (typeof results === 'string') {
    try {
      results = JSON.parse(results)
    } catch {
      results = []
    }
  }

  const sources = []
  const seen = new Set()
  let dropped = false
  for (const entry of Array.isArray(results) ? results : []) {
    const source = normalizeEntrySource(entry)
    if (source === undefined || seen.has(source.url)) continue
    seen.add(source.url)
    if (sources.length >= MAX_PROVIDER_SOURCES) {
      dropped = true
      continue
    }
    sources.push(source)
  }

  if (sources.length === 0 && answer.length > 0) {
    for (const url of extractUrlsFromText(answer)) {
      if (seen.has(url)) continue
      seen.add(url)
      if (sources.length >= MAX_PROVIDER_SOURCES) {
        dropped = true
        continue
      }
      sources.push({ url })
    }
  }

  return {
    ...(answer.length === 0 ? {} : { content: answer }),
    sources,
    truncated: dropped,
  }
}

function describeStatusDetails(envelope) {
  const details = []
  if (typeof envelope.error === 'string' && envelope.error.trim().length > 0) {
    details.push(envelope.error.trim())
  }
  if (Array.isArray(envelope.denied_actions) && envelope.denied_actions.length > 0) {
    for (const action of envelope.denied_actions) {
      if (isPlainObject(action)) {
        const name = trimmedString(action.name) ?? trimmedString(action.tool)
        const reason = trimmedString(action.reason)
        details.push([name, reason].filter(Boolean).join(': '))
      } else if (typeof action === 'string') {
        details.push(action)
      }
    }
  }
  return details.length === 0 ? '' : `: ${details.join('; ')}`
}

/** Parse agy's JSON envelope into a normalized search result. */
export function parseAgyEnvelope(stdout) {
  const text = typeof stdout === 'string' ? stdout.trim() : ''
  if (text.length === 0) throw pluginError('agy returned no output')
  let envelope
  try {
    envelope = JSON.parse(text)
  } catch {
    throw pluginError(`agy returned non-JSON output: ${text.slice(0, 200)}`)
  }
  if (!isPlainObject(envelope)) throw pluginError('agy returned a non-object JSON envelope')

  const status = envelope.status
  if (typeof status === 'string' && status !== 'SUCCESS') {
    throw pluginError(`agy search failed with status ${status}${describeStatusDetails(envelope)}`)
  }

  let payload = envelope.structured_output
  if (payload === undefined || payload === null) payload = envelope.response
  if (payload === undefined || payload === null) payload = envelope.content
  if (payload === undefined || payload === null) {
    throw pluginError('agy returned no structured result; check the agy version and --json-schema support')
  }
  if (typeof payload === 'string') {
    const parsed = parseJsonObjectText(payload)
    if (parsed === undefined) {
      throw pluginError(`agy returned an unparsable structured result: ${payload.slice(0, 200)}`)
    }
    payload = parsed
  }
  if (!isPlainObject(payload)) throw pluginError('agy returned a structured result that is not a JSON object')

  const result = normalizeResultPayload(payload)
  if (result.content === undefined && result.sources.length === 0) {
    throw pluginError(
      'agy search returned neither an answer nor usable source URLs; ' +
        'the search tool may have been denied, or the query returned no results' +
        boundedStderr(envelope.stderr),
    )
  }
  return result
}

/** Force agy to make exactly one built-in search_web call. */
export function buildPrompt(query, config) {
  const resultCount = Math.max(2, Math.min(config.maxResults, 5))
  return [
    `Search the web for the query ${JSON.stringify(query)}.`,
    '',
    `Call the built-in ${AGY_SEARCH_TOOL} tool exactly once, with the JSON-quoted query above, and do not call any other tool.`,
    'Do not run shell commands and do not read or write files.',
    '',
    'Then reply with a JSON object containing:',
    '- "answer": a concise answer in the same language as the query, at most 3 sentences, plain text without JSON or code fences.',
    `- "results": exactly ${resultCount} entries, each with "title", a canonical "url", and a one-sentence "snippet".`,
    'Use only URLs returned by the search and do not invent URLs.',
  ].join('\n')
}

export function buildArgs(query, config) {
  const args = [
    '-p',
    buildPrompt(query, config),
    '--output-format',
    'json',
    '--json-schema',
    AGY_OUTPUT_SCHEMA_JSON,
    '--settings',
    JSON.stringify({ permissions: { allow: [AGY_SEARCH_TOOL] } }),
  ]
  if (config.model !== undefined) args.push('--model', config.model)
  else args.push('--effort', config.effort)
  if (config.logFile !== undefined) args.push('--log-file', config.logFile)
  args.push(...(config.extraArgs ?? []))
  return args
}

async function runAgySearch({ executable, home, query, config, signal, onSpawn }) {
  const outcome = await runProcess(executable, buildArgs(query, config), {
    cwd: home,
    env: { ...process.env, HOME: home },
    timeoutMs: config.timeoutMs,
    signal,
    stdoutCap: 2_000_000,
    stderrCap: 200_000,
    onSpawn,
  })
  if (outcome.aborted) throw abortError()
  if (outcome.timedOut) {
    throw pluginError(`agy search timed out after ${Math.round(config.timeoutMs / 1000)}s`)
  }
  if (outcome.code !== 0) {
    throw pluginError(`agy exited with code ${outcome.code}${boundedStderr(outcome.stderr)}`)
  }
  return parseAgyEnvelope(outcome.stdout)
}

/**
 * Create the agy provider runtime. agy remains one provider among potentially
 * many; nothing here leaks into config validation or the generic tool.
 */
export function create(config) {
  const runtime = new AgyRuntime(config)
  const activeChildren = new Set()
  const disposed = new AbortController()
  let modelSource

  function status() {
    const executable = resolveAgyPath(config)
    if (executable === undefined) {
      return {
        available: false,
        reason:
          'the agy CLI was not found; install agy, add it to PATH, set AGY_BIN, or set providers.agy.agyPath',
      }
    }
    if (config.home !== undefined && hasLogin(config.home)) return { available: true }
    if (findSourceHome(config) !== undefined) return { available: true }
    return {
      available: false,
      reason:
        'agy is not logged in on this machine; run the agy CLI once to log in, or set providers.agy.sourceHome ' +
        'to a HOME directory that contains the agy login',
    }
  }

  function normalizeProviderResult(value, maxResults) {
    const limit = clampMaxResults(maxResults, MAX_PROVIDER_SOURCES) ?? config.maxResults
    return normalizeSearchResult(value, { maxResults: limit })
  }

  async function listModels(signal) {
    const current = status()
    if (!current.available) throw pluginError(`agy provider is not available: ${current.reason}`)
    const executable = resolveAgyPath(config)
    if (executable === undefined) throw pluginError('agy provider is not available: the agy CLI disappeared from PATH')
    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(), 30_000)
    timer.unref?.()
    const combined = combineSignals(signal, timeout.signal, disposed.signal)
    let slot
    let home
    let pool
    try {
      pool = runtime.ensurePool()
      slot = await pool.acquire(combined.signal)
      home = mkdtempSync(path.join(tmpdir(), 'dsh-agy-models-'))
      const source = config.home !== undefined && hasLogin(config.home) ? config.home : findSourceHome(config)
      if (source === undefined) throw pluginError('agy is not logged in on this machine')
      seedRuntimeHome(source, home, { forceTarget: true })
      const outcome = await runProcess(executable, ['models'], {
        cwd: home,
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          XDG_CONFIG_HOME: path.join(home, '.config'),
          XDG_CACHE_HOME: path.join(home, '.cache'),
          XDG_DATA_HOME: path.join(home, '.local', 'share'),
        },
        signal: combined.signal,
        stdoutCap: 256_000,
        stderrCap: 4_000,
        onSpawn(child) {
          activeChildren.add(child)
          child.once('close', () => activeChildren.delete(child))
        },
      })
      if (outcome.aborted) throw abortError()
      if (outcome.code !== 0) throw pluginError(`agy models exited with code ${outcome.code}`)
      if (outcome.stdout.length >= 256_000) throw pluginError('agy models output exceeded the size limit')
      const models = []
      const seen = new Set()
      for (const line of outcome.stdout.split(/\r?\n/)) {
        if (line.trim() === '') continue
        const fields = line.split('\t')
        if (fields.length !== 2 || !fields[0].trim() || !fields[1].trim()) {
          throw pluginError('agy models returned an invalid model list')
        }
        const id = fields[0].trim()
        const name = fields[1].trim()
        if (seen.has(id)) throw pluginError('agy models returned duplicate model ids')
        seen.add(id)
        models.push({ id, name })
      }
      return { models }
    } catch (error) {
      if (timeout.signal.aborted && !signal?.aborted) throw pluginError('agy models timed out after 30s')
      throw error
    } finally {
      clearTimeout(timer)
      combined.dispose()
      try {
        if (home !== undefined) rmSync(home, { recursive: true, force: true })
      } finally {
        if (slot !== undefined) pool.release(slot)
      }
    }
  }

  async function searchOne(request, signal) {
    const query = trimmedString(request?.query)
    if (query === undefined) throw pluginError('agy provider received an empty query')
    const current = status()
    if (!current.available) {
      throw pluginError(`agy provider is not available: ${current.reason ?? 'unknown reason'}`)
    }
    const executable = resolveAgyPath(config)
    if (executable === undefined) {
      throw pluginError('agy provider is not available: the agy CLI disappeared from PATH')
    }

    const model = modelSource === undefined ? config.model : trimmedString(modelSource.get())
    const searchConfig = { ...config, model }
    const pool = runtime.ensurePool()
    const slot = await pool.acquire(signal)
    try {
      const home = runtime.homeForSlot(slot)
      runtime.seedIfNeeded(home)
      const value = await runAgySearch({
        executable,
        home,
        query,
        config: searchConfig,
        signal,
        onSpawn(child) {
          activeChildren.add(child)
          child.once('close', () => activeChildren.delete(child))
        },
      })
      return normalizeProviderResult(value, request?.maxResults)
    } finally {
      pool.release(slot)
    }
  }

  async function searchMany(request, signal) {
    if (!Array.isArray(request?.queries)) throw pluginError('agy provider received no queries')
    const queries = []
    for (const value of request.queries) {
      const query = trimmedString(value)
      if (query !== undefined) queries.push(query)
    }
    if (queries.length === 0) throw pluginError('agy provider received no non-empty queries')
    const maxResults = clampMaxResults(request.maxResults, MAX_PROVIDER_SOURCES) ?? config.maxResults
    if (queries.length === 1) return searchOne({ query: queries[0], maxResults }, signal)
    if (signal?.aborted) throw abortError()

    const controller = new AbortController()
    const combined = combineSignals(signal, controller.signal)
    let failure
    const tasks = queries.map(async query => {
      try {
        return await searchOne({ query, maxResults }, combined.signal)
      } catch (error) {
        if (failure === undefined) failure = error
        controller.abort()
        throw error
      }
    })
    const settled = await Promise.allSettled(tasks)
    combined.dispose()
    if (failure !== undefined) throw failure
    const results = settled.map(item => item.value)
    return mergeSearchResults(queries, results, maxResults)
  }

  function toolTimeoutMs(maxQueries = 3) {
    const lanes = config.home !== undefined ? 1 : Math.min(config.maxConcurrent, 5)
    const waves = Math.ceil(Math.max(1, maxQueries) / Math.max(1, lanes))
    return Math.max(60_000, config.timeoutMs * waves + 30_000)
  }

  return {
    status,
    setModelSource(source) {
      modelSource = source
    },
    async ready() {
      return status().available
    },
    search: searchOne,
    searchMany,
    listModels,
    toolTimeoutMs,
    dispose() {
      disposed.abort()
      for (const child of activeChildren) {
        try {
          child.kill('SIGTERM')
        } catch {}
      }
      activeChildren.clear()
    },
  }
}

export const agyProvider = {
  id: AGY_PROVIDER_ID,
  title: 'agy (local CLI)',
  description: {
    en: 'Runs the local agy (Google Antigravity) CLI: one built-in search_web call per query, in an isolated writable HOME seeded from your agy login. Requires an installed and logged-in agy.',
    zh: '调用本机 agy（Google Antigravity）CLI：每个查询一次内置 search_web 调用，使用从你的 agy 登录状态播种的隔离可写 HOME。需要已安装并登录 agy。',
  },
  normalizeConfig,
  create,
}

export default agyProvider
