/**
 * Combine several AbortSignals into one disposable signal. Used when the host
 * supplies a signal (tool execution) and the provider adds its own failure
 * cancellation for parallel work.
 */
export function combineSignals(...signals) {
  const defined = signals.filter(signal => signal !== undefined && signal !== null)
  if (defined.length === 0) return { signal: undefined, dispose: () => {} }
  if (defined.length === 1) return { signal: defined[0], dispose: () => {} }

  const controller = new AbortController()
  const listeners = []
  for (const signal of defined) {
    if (signal.aborted) {
      controller.abort(signal.reason)
      break
    }
    const listener = () => controller.abort(signal.reason)
    signal.addEventListener('abort', listener, { once: true })
    listeners.push([signal, listener])
  }

  return {
    signal: controller.signal,
    dispose() {
      for (const [signal, listener] of listeners) signal.removeEventListener('abort', listener)
      listeners.length = 0
    },
  }
}
