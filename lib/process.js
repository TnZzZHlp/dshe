import { spawn } from 'node:child_process'
import { abortError, messageOf, pluginError } from './errors.js'

/**
 * Run one external CLI process and resolve a structured outcome instead of
 * throwing for timeouts or non-zero exits. Provider modules decide how those
 * outcomes map to user-facing errors.
 *
 * @param {string} executable
 * @param {string[]} args
 * @param {object} [options]
 * @param {string} [options.cwd]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {number} [options.timeoutMs]
 * @param {AbortSignal} [options.signal]
 * @param {number} [options.stdoutCap]
 * @param {number} [options.stderrCap]
 * @param {(child: import('node:child_process').ChildProcess) => void} [options.onSpawn]
 * @returns {Promise<{code: number|null, stdout: string, stderr: string, timedOut: boolean, aborted: boolean}>}
 */
export function runProcess(executable, args, options = {}) {
  const {
    cwd,
    env,
    timeoutMs,
    signal,
    stdoutCap = 2_000_000,
    stderrCap = 200_000,
    onSpawn,
  } = options

  return new Promise((resolve, reject) => {
    if (signal !== undefined && signal.aborted) {
      reject(abortError())
      return
    }

    let child
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    let aborted = false
    let timer
    let killTimer

    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer)
      if (killTimer !== undefined) clearTimeout(killTimer)
      signal?.removeEventListener('abort', onAbort)
    }

    const finish = (callback, value) => {
      if (settled) return
      settled = true
      cleanup()
      callback(value)
    }

    const terminate = () => {
      try {
        child?.kill('SIGTERM')
      } catch {}
      killTimer = setTimeout(() => {
        try {
          child?.kill('SIGKILL')
        } catch {}
      }, 5_000)
      killTimer.unref?.()
    }

    const onAbort = () => {
      aborted = true
      terminate()
    }

    try {
      child = spawn(executable, args, {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      reject(pluginError(`failed to start process "${executable}": ${messageOf(error)}`, error))
      return
    }

    child.stdout?.on('data', chunk => {
      if (stdout.length < stdoutCap) stdout += String(chunk)
    })
    child.stderr?.on('data', chunk => {
      if (stderr.length < stderrCap) stderr += String(chunk)
    })

    child.on('error', error => {
      finish(reject, pluginError(`failed to start process "${executable}": ${messageOf(error)}`, error))
    })
    child.on('close', code => {
      finish(resolve, { code, stdout, stderr, timedOut, aborted })
    })

    if (typeof onSpawn === 'function') {
      try {
        onSpawn(child)
      } catch {}
    }

    if (timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true
        terminate()
      }, timeoutMs)
      timer.unref?.()
    }

    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Keep the tail of CLI stderr for diagnostics. */
export function boundedStderr(stderr, limit = 1_200) {
  const text = typeof stderr === 'string' ? stderr.trim() : ''
  if (text.length === 0) return ''
  return `: ${text.length > limit ? text.slice(-limit) : text}`
}
