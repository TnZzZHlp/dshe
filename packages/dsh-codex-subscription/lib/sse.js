export async function* readSse(body, signal) {
  if (!body) throw new Error('Responses API returned no stream body')
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let lines = []
  let totalBytes = 0
  const abort = () => { void reader.cancel(signal.reason).catch(() => {}) }
  signal?.addEventListener('abort', abort, { once: true })
  const parse = () => {
    const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n')
    lines = []
    if (!data || data === '[DONE]') return undefined
    return JSON.parse(data)
  }
  try {
    while (true) {
      signal?.throwIfAborted()
      const { value, done } = await reader.read()
      signal?.throwIfAborted()
      totalBytes += value?.byteLength || 0
      if (totalBytes > 32 * 1024 * 1024) throw new Error('Responses stream exceeds size limit')
      buffer += decoder.decode(value, { stream: !done })
      if (buffer.length > 4 * 1024 * 1024 || lines.reduce((sum, line) => sum + line.length, 0) + buffer.length > 4 * 1024 * 1024) throw new Error('Responses stream event exceeds size limit')
      let match
      while ((match = /\r\n|\n|\r/.exec(buffer))) {
        if (!done && match[0] === '\r' && match.index === buffer.length - 1) break
        const line = buffer.slice(0, match.index)
        buffer = buffer.slice(match.index + match[0].length)
        if (line) lines.push(line)
        else {
          const event = parse()
          if (event) yield event
        }
      }
      if (done) {
        if (buffer) lines.push(buffer)
        const event = parse()
        if (event) yield event
        break
      }
    }
  } finally {
    signal?.removeEventListener('abort', abort)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
