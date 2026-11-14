export async function readJsonBody(response, limit = 2 * 1024 * 1024) {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('OpenAI returned an empty response.')
  const chunks = []
  let length = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > limit) throw new Error('OpenAI response exceeds the size limit.')
      chunks.push(Buffer.from(value))
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
