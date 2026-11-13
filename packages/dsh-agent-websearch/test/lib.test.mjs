import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  PLUGIN_NAME,
  abortError,
  isAbortError,
  isPluginError,
  messageOf,
  pluginError,
  stripPluginPrefix,
  wrapError,
} from '../lib/errors.js'
import { clampMaxResults, existsAsFile, hostLabelFromUrl, isExecutableFile, isPlainObject, trimmedString, uniquePaths } from '../lib/values.js'
import { combineSignals } from '../lib/signals.js'
import { SlotPool } from '../lib/slot-pool.js'
import { boundedStderr, runProcess } from '../lib/process.js'
import {
  formatSearchValue,
  formatSourceLine,
  mergeSearchResults,
  normalizeSearchResult,
  sourceLabel,
} from '../lib/search.js'

const caught = async promise => {
  try {
    await promise
    return undefined
  } catch (error) {
    return error
  }
}

async function nextTick() {
  await new Promise(resolve => setImmediate(resolve))
}

test('plugin errors carry one stable name and prefix', () => {
  const error = pluginError('something failed')
  assert.ok(error instanceof Error)
  assert.equal(error.name, 'AgentWebSearchError')
  assert.equal(error.message, `[${PLUGIN_NAME}] something failed`)
  assert.equal(error.cause, undefined)
  const cause = new Error('inner')
  const chained = pluginError('outer', cause)
  assert.equal(chained.cause, cause)
  assert.equal(isPluginError(error), true)
  assert.equal(isPluginError(new Error('plain')), false)

  const aborted = abortError()
  assert.equal(aborted.name, 'AbortError')
  assert.equal(isAbortError(aborted), true)
  assert.equal(isAbortError(new Error('plain')), false)
  assert.equal(messageOf('text'), 'text')
  assert.equal(messageOf(new Error('boom')), 'boom')
  assert.equal(stripPluginPrefix(`[${PLUGIN_NAME}] inner`), 'inner')
  assert.equal(stripPluginPrefix('untouched'), 'untouched')
})

test('wrapError keeps a single plugin prefix', () => {
  const wrapped = wrapError('provider "agy" search failed', pluginError('inner failure'))
  assert.equal(wrapped.message, `[${PLUGIN_NAME}] provider "agy" search failed: inner failure`)

  const native = new Error('native failure')
  const wrappedNative = wrapError('outer', native)
  assert.equal(wrappedNative.message, `[${PLUGIN_NAME}] outer: native failure`)
  assert.equal(wrappedNative.cause, native)

  const abort = abortError('cancelled by the caller')
  const wrappedAbort = wrapError('outer', abort)
  assert.equal(wrappedAbort.message, `[${PLUGIN_NAME}] outer: cancelled by the caller`)
})

test('value helpers are defensive', () => {
  assert.equal(isPlainObject({}), true)
  assert.equal(isPlainObject([]), false)
  assert.equal(isPlainObject(null), false)
  assert.equal(trimmedString('  value  '), 'value')
  assert.equal(trimmedString('   '), undefined)
  assert.equal(trimmedString(7), undefined)
  assert.equal(clampMaxResults(3, 10), 3)
  assert.equal(clampMaxResults(0, 10), 1)
  assert.equal(clampMaxResults(14, 10), 10)
  assert.equal(clampMaxResults(2.5, 10), undefined)
  assert.equal(clampMaxResults('4', 10), undefined)
  assert.equal(hostLabelFromUrl('https://example.test/path'), 'example.test')
  assert.equal(hostLabelFromUrl('not a url'), 'not a url')
  assert.deepEqual(uniquePaths(['/a', '/a', undefined, '', './b']), ['/a', path.resolve('./b')])

  const root = mkdtempSync(path.join(tmpdir(), 'dsh-agent-websearch-values-'))
  try {
    const file = path.join(root, 'file.txt')
    writeFileSync(file, 'x')
    assert.equal(existsAsFile(file), true)
    assert.equal(existsAsFile(root), false)
    assert.equal(existsAsFile(path.join(root, 'missing')), false)
    assert.equal(isExecutableFile(file), false)
    const executable = path.join(root, 'executable.sh')
    writeFileSync(executable, '#!/bin/sh\nexit 0\n')
    chmodSync(executable, 0o755)
    assert.equal(isExecutableFile(executable), true)
    assert.equal(isExecutableFile(root), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('combineSignals propagates aborts and can be disposed', () => {
  assert.equal(combineSignals().signal, undefined)
  assert.equal(combineSignals(undefined, null).signal, undefined)

  const single = new AbortController()
  assert.equal(combineSignals(single.signal).signal, single.signal)

  const first = new AbortController()
  const second = new AbortController()
  const combined = combineSignals(first.signal, second.signal)
  assert.equal(combined.signal.aborted, false)
  first.abort()
  assert.equal(combined.signal.aborted, true)
  combined.dispose()
  second.abort()
  assert.equal(combined.signal.aborted, true)

  const fresh = new AbortController()
  const other = new AbortController()
  const disposable = combineSignals(fresh.signal, other.signal)
  disposable.dispose()
  other.abort()
  assert.equal(disposable.signal.aborted, false)

  const preAborted = new AbortController()
  preAborted.abort(new Error('already aborted'))
  const later = new AbortController()
  const pre = combineSignals(preAborted.signal, later.signal)
  assert.equal(pre.signal.aborted, true)
  pre.dispose()
})

test('SlotPool respects size, order, and abort while waiting', async () => {
  assert.throws(() => new SlotPool(0), /positive integer/)
  assert.throws(() => new SlotPool(1.5), /positive integer/)

  const pool = new SlotPool(1)
  const first = await pool.acquire()
  assert.equal(first, 0)

  const waiting = pool.acquire()
  await nextTick()
  pool.release(first)
  assert.equal(await waiting, 0)
  pool.release(0)

  const holder = await pool.acquire()
  const controller = new AbortController()
  const abortedWaiter = caught(pool.acquire(controller.signal))
  await nextTick()
  controller.abort()
  const error = await abortedWaiter
  assert.equal(error.name, 'AbortError')
  pool.release(holder)

  const alreadyAborted = new AbortController()
  alreadyAborted.abort()
  assert.equal((await caught(pool.acquire(alreadyAborted.signal))).name, 'AbortError')

  const unavailable = new SlotPool(1)
  const slot = await unavailable.acquire()
  const queued = unavailable.acquire()
  await nextTick()
  unavailable.release(slot)
  assert.equal(await queued, 0)
  unavailable.release(0)
})

test('runProcess resolves outcomes for success, failure, timeout, and abort', async () => {
  const success = await runProcess(process.execPath, ['-e', "process.stdout.write('out'); process.stderr.write('err')"])
  assert.deepEqual(
    { code: success.code, stdout: success.stdout, stderr: success.stderr, timedOut: success.timedOut, aborted: success.aborted },
    { code: 0, stdout: 'out', stderr: 'err', timedOut: false, aborted: false },
  )

  const failure = await runProcess(process.execPath, ['-e', "process.stdout.write('bad'); process.exit(3)"])
  assert.equal(failure.code, 3)
  assert.equal(failure.stdout, 'bad')

  const timedOut = await runProcess(process.execPath, ['-e', 'setTimeout(() => {}, 2000)'], { timeoutMs: 100 })
  assert.equal(timedOut.timedOut, true)
  assert.equal(timedOut.aborted, false)

  const controller = new AbortController()
  const running = runProcess(process.execPath, ['-e', 'setTimeout(() => {}, 2000)'])
  const spawned = new Promise(resolve => {
    setTimeout(resolve, 200)
  })
  const abortable = runProcess(process.execPath, ['-e', 'setTimeout(() => {}, 2000)'], { signal: controller.signal })
  await spawned
  controller.abort()
  const aborted = await abortable
  assert.equal(aborted.aborted, true)
  assert.equal(aborted.timedOut, false)
  await running

  const preAborted = new AbortController()
  preAborted.abort()
  const preError = await caught(runProcess(process.execPath, ['-e', 'process.exit(0)'], { signal: preAborted.signal }))
  assert.equal(preError.name, 'AbortError')

  const spawnError = await caught(runProcess(path.join(tmpdir(), 'definitely-missing-executable-dsh'), []))
  assert.match(spawnError.message, /failed to start process/)
})

test('boundedStderr trims and truncates the tail', () => {
  assert.equal(boundedStderr(undefined), '')
  assert.equal(boundedStderr('   '), '')
  assert.equal(boundedStderr('boom'), ': boom')
  assert.equal(boundedStderr('x'.repeat(10), 3), ': xxx')
})

test('normalizeSearchResult drops malformed sources and flags truncation', () => {
  const value = normalizeSearchResult({
    content: '  answer  ',
    truncated: true,
    sources: [
      { url: 'https://one.test', title: ' One ', snippet: ' s ', publishedAt: ' 2026 ' },
      { url: 'https://one.test' },
      { url: 'ftp://two.test' },
      { title: 'no url' },
      { url: 'https://three.test' },
    ],
  }, { maxResults: 1 })

  assert.equal(value.content, 'answer')
  assert.equal(value.sources.length, 1)
  assert.deepEqual(value.sources[0], {
    url: 'https://one.test',
    title: 'One',
    snippet: 's',
    publishedAt: '2026',
  })
  assert.equal(value.truncated, true)

  assert.deepEqual(normalizeSearchResult('nope'), { sources: [], truncated: false })
  assert.deepEqual(normalizeSearchResult({ sources: 'nope' }), { sources: [], truncated: false })
})

test('mergeSearchResults interleaves ranks and deduplicates by URL', () => {
  const first = {
    content: 'first answer',
    sources: [{ url: 'https://a.test' }, { url: 'https://b.test' }],
  }
  const second = {
    content: 'second answer',
    truncated: true,
    sources: [{ url: 'https://c.test' }, { url: 'https://a.test' }],
  }
  const merged = mergeSearchResults(['q1', 'q2'], [first, second], 3)

  assert.deepEqual(merged.sources.map(source => source.url), ['https://a.test', 'https://c.test', 'https://b.test'])
  assert.equal(merged.truncated, true)
  assert.equal(merged.content, '### q1\n\nfirst answer\n\n### q2\n\nsecond answer')

  const empty = mergeSearchResults(['q'], [{ sources: [] }], 5)
  assert.deepEqual(empty, { sources: [], truncated: false })
})

test('formats tool output and source labels', () => {
  const text = formatSearchValue({
    content: 'Answer.',
    truncated: true,
    sources: [
      { url: 'https://example.test/page', title: ' Example ', snippet: ' Snippet ', publishedAt: '2026-01-01' },
      { url: 'https://bare.test' },
    ],
  })
  assert.match(text, /External web content follows/)
  assert.match(text, /Answer\./)
  assert.match(text, /- \[Example\]\(https:\/\/example\.test\/page\) — Snippet \(2026-01-01\)/)
  assert.match(text, /- \[bare\.test\]\(https:\/\/bare\.test\)/)
  assert.match(text, /additional results existed but were omitted/)
  assert.match(text, /Cite the relevant source URLs above as markdown links/)

  const noSources = formatSearchValue({ sources: [], truncated: false })
  assert.match(noSources, /\(no source URLs were returned\)/)

  assert.equal(formatSourceLine({ url: 'https://bare.test' }), '- [bare.test](https://bare.test)')
  assert.equal(sourceLabel({ url: 'https://bare.test', title: ' Title ' }), 'Title')
  assert.equal(sourceLabel({ url: 'https://bare.test' }), 'bare.test')
})
