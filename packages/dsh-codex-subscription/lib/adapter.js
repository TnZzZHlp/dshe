import { LlmAdapter, LlmError, attributionHeaders } from './host.js'
import { serializeConversation, serializeTools, mapResponseEvents, responseError } from './conversation.js'
import { readSse } from './sse.js'
import { readJsonBody } from './http.js'

export const PROVIDER = 'codex-subscription'
const ENDPOINT = 'https://api.openai.com/v1/responses'
const LIMITED = 'subscription_sharing_usage_limit_exceeded'
const failure = error => LlmError.fromFailure({ message: error.message || 'Responses API failed', code: error.code || 'RESPONSES_ERROR', ...(error.status ? { status: error.status } : {}), ...(error.requestId ? { requestId: error.requestId } : {}) }, { cause: error })

export class CodexSubscriptionAdapter extends LlmAdapter {
  constructor(pool, config = {}) {
    super()
    this.pool = pool
    this.config = config
  }

  providerInfo(provider = PROVIDER) {
    this.assertProvider(provider)
    return { id: PROVIDER, name: 'Codex Subscription' }
  }

  assertProvider(provider) {
    if (provider !== PROVIDER) throw new Error(`Unsupported provider: ${provider}`)
  }

  async listModels(provider = PROVIDER) {
    this.assertProvider(provider)
    const accounts = await this.pool.available()
    if (!accounts.length) return []
    const models = await this.pool.models(accounts[0].id)
    return models.map(model => ({ provider: PROVIDER, id: model.id, name: model.name || model.id, inputModalities: ['text'] }))
  }

  async resolveModel(provider, id, signal) {
    this.assertProvider(provider)
    signal?.throwIfAborted()
    const model = (this.config.models ?? []).find(model => model.id === id)
    return { provider: PROVIDER, id, name: model?.name || id, inputModalities: ['text'], ...(model?.contextWindow ? { context: { contextWindow: model.contextWindow } } : {}) }
  }

  async *stream(options) {
    this.assertProvider(options.provider)
    options.signal?.throwIfAborted()
    for (const field of ['temperature', 'maxTokens', 'stop']) {
      if (options[field] !== undefined) throw new LlmError(`ChatGPT plan usage does not support ${field}; remove that request control.`, 'UNSUPPORTED_OPTION')
    }
    const tools = serializeTools(options.tools)
    const accounts = await this.pool.available()
    const attempted = new Set()
    let lastError
    for (const account of accounts) {
      if (attempted.has(account.id)) continue
      attempted.add(account.id)
      options.signal?.throwIfAborted()
      if (lastError) {
        try {
          if (!(await this.pool.models(account.id, { signal: options.signal })).some(model => model.id === options.model)) continue
        } catch {
          options.signal?.throwIfAborted()
          this.pool.recordError?.(account.id, 'MODEL_CHECK_UNAVAILABLE')
          continue
        }
      }
      let output = false
      let response
      const controller = new AbortController()
      const abort = () => controller.abort(options.signal.reason)
      options.signal?.addEventListener('abort', abort, { once: true })
      if (options.signal?.aborted) abort()
      let timer
      if (this.config.timeoutMs > 0) timer = setTimeout(() => controller.abort(new Error('Responses request timed out')), this.config.timeoutMs)
      try {
        const token = await this.pool.accessToken(account.id, { signal: controller.signal })
        controller.signal.throwIfAborted()
        const payload = { model: options.model, input: serializeConversation(options, { accountId: account.id }), tools, store: false, stream: true, include: ['reasoning.encrypted_content'] }
        if (options.reasoningEffort) payload.reasoning = { effort: options.reasoningEffort }
        response = await fetch(ENDPOINT, {
          method: 'POST',
          redirect: 'error',
          headers: { ...attributionHeaders(), authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'text/event-stream' },
          body: JSON.stringify(payload),
          signal: controller.signal,
        })
        if (!response.ok) {
          let parsed
          try { parsed = await readJsonBody(response) } catch {}
          throw responseError(parsed?.error, { status: response.status, requestId: response.headers.get('x-request-id') || undefined, message: `Responses API returned HTTP ${response.status}` })
        }
        if (!response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) throw responseError({ code: 'INVALID_STREAM', message: 'Responses API did not return an event stream' })
        for await (const chunk of mapResponseEvents(readSse(response.body, controller.signal), options.tools, { accountId: account.id, model: options.model })) {
          controller.signal.throwIfAborted()
          output = true
          if (chunk.type === 'usage') await this.pool.observeUsage?.(account.id, chunk.usage)
          if (chunk.type === 'finish' && chunk.reason.kind !== 'max-tokens') await this.pool.markActive(account.id)
          yield chunk
        }
        return
      } catch (error) {
        if (options.signal?.aborted || controller.signal.aborted) throw error
        if (response) {
          error.status ??= response.status
          error.requestId ??= response.headers.get('x-request-id') || undefined
        }
        if (error.code !== LIMITED) throw failure(error)
        await this.pool.markLimited(account.id, error)
        if (output || this.config.autoSwitch === false) throw failure(error)
        lastError = error
      } finally {
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', abort)
        controller.abort()
        await response?.body?.cancel().catch(() => {})
      }
    }
    throw failure(lastError ?? responseError({ code: 'NO_AVAILABLE_ACCOUNT' }, { message: 'No ChatGPT plan account is currently available' }))
  }
}

export default CodexSubscriptionAdapter
