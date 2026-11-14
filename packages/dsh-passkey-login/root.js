import { createHash } from 'node:crypto'

const HOST = 'dsh.tnzzz.top'

// Preserve Connection's ordinary token exchange and signed-cookie checks; only
// replace its unauthenticated 401 on the configured public host with login UI.
export function createRootHandler({ connection, webServer, page }) {
  const script = page.match(/<script>([\s\S]*?)<\/script>/)?.[1]
  if (!script) throw Error('missing login script')
  const hash = createHash('sha256').update(script).digest('base64')
  return async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD', 'cache-control': 'no-store' })
      res.end()
      return
    }
    if (connection.requestRejection(req) === 403) {
      res.writeHead(403, { 'cache-control': 'no-store' })
      res.end()
      return
    }
    let status = 401, headers = {}, body
    const authorized = connection.authorizeIndex(req, {
      writeHead(code, values) { status = code; headers = values ?? {} },
      end(value) { body = value },
    })
    if (!authorized) {
      const url = new URL(req.url ?? '/', 'http://dsh.invalid')
      if (status === 401 && req.method === 'GET' && req.headers.host === HOST && !url.searchParams.has('token')) {
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
          'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY',
          'content-security-policy': `default-src 'none'; script-src 'sha256-${hash}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
        })
        res.end(page)
      } else {
        res.writeHead(status, headers)
        res.end(body)
      }
      return
    }
    if (connection.requestRejection(req) !== undefined) {
      res.writeHead(401, { 'cache-control': 'no-store' })
      res.end()
      return
    }
    // / is an exact handler now, so read the fallback's authenticated index via
    // its distinct /index.html path. The Peer must only be passed after admission.
    const resource = await webServer.readResource(new Request('http://dsh.invalid/index.html', { method: req.method === 'HEAD' ? 'HEAD' : 'GET' }), connection.browserPeer)
    res.writeHead(resource.status, Object.fromEntries(resource.headers))
    res.end(req.method === 'HEAD' ? undefined : Buffer.from(await resource.arrayBuffer()))
  }
}
