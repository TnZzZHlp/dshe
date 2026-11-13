/**
 * Shared error helpers. Every user-facing failure produced by this bundle is a
 * plugin error with a stable name and a single `[dsh-agent-websearch]` prefix,
 * so hosts and tool renderers can display it without guessing.
 */
export const PLUGIN_NAME = 'dsh-agent-websearch'

const ERROR_NAME = 'AgentWebSearchError'
const PREFIX = `[${PLUGIN_NAME}]`

/** Build a user-facing plugin error. */
export function pluginError(message, cause) {
  const error = new Error(cause === undefined ? `${PREFIX} ${message}` : `${PREFIX} ${message}`, { cause })
  error.name = ERROR_NAME
  return error
}

export function isPluginError(error) {
  return error instanceof Error && error.name === ERROR_NAME
}

/** Build the AbortError the host expects when a search is cancelled. */
export function abortError(message = 'agent web search was aborted') {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

export function isAbortError(error) {
  return error instanceof Error && error.name === 'AbortError'
}

export function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/** Drop this bundle's own prefix so a wrapped message does not repeat it. */
export function stripPluginPrefix(message) {
  return message.startsWith(`${PREFIX} `) ? message.slice(PREFIX.length + 1) : message
}

/** Wrap an error from a provider module with this plugin's prefix. */
export function wrapError(message, error) {
  if (isPluginError(error) || isAbortError(error)) {
    const stripped = isPluginError(error) ? stripPluginPrefix(messageOf(error)) : messageOf(error)
    return pluginError(`${message}: ${stripped}`, isPluginError(error) ? undefined : error)
  }
  return pluginError(`${message}: ${messageOf(error)}`, error)
}
