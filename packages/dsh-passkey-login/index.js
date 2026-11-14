import { createHandler } from './core.js'
import { page } from './page.js'
import { createRootHandler } from './root.js'

export const name = 'passkey-login'
export const inject = ['webServer', 'connection', 'credentials']
export async function apply(ctx) {
  const origin = new URL(ctx.webServer.getOrigin())
  if (origin.protocol !== 'http:') throw Error('passkey-login requires an HTTP DSH listener behind the HTTPS reverse proxy')
  const info = await ctx.credentials.describeRecord('passkey-login/credentials')
  if (!info.writable) throw Error('passkey-login requires writable durable credentials')
  const handler = await createHandler({ connection: ctx.connection, credentials: ctx.credentials, page })
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/passkey', handler }), 'passkey-login route')
  const rootHandler = createRootHandler({ connection: ctx.connection, webServer: ctx.webServer, page })
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/', handler: rootHandler }), 'passkey-login root')
}
