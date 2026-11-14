import test from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { exchange } from '../core.js'
import { createRootHandler } from '../root.js'
import { page } from '../page.js'

// Optional integration against explicitly selected installed DSH modules.
test('installed Connection accepts exchanged cookie only for configured host', { skip: !process.env.DSH_CORDIS_MODULE || !process.env.DSH_CONNECTION_MODULE }, async () => {
  const { Context, Service } = await import(pathToFileURL(process.env.DSH_CORDIS_MODULE).href)
  const plugin = await import(pathToFileURL(process.env.DSH_CONNECTION_MODULE).href)
  class Credentials extends Service {
    constructor(ctx) { super(ctx, 'credentials'); this.value = undefined }
    async modifyRecord(key, mutate) { const next = await mutate(this.value); if (next !== undefined) this.value = next; return this.value }
  }
  const ctx = new Context()
  try {
    await ctx.plugin(Credentials)
    await ctx.plugin(plugin, { trustedHosts: ['dsh.tnzzz.top'] })
    const connection = ctx.get('connection')
    assert.ok(connection)
    const cookie = exchange(connection).split(';')[0]
    assert.ok('peer' in connection.admit({headers:{ host:'dsh.tnzzz.top', origin:'https://dsh.tnzzz.top', cookie }}))
    assert.ok('rejection' in connection.admit({headers:{ host:'evil.example', origin:'https://evil.example', cookie }}))
    const handler = createRootHandler({ connection, page, webServer: { async readResource(request, peer) { assert.equal(peer, connection.browserPeer); return new Response('<html>DSH</html>') } } })
    async function visit(url, headers = {}) {
      const out = {}; await handler({ method: 'GET', url, headers: { host: 'dsh.tnzzz.top', ...headers } }, { writeHead(status, headers) { out.status = status; out.headers = headers }, end(body) { out.body = body } }); return out
    }
    assert.match((await visit('/')).body, /使用 Passkey 登录/)
    assert.equal((await visit('/', { cookie })).body.toString(), '<html>DSH</html>')
    const tokenPath = new URL(connection.authenticatedUrl('https://dsh.tnzzz.top/')).search
    assert.equal((await visit('/' + tokenPath)).status, 303)
    assert.equal((await visit('/?token=invalid')).status, 401)
    assert.equal((await visit('/', { origin: 'https://evil.example', cookie })).status, 403)
  } finally { await ctx.fiber.dispose() }
})
