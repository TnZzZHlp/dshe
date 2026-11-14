import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import * as registry from '@deepseek-ai/dsh-typert-registry/client'
import * as connection from '@deepseek-ai/dsh-client-connection/client'
import * as gateway from '@deepseek-ai/dsh-api-gateway/client'
import TYPERT_REMOTE from '../remote-build/packages/contract/lib/typert.remote-client.js'
import { mountModelsRemote } from '../lib/client-models-remote.js'

test('mounted models namespace is callable through its injected client context', async t => {
  const root = new Context()
  t.after(() => root.fiber.dispose())
  await root.plugin(registry)
  await root.plugin(connection)
  await root.plugin(gateway)
  await root.plugin({
    inject: ['remote'],
    async apply(ctx) {
      const remote = await mountModelsRemote(ctx, TYPERT_REMOTE)
      try {
        const controller = new AbortController()
        controller.abort()
        const result = await remote.listModels(controller.signal)
        assert.equal(result.ok, false)
        assert.equal(result.error.isDSHRemoteError, true)
        assert.equal(result.error.code, 'gateway/cancelled')
      } finally {
        await remote.dispose()
      }
    },
  })
})
