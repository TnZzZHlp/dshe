import assert from 'node:assert/strict'
import test from 'node:test'
import { serializeConversation, mapResponseEvents } from '../lib/conversation.js'
import { readSse } from '../lib/sse.js'

test('tool history keeps call correlation without exposing private reasoning', () => {
  const input = serializeConversation({ messages: [
    { role: 'system', content: [{ type: 'text', text: 'rules' }] },
    { role: 'assistant', content: [{ type: 'reasoning', text: 'private' }, { type: 'tool-call', id: 'call-1', name: 'read', arguments: '{"path":"a"}' }] },
    { role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: 'content' }] },
  ] })
  assert.deepEqual(input, [
    { role: 'developer', content: 'rules' },
    { type: 'function_call', call_id: 'call-1', name: 'read', namespace: 'dsh', arguments: '{"path":"a"}' },
    { type: 'function_call_output', call_id: 'call-1', output: 'content' },
  ])
})

test('a partial text stream without completion is not successful', async () => {
  const data = 'data: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"partial"}\r\n\r\n'
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(data)); controller.close() } })
  const chunks = []
  await assert.rejects(async () => {
    for await (const chunk of mapResponseEvents(readSse(stream))) chunks.push(chunk)
  }, error => error.code === 'STREAM_INTERRUPTED')
  assert.equal(chunks.some(chunk => chunk.type === 'text-delta'), true)
  assert.equal(chunks.some(chunk => chunk.type === 'finish'), false)
})

test('encrypted reasoning is not replayed into a different account', () => {
  const message = { role: 'assistant', content: [{ type: 'text', text: 'answer' }], source: { replayState: {
    response: { version: 1, adapter: 'codex-subscription', accountId: 'personal', model: 'model', blockCount: 1, nativeReasoning: [{ beforeBlock: 0, type: 'reasoning', id: 'r1', encrypted_content: 'opaque', summary: [] }] },
    blocks: [{ phase: 'final_answer' }],
  } } }
  assert.equal(serializeConversation({ model: 'model', messages: [message] }, { accountId: 'personal' })[0].type, 'reasoning')
  const switched = serializeConversation({ model: 'model', messages: [message] }, { accountId: 'work' })
  assert.equal(switched.some(item => item.type === 'reasoning'), false)
  assert.equal(switched[0].phase, 'final_answer')
})

test('invalid tool JSON is rejected before an assembled tool call is emitted', async () => {
  async function* events() {
    yield { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', namespace: 'dsh', name: 'read', call_id: 'c1', arguments: '' } }
    yield { type: 'response.function_call_arguments.delta', output_index: 0, delta: '[]' }
    yield { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', name: 'read', call_id: 'c1', arguments: '[]' } }
  }
  const chunks = []
  await assert.rejects(async () => { for await (const chunk of mapResponseEvents(events(), [{ name: 'read' }])) chunks.push(chunk) }, error => error.code === 'INVALID_TOOL_ARGUMENTS')
  assert.equal(chunks.some(chunk => chunk.type === 'block-end'), false)
})

test('subscription limit errors retain the exact code without exposing server text', async () => {
  async function* events() { yield { type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'sensitive diagnostic' } } } }
  await assert.rejects(async () => { for await (const chunk of mapResponseEvents(events())) void chunk }, error => error.code === 'subscription_sharing_usage_limit_exceeded' && !error.message.includes('sensitive'))
})
