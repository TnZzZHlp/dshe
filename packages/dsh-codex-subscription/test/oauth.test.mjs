import test from 'node:test'
import assert from 'node:assert/strict'
import { beginLogin } from '../lib/oauth.js'

test('invalid callback state never completes authorization', async () => {
  let called = false
  const login = await beginLogin({ hostId: 'regression-host', onSuccess() { called = true } })
  try {
    const authorization = new URL(login.url)
    const callback = new URL(authorization.searchParams.get('redirect_uri'))
    callback.search = new URLSearchParams({ state: 'invalid-state', code: 'unused' }).toString()
    const response = await fetch(callback)
    assert.equal(response.status, 400)
    await response.text()
    assert.equal(called, false)
  } finally {
    await login.cancel()
    await assert.rejects(login.done, { code: 'CANCELLED' })
  }
})

test('cancellation closes the loopback callback listener', async () => {
  const login = await beginLogin({ hostId: 'regression-host', onSuccess() { assert.fail('unexpected authorization') } })
  const callback = new URL(login.url).searchParams.get('redirect_uri')
  await login.cancel()
  await assert.rejects(login.done, { code: 'CANCELLED' })
  await assert.rejects(fetch(callback), TypeError)
})
