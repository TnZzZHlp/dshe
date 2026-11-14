import { isAbortError } from './errors.js'

export function createSearchLogger(ctx) {
  let logger
  try {
    logger = ctx.logger('agent-websearch')
  } catch {}

  return async function recordSearch(details, signal, run) {
    const started = performance.now()
    let outcome = 'success'
    try {
      return await run()
    } catch (error) {
      outcome = signal?.aborted || isAbortError(error) ? 'cancelled' : 'failure'
      throw error
    } finally {
      try {
        const message = `entry=${details.entry} provider=${details.provider} queries=${details.queries} outcome=${outcome} durationMs=${Math.round(performance.now() - started)}`
        const result = outcome === 'success' ? logger?.info(message) : logger?.warn(message)
        if (result && typeof result.catch === 'function') result.catch(() => {})
      } catch {}
    }
  }
}
