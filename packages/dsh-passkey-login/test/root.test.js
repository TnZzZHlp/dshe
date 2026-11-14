import test from 'node:test'
import assert from 'node:assert/strict'
import { createRootHandler } from '../root.js'
import { page } from '../page.js'

function fixture() {
  let reads = 0
  const connection = {
    browserPeer: { principal: { kind: 'owner' } },
    requestRejection(req) { return req.headers.host === 'evil.test' || req.headers.origin === 'https://evil.test' ? 403 : req.headers.cookie === 'good' ? undefined : 401 },
    authorizeIndex(req, res) {
      if (req.url === '/?token=good') { res.writeHead(303, { location: './', 'set-cookie': 'session=good' }); res.end(); return false }
      if (req.headers.cookie === 'good' && !req.url.includes('token=')) return true
      res.writeHead(401, { 'cache-control': 'no-store' }); res.end('unauthorized'); return false
    },
  }
  const webServer = { async readResource(request, peer) { reads++; assert.equal(new URL(request.url).pathname, '/index.html'); assert.equal(peer, connection.browserPeer); return new Response(request.method === 'HEAD' ? null : '<html>application</html>', { headers: { 'content-type': 'text/html' } }) } }
  return { handler: createRootHandler({ connection, webServer, page }), reads: () => reads }
}
async function request(handler, options = {}) {
  const req = { method: options.method ?? 'GET', url: options.url ?? '/', headers: { host: 'dsh.tnzzz.top', ...options.headers } }
  const result = {}; const res = { writeHead(status, headers) { result.status = status; result.headers = headers }, end(body) { result.body = body } }
  await handler(req, res); return result
}
test('root presents login only to unauthenticated public GET', async () => {
  const f = fixture(), result = await request(f.handler)
  assert.equal(result.status, 200); assert.match(result.body, /使用 Passkey 登录/); assert.doesNotMatch(result.body, /passkey\/register\//)
  assert.match(result.headers['content-security-policy'], /sha256-/); assert.equal(f.reads(), 0)
  assert.equal((await request(f.handler, { method: 'HEAD' })).status, 401)
  assert.equal((await request(f.handler, { method: 'POST' })).status, 405)
  assert.equal((await request(f.handler, { headers: { host: 'evil.test' } })).status, 403)
  assert.equal((await request(f.handler, { headers: { origin: 'https://evil.test' } })).status, 403)
})
test('root preserves token exchange, fails invalid tokens, serves authorized index only', async () => {
  const f = fixture()
  const token = await request(f.handler, { url: '/?token=good' })
  assert.equal(token.status, 303); assert.equal(token.headers['set-cookie'], 'session=good'); assert.equal(f.reads(), 0)
  assert.equal((await request(f.handler, { url: '/?token=bad' })).status, 401)
  const index = await request(f.handler, { headers: { cookie: 'good' } })
  assert.equal(index.status, 200); assert.equal(index.body.toString(), '<html>application</html>'); assert.equal(f.reads(), 1)
  const head = await request(f.handler, { method: 'HEAD', headers: { cookie: 'good' } })
  assert.equal(head.status, 200); assert.equal(head.body, undefined)
})
