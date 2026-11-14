import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { createHash } from 'node:crypto'
import { createHandler, exchange } from '../core.js'
import { page } from '../page.js'
import { apply } from '../index.js'

const host = 'dsh.tnzzz.top', origin = 'https://' + host
const cookieName = 'dsh-auth-' + createHash('sha256').update(host).digest('base64url')
function connection() { return {
  admit: ({ headers }) => headers.cookie?.includes('auth=yes') || headers.cookie?.startsWith(cookieName+'=') ? { peer: { principal: { kind: 'owner' } } } : { rejection: 401 },
  authenticatedUrl: base => base + '?token=secret',
  authorizeIndex(req,res) { assert.equal(req.url,'/?token=secret'); res.writeHead(303,{location:'./','set-cookie':cookieName+'=abc; Path=/; HttpOnly; SameSite=Strict'}); res.end(); return false }
} }
function store() { let current; return { async modifyRecord(k,f) { const next = await f(current); if (next !== undefined) current=next; return current }, async readRecord() { return current }, clear() { current=undefined } } }
async function request(handler,path,{ method='POST', headers={}, data={} }={}) {
  const req=Readable.from([Buffer.from(JSON.stringify(data))]); req.url=path; req.method=method; req.headers={host,origin,'sec-fetch-site':'same-origin','content-type':'application/json',...headers}
  const result={}; const res={writeHead(status,h){result.status=status;result.headers=h;this.headersSent=true},end(body){result.body=body},headersSent:false,destroyed:false}
  await handler(req,res); return result
}
test('allows LAN HTTP listener but rejects a TLS backend', async () => {
  const routes = []
  const credentials = { ...store(), describeRecord: async () => ({ writable: true }) }
  const ctx = { credentials, connection: connection(), webServer: { getOrigin: () => 'http://192.168.2.10:18080', register: value => { routes.push(value); return () => {} } }, effect: fn => fn() }
  await apply(ctx)
  assert.deepEqual(routes.map(route => route.path), ['/passkey', '/'])
  ctx.webServer.getOrigin = () => 'https://127.0.0.1:18080'
  await assert.rejects(apply(ctx), /HTTP DSH listener/)
})
test('exchange appends Secure and refuses malformed output', () => {
  assert.match(exchange(connection()), /; Secure$/)
  const c=connection();c.authorizeIndex=(_,r)=>{r.writeHead(303,{location:'./','set-cookie':'other=x; Path=/; HttpOnly; SameSite=Strict'});r.end();return false}
  assert.throws(()=>exchange(c))
})
test('unauthenticated binding, cross-origin and missing fetch metadata fail closed', async () => {
  const h=await createHandler({connection:connection(),credentials:store(),page})
  assert.equal((await request(h,'/passkey/register/options')).status,401)
  assert.equal((await request(h,'/passkey/register/options',{headers:{cookie:'auth=yes',origin:'https://evil.example'}})).status,400)
  assert.equal((await request(h,'/passkey/register/options',{headers:{cookie:'auth=yes','sec-fetch-site':undefined}})).status,400)
  assert.equal((await request(h,'/passkey/register/options',{headers:{cookie:'auth=yes',host:'evil.example'}})).status,400)
})
test('registration uses real library options and one-use browser-bound challenge', async () => {
  const h=await createHandler({connection:connection(),credentials:store(),page})
  const a=await request(h,'/passkey/register/options',{headers:{cookie:'auth=yes'}})
  assert.equal(a.status,200);const opts=JSON.parse(a.body);assert.equal(opts.rp.id,host);assert.equal(opts.authenticatorSelection.userVerification,'required')
  const flow=a.headers['set-cookie'].split(';')[0];assert.match(a.headers['set-cookie'],/; HttpOnly; Secure; SameSite=Strict/)
  assert.equal((await request(h,'/passkey/register/verify',{headers:{cookie:'auth=yes'},data:{}})).status,400)
  assert.equal((await request(h,'/passkey/register/verify',{headers:{cookie:'auth=yes; '+flow},data:{}})).status,400)
  assert.equal((await request(h,'/passkey/register/verify',{headers:{cookie:'auth=yes; '+flow},data:{}})).status,400)
})
test('lost storage, missing initialization, and unknown credential fail', async () => {
  const s=store(); const h=await createHandler({connection:connection(),credentials:s,page}); s.clear()
  assert.equal((await request(h,'/passkey/register/options',{headers:{cookie:'auth=yes'}})).status,400)
  await assert.rejects(createHandler({connection:connection(),credentials:{modifyRecord:async()=>undefined},page}))
})
