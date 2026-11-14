export const TOOL_NAMESPACE = 'dsh'

function textContent(content) {
  return content.map(block => {
    if (block.type === 'text') return block.text
    if (block.type === 'reasoning') return ''
    if (block.type === 'tool-addition' || block.type === 'tool-removal') return ''
    throw new Error(`Unsupported unprojected content block: ${block.type}`)
  }).join('\n')
}

export function serializeConversation(options, { accountId } = {}) {
  const input = []
  if (options.system) input.push({ role: 'developer', content: options.system })
  for (const message of options.messages) {
    if (message.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: message.toolCallId ?? message.source?.callId, output: textContent(message.content) })
      continue
    }
    const replay = message.source?.replayState
    const replayBlocks = replay?.response?.version === 1 && replay.response.adapter === 'codex-subscription' && replay.blocks?.length === message.content.length ? replay.blocks : undefined
    let pending = []
    const flush = () => {
      if (!pending.length) return
      const content = textContent(pending)
      if (content) input.push({ role: message.role === 'system' ? 'developer' : message.role, content })
      pending = []
    }
    const nativeReasoning = replayBlocks && accountId && replay.response.accountId === accountId && replay.response.model === options.model && replay.response.blockCount === message.content.length ? replay.response.nativeReasoning ?? [] : []
    const insertReasoning = blockIndex => {
      for (const item of nativeReasoning) {
        if (item.beforeBlock !== blockIndex || typeof item.encrypted_content !== 'string') continue
        flush()
        input.push({ type: 'reasoning', ...(typeof item.id === 'string' ? { id: item.id } : {}), encrypted_content: item.encrypted_content, summary: item.summary ?? [] })
      }
    }
    for (const [blockIndex, block] of message.content.entries()) {
      insertReasoning(blockIndex)
      const phase = replayBlocks?.[blockIndex]?.phase
      if (message.role === 'assistant' && block.type === 'text' && (phase === 'commentary' || phase === 'final_answer')) {
        flush()
        input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: block.text, annotations: [] }], phase })
        continue
      }
      if (block.type !== 'tool-call') { pending.push(block); continue }
      flush()
      input.push({ type: 'function_call', call_id: block.id, name: block.name, namespace: TOOL_NAMESPACE, arguments: block.arguments })
    }
    flush()
    insertReasoning(message.content.length)
  }
  return input
}

export function serializeTools(tools = []) {
  if (!tools.length) return []
  const names = new Set()
  return [{ type: 'namespace', name: TOOL_NAMESPACE, description: 'Tools executed exclusively by DeepSeek Harness.', tools: tools.map(tool => {
    if (!/^[a-zA-Z0-9_.-]{1,128}$/.test(tool.name) || names.has(tool.name)) throw new Error(`Invalid or duplicate tool name: ${tool.name}`)
    names.add(tool.name)
    return { type: 'function', name: tool.name, description: tool.description, parameters: tool.parameters, strict: false }
  }) }]
}

export function responseError(error, details = {}) {
  const result = new Error(details.message || 'Responses API request failed')
  Object.assign(result, details, { code: typeof error?.code === 'string' && /^[A-Za-z0-9_]{1,128}$/.test(error.code) ? error.code : 'RESPONSES_ERROR', param: typeof error?.param === 'string' && /^[A-Za-z0-9_.\[\]]{1,128}$/.test(error.param) ? error.param : undefined })
  return result
}

function validateArguments(argumentsJson) {
  let value
  try { value = JSON.parse(argumentsJson) } catch { throw responseError({ code: 'INVALID_TOOL_ARGUMENTS' }) }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw responseError({ code: 'INVALID_TOOL_ARGUMENTS' })
}

export async function* mapResponseEvents(events, tools = [], { accountId, model } = {}) {
  const allowed = new Set(tools.map(tool => tool.name))
  const blocks = new Map()
  const phases = new Map()
  const replayBlocks = []
  const nativeReasoning = []
  const reasoningPositions = new Map()
  let nextIndex = 0
  let toolCalls = false
  const get = function* (key, block) {
    if (!blocks.has(key)) {
      const state = { index: nextIndex++, block, ended: false }
      blocks.set(key, state)
      const phase = block.type === 'text' ? phases.get(Number(key.split(':')[0])) : undefined
      replayBlocks[state.index] = phase ? { phase } : null
      yield { type: 'block-start', index: state.index, blockType: block.type }
    }
    return blocks.get(key)
  }
  const finishBlock = function* (state) {
    if (!state.ended) {
      if (state.block.type === 'tool-call') validateArguments(state.block.arguments)
      state.ended = true
      yield { type: 'block-end', index: state.index, block: { ...state.block } }
    }
  }
  for await (const event of events) {
    const key = `${event.output_index}:${event.content_index ?? event.summary_index ?? 0}`
    if (event.type === 'response.output_item.added' && event.item?.type === 'reasoning') {
      reasoningPositions.set(event.output_index, nextIndex)
    } else if (event.type === 'response.output_item.added' && event.item?.type === 'message') {
      if (event.item.phase === 'commentary' || event.item.phase === 'final_answer') phases.set(event.output_index, event.item.phase)
    } else if (event.type === 'response.output_text.delta' || event.type === 'response.refusal.delta' || event.type === 'response.reasoning_summary_text.delta') {
      const reasoning = event.type === 'response.reasoning_summary_text.delta'
      const state = yield* get(key, { type: reasoning ? 'reasoning' : 'text', text: '' })
      state.block.text += event.delta
      yield { type: reasoning ? 'reasoning-delta' : 'text-delta', index: state.index, text: event.delta }
    } else if (event.type === 'response.output_item.added' && event.item?.type === 'function_call') {
      const item = event.item
      if (item.namespace !== TOOL_NAMESPACE || !allowed.has(item.name) || typeof item.call_id !== 'string' || !item.call_id) throw responseError({ code: 'UNEXPECTED_TOOL', message: 'Response requested an undeclared tool or namespace' })
      toolCalls = true
      const state = yield* get(`tool:${event.output_index}`, { type: 'tool-call', id: item.call_id, name: item.name, arguments: item.arguments || '' })
      yield { type: 'tool-call-delta', index: state.index, id: item.call_id, name: item.name, argumentsDelta: item.arguments || '' }
    } else if (event.type === 'response.function_call_arguments.delta') {
      const state = blocks.get(`tool:${event.output_index}`)
      if (!state || state.ended) throw new Error('Tool arguments arrived without an active function call')
      state.block.arguments += event.delta
      yield { type: 'tool-call-delta', index: state.index, id: state.block.id, argumentsDelta: event.delta }
    } else if (event.type === 'response.function_call_arguments.done') {
      const state = blocks.get(`tool:${event.output_index}`)
      if (!state || state.block.arguments !== event.arguments) throw new Error('Inconsistent streamed function arguments')
      validateArguments(event.arguments)
    } else if (event.type === 'response.output_item.done') {
      if (event.item.type === 'function_call') {
        const state = blocks.get(`tool:${event.output_index}`)
        if (!state || event.item.call_id !== state.block.id || event.item.name !== state.block.name || event.item.arguments !== state.block.arguments) throw responseError({ code: 'INVALID_TOOL_ARGUMENTS' })
        yield* finishBlock(state)
      } else if (event.item.type === 'message' || event.item.type === 'reasoning') {
        if (event.item.type === 'reasoning' && typeof event.item.encrypted_content === 'string') {
          nativeReasoning.push({ type: 'reasoning', id: event.item.id, encrypted_content: event.item.encrypted_content, summary: (event.item.summary ?? []).filter(item => item.type === 'summary_text' && typeof item.text === 'string').map(item => ({ type: 'summary_text', text: item.text })), beforeBlock: reasoningPositions.get(event.output_index) ?? nextIndex })
        }
        for (const [blockKey, state] of blocks) if (blockKey.startsWith(`${event.output_index}:`)) yield* finishBlock(state)
      } else throw responseError({ code: 'UNEXPECTED_OUTPUT', message: `Unsupported response output: ${event.item.type}` })
    } else if (event.type === 'error' || event.type === 'response.failed') {
      throw responseError(event.error ?? event.response?.error ?? event)
    } else if (event.type === 'response.completed' || event.type === 'response.incomplete') {
      for (const state of blocks.values()) yield* finishBlock(state)
      const response = event.response
      if (response?.usage) {
        const usage = response.usage
        const cached = usage.input_tokens_details?.cached_tokens ?? 0
        if (![usage.input_tokens, usage.output_tokens, cached].every(value => Number.isSafeInteger(value) && value >= 0) || cached > usage.input_tokens) throw responseError({ code: 'INVALID_USAGE' })
        yield { type: 'usage', usage: { inputTokens: Math.max(0, usage.input_tokens - cached), cacheReadTokens: cached, outputTokens: usage.output_tokens, totalTokens: usage.total_tokens, reasoningTokens: usage.output_tokens_details?.reasoning_tokens } }
      }
      if (event.type === 'response.incomplete' && response?.incomplete_details?.reason !== 'max_output_tokens') throw responseError({ code: 'RESPONSE_INCOMPLETE', message: `Response incomplete: ${response?.incomplete_details?.reason ?? 'unknown'}` })
      yield { type: 'finish', reason: { kind: event.type === 'response.incomplete' ? 'max-tokens' : toolCalls ? 'tool-calls' : 'stop' }, replayState: { response: { version: 1, adapter: 'codex-subscription', accountId, model, blockCount: nextIndex, nativeReasoning }, blocks: replayBlocks } }
      return
    }
  }
  throw responseError({ code: 'STREAM_INTERRUPTED', message: 'Response stream ended without a terminal response event' })
}
