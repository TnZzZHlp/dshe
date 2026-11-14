import assert from 'node:assert/strict'
import test from 'node:test'

test('a linked bundle resolves public APIs from the running DSH installation', { skip: !process.env.DSH_INSTALL_DIR }, async () => {
  const plugin = await import('../index.js')
  assert.equal(plugin.name, 'codex-subscription')
  assert.deepEqual(plugin.Config({}), { autoSwitch: true, timeoutMs: 180000, models: [] })
})
