import { createServer } from 'node:http'
import { createHash, randomBytes, createPublicKey, timingSafeEqual, verify } from 'node:crypto'

const ISSUER = 'https://auth.openai.com'
const RESOURCE = 'https://api.openai.com/v1'
const TOKEN_ENDPOINT = `${ISSUER}/api/accounts/oauth/token`
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'
const MAX_BODY = 1024 * 1024
const OAUTH_ERRORS = new Set(['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused', 'invalid_client'])

function fail(code) {
  return Object.assign(new Error(`ChatGPT authorization failed (${code})`), { code })
}

function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

function issuedClient(value) {
  if (typeof value !== 'string' || !value || value === 'dynamic_agent_client' || value.length > 1024) throw fail('INVALID_CLIENT')
  return value
}

async function jsonFetch(url, { signal, ...options } = {}) {
  const target = new URL(url)
  if (target.origin !== ISSUER || target.username || target.password || target.hash) throw fail('INVALID_ENDPOINT')
  let response
  try {
    response = await fetch(target, { ...options, redirect: 'error', signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(30_000)]) })
  } catch { throw fail(signal?.aborted ? 'CANCELLED' : 'NETWORK_ERROR') }
  const reader = response.body?.getReader()
  if (!reader) throw fail('INVALID_RESPONSE')
  const chunks = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > MAX_BODY) throw fail('RESPONSE_TOO_LARGE')
      chunks.push(Buffer.from(value))
    }
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw fail('INVALID_RESPONSE')
    if (!response.ok) throw fail(OAUTH_ERRORS.has(result.error) ? result.error.toUpperCase() : response.status === 401 ? 'REAUTH_REQUIRED' : 'HTTP_ERROR')
    return result
  } catch (error) {
    if (OAUTH_ERRORS.has(error.code?.toLowerCase()) || ['REAUTH_REQUIRED', 'HTTP_ERROR'].includes(error.code)) throw error
    throw fail('INVALID_RESPONSE')
  } finally {
    await reader.cancel().catch(() => {})
  }
}

async function validateIdToken(token, { clientId, nonce, subject, signal }) {
  if (typeof token !== 'string' || token.length > MAX_BODY) throw fail('INVALID_ID_TOKEN')
  const parts = token.split('.')
  if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) throw fail('INVALID_ID_TOKEN')
  let header, claims
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'))
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
  } catch { throw fail('INVALID_ID_TOKEN') }
  if (!header || !claims || header.alg !== 'RS256' || typeof header.kid !== 'string' || header.crit) throw fail('INVALID_ID_TOKEN')
  const discovery = await jsonFetch(`${ISSUER}/.well-known/openid-configuration`, { signal })
  if (discovery.issuer !== ISSUER || discovery.jwks_uri !== `${ISSUER}/.well-known/jwks.json` || discovery.token_endpoint !== TOKEN_ENDPOINT) throw fail('INVALID_DISCOVERY')
  const jwks = await jsonFetch(discovery.jwks_uri, { signal })
  if (!Array.isArray(jwks.keys)) throw fail('INVALID_JWKS')
  const keys = jwks.keys.filter(key => key.kid === header.kid && key.kty === 'RSA' && (!key.use || key.use === 'sig') && (!key.alg || key.alg === 'RS256') && (!key.key_ops || key.key_ops.includes('verify')))
  if (keys.length !== 1) throw fail('INVALID_SIGNING_KEY')
  try {
    const key = createPublicKey({ key: keys[0], format: 'jwk' })
    if (!verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'))) throw fail('INVALID_SIGNATURE')
  } catch { throw fail('INVALID_SIGNATURE') }
  const now = Date.now() / 1000
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  if (claims.iss !== ISSUER || !audiences.includes(clientId) || (audiences.length > 1 && claims.azp !== clientId) || (claims.azp !== undefined && claims.azp !== clientId) || !Number.isFinite(claims.exp) || claims.exp <= now || (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > now)) || typeof claims.sub !== 'string' || !claims.sub) throw fail('INVALID_CLAIMS')
  if (nonce !== undefined && !equal(claims.nonce, nonce)) throw fail('INVALID_NONCE')
  if (subject !== undefined && !equal(claims.sub, subject)) throw fail('ACCOUNT_MISMATCH')
  return claims
}

async function tokenRequest(params, signal) {
  return jsonFetch(TOKEN_ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams(params), signal })
}

function credentialRecord(previous, tokens, claims, clientId, hostId) {
  if (typeof tokens.access_token !== 'string' || !tokens.access_token || typeof tokens.token_type !== 'string' || tokens.token_type.toLowerCase() !== 'bearer' || !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0) throw fail('INVALID_TOKEN_RESPONSE')
  const scopes = typeof tokens.scope === 'string' ? [...new Set(tokens.scope.split(/\s+/).filter(Boolean))] : previous?.scopes
  if (!Array.isArray(scopes)) throw fail('INVALID_TOKEN_RESPONSE')
  const refreshToken = tokens.refresh_token ?? previous?.refresh_token
  if (typeof refreshToken !== 'string' || !refreshToken) throw fail('MISSING_REFRESH_TOKEN')
  const now = Date.now()
  return {
    ...previous,
    email: typeof claims?.email === 'string' ? claims.email : previous?.email,
    issuer: ISSUER, subject: claims?.sub ?? previous?.subject,
    client_id: clientId, ext_agent_host_id: hostId,
    id_token: tokens.id_token ?? previous?.id_token,
    access_token: tokens.access_token, refresh_token: refreshToken,
    token_type: 'Bearer', expires_in: tokens.expires_in, scopes,
    saved_at: new Date(now).toISOString(), expires_at: now + tokens.expires_in * 1000,
  }
}

export async function beginLogin({ hostId, registration, signal, onSuccess }) {
  if (typeof hostId !== 'string' || !hostId || typeof onSuccess !== 'function') throw fail('INVALID_OPTIONS')
  if (signal?.aborted) throw fail('CANCELLED')
  if (registration && (registration.ext_agent_host_id !== hostId || registration.issuer !== ISSUER || typeof registration.subject !== 'string' || !registration.subject)) throw fail('INVALID_REGISTRATION')
  const clientId = registration ? issuedClient(registration.client_id) : 'dynamic_agent_client'
  const state = randomBytes(32).toString('base64url')
  const nonce = randomBytes(32).toString('base64url')
  const verifier = randomBytes(32).toString('base64url')
  const controller = new AbortController()
  let settled = false
  let processing = false
  let timeout
  let resolveDone, rejectDone
  const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject })
  done.catch(() => {})
  const server = createServer()
  server.requestTimeout = 10_000
  server.headersTimeout = 10_000
  server.maxHeadersCount = 32
  let closing
  const cleanup = () => {
    if (closing) return closing
    clearTimeout(timeout)
    signal?.removeEventListener('abort', cancel)
    closing = new Promise(resolve => {
      server.close(() => resolve())
      server.closeAllConnections()
    })
    return closing
  }
  const cancel = () => {
    if (settled) return cleanup()
    settled = true
    controller.abort()
    const closed = cleanup()
    closed.then(() => rejectDone(fail('CANCELLED')))
    return closed
  }
  let redirectUri
  server.on('request', async (request, response) => {
    response.setHeader('content-type', 'text/plain; charset=utf-8')
    response.setHeader('cache-control', 'no-store')
    response.setHeader('referrer-policy', 'no-referrer')
    const deny = () => { response.writeHead(400); response.end('Authorization callback rejected.') }
    if (request.method !== 'GET' || !request.url || request.url.length > 16_384 || settled || processing) return deny()
    let callback
    try { callback = new URL(request.url, redirectUri) } catch { return deny() }
    if (callback.origin !== new URL(redirectUri).origin || callback.pathname !== '/auth/callback' || request.headers.host !== new URL(redirectUri).host) return deny()
    const params = callback.searchParams
    if (['state', 'code', 'client_id', 'error'].some(key => params.getAll(key).length > 1) || !equal(params.get('state'), state)) return deny()
    processing = true
    try {
      if (params.has('error')) throw fail('AUTHORIZATION_DENIED')
      const callbackClient = params.get('client_id')
      const issued = registration ? clientId : issuedClient(callbackClient)
      if (registration && callbackClient !== null && callbackClient !== clientId) throw fail('CLIENT_MISMATCH')
      const code = params.get('code')
      if (!code) throw fail('MISSING_CODE')
      const tokens = await tokenRequest({ grant_type: 'authorization_code', client_id: issued, code, code_verifier: verifier, redirect_uri: redirectUri, resource: RESOURCE }, controller.signal)
      const claims = await validateIdToken(tokens.id_token, { clientId: issued, nonce, subject: registration?.subject, signal: controller.signal })
      const record = credentialRecord(registration, tokens, claims, issued, hostId)
      if (settled || controller.signal.aborted) throw fail('CANCELLED')
      await onSuccess(record)
      if (settled) return
      settled = true
      response.end('ChatGPT authorization complete. You may close this window.')
      await cleanup()
      resolveDone(record)
    } catch {
      if (!settled) {
        settled = true
        response.writeHead(400)
        response.end('ChatGPT authorization failed. Please start a new sign-in.')
        await cleanup()
        rejectDone(fail('AUTHORIZATION_FAILED'))
      }
    }
  })
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve() })
    })
    server.on('error', cancel)
    if (signal?.aborted) { cancel(); throw fail('CANCELLED') }
    redirectUri = `http://127.0.0.1:${server.address().port}/auth/callback`
    signal?.addEventListener('abort', cancel, { once: true })
    timeout = setTimeout(cancel, 10 * 60_000)
    timeout.unref()
    const url = new URL(`${ISSUER}/api/accounts/authorize`)
    const parameters = { client_id: clientId, ext_agent_host_id: hostId, response_type: 'code', redirect_uri: redirectUri, scope: SCOPES, resource: RESOURCE, state, nonce, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') }
    if (!registration) parameters.agent_name_hint = 'DeepSeek Harness'
    else {
      if (registration.email) parameters.login_hint = registration.email
      if (!registration.scopes?.includes('chatgpt.tokens.use.direct')) parameters.prompt = 'consent'
    }
    url.search = new URLSearchParams(parameters).toString()
    return { url: url.toString(), cancel, done }
  } catch { cancel(); throw fail('LISTENER_FAILED') }
}

export async function revokeRegistration(record, { signal } = {}) {
  if (!record || typeof record.refresh_token !== 'string' || !record.refresh_token) throw fail('INVALID_REGISTRATION')
  const clientId = issuedClient(record.client_id)
  const discovery = await jsonFetch(`${ISSUER}/.well-known/openid-configuration`, { signal })
  if (discovery.issuer !== ISSUER || discovery.revocation_endpoint !== `${ISSUER}/api/accounts/oauth/revoke`) throw fail('INVALID_DISCOVERY')
  let response
  try {
    response = await fetch(discovery.revocation_endpoint, {
      method: 'POST', redirect: 'error',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: record.refresh_token, token_type_hint: 'refresh_token', client_id: clientId }),
      signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(30_000)]),
    })
  } catch { throw fail(signal?.aborted ? 'CANCELLED' : 'NETWORK_ERROR') }
  await response.body?.cancel()
  if (response.status !== 200) throw fail('REVOCATION_FAILED')
}

export async function refreshRegistration(record, { signal } = {}) {
  if (!record || record.issuer !== ISSUER || typeof record.subject !== 'string' || !record.subject || typeof record.refresh_token !== 'string' || !record.refresh_token || typeof record.ext_agent_host_id !== 'string' || !record.ext_agent_host_id) throw fail('INVALID_REGISTRATION')
  const clientId = issuedClient(record.client_id)
  const tokens = await tokenRequest({ grant_type: 'refresh_token', client_id: clientId, refresh_token: record.refresh_token, resource: RESOURCE }, signal)
  const claims = tokens.id_token === undefined ? undefined : await validateIdToken(tokens.id_token, { clientId, subject: record.subject, signal })
  return credentialRecord(record, tokens, claims, clientId, record.ext_agent_host_id)
}
