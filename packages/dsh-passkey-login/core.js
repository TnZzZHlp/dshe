import { randomBytes, createHash } from 'node:crypto'
import { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server'

const ORIGIN = 'https://dsh.tnzzz.top'
const RP = 'dsh.tnzzz.top'
const KEY = 'passkey-login/credentials'
const COOKIE = '__Host-dsh-passkey-flow'
const MAX = 64
const TTL = 120000
const b64 = b => Buffer.from(b).toString('base64url')

function record(value) {
  if (value === undefined) return { version: 1, userId: b64(randomBytes(32)), keys: [] }
  if (value?.kind !== 'grant' || value.payload?.version !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(value.payload.userId) || !Array.isArray(value.payload.keys) || value.payload.keys.length > MAX) throw Error('invalid credential store')
  for (const k of value.payload.keys) if (!k || typeof k.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(k.id) || typeof k.publicKey !== 'string' || !/^[A-Za-z0-9_-]+$/.test(k.publicKey) || !Number.isSafeInteger(k.counter) || k.counter < 0 || (k.transports !== undefined && (!Array.isArray(k.transports) || k.transports.some(t => typeof t !== 'string')))) throw Error('invalid credential')
  if (new Set(value.payload.keys.map(k => k.id)).size !== value.payload.keys.length) throw Error('duplicate credential')
  return value.payload
}
function checkRequest(req) {
  if (req.headers.host !== RP || req.headers.origin !== ORIGIN || req.headers['sec-fetch-site'] !== 'same-origin' || req.headers['content-type'] !== 'application/json') throw Error('request rejected')
}
function body(req) {
  return new Promise((resolve, reject) => {
    let chunks = [], length = 0
    req.on('data', chunk => { length += chunk.length; if (length > 65536) { reject(Error('too large')); req.destroy() } else chunks.push(chunk) })
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { reject(Error('bad JSON')) } })
    req.on('error', reject)
  })
}
function send(res, status, value, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers })
  res.end(JSON.stringify(value))
}
function getFlowCookie(req) {
  const found = (req.headers.cookie || '').split(';').map(v => v.trim()).filter(v => v.startsWith(COOKIE + '='))
  return found.length === 1 ? found[0].slice(COOKIE.length + 1) : ''
}
function exchange(connection) {
  const url = new URL(connection.authenticatedUrl(ORIGIN + '/'))
  if (url.origin !== ORIGIN || url.pathname !== '/' || url.searchParams.getAll('token').length !== 1 || [...url.searchParams.keys()].some(k => k !== 'token')) throw Error('unexpected authenticated URL')
  let status, headers, ended = false
  const allowed = connection.authorizeIndex({ method: 'GET', url: url.pathname + url.search, headers: { host: RP } }, { writeHead(s, h) { status = s; headers = h }, end() { ended = true } })
  if (allowed || !ended || status !== 303 || !headers || headers.location !== './' || typeof headers['set-cookie'] !== 'string') throw Error('session exchange failed')
  const cookie = headers['set-cookie']
  const expected = 'dsh-auth-' + createHash('sha256').update(RP).digest('base64url') + '='
  if (!cookie.startsWith(expected) || !/;\s*HttpOnly(?:;|$)/i.test(cookie) || !/;\s*SameSite=Strict(?:;|$)/i.test(cookie) || !/;\s*Path=\/(?:;|$)/i.test(cookie) || /[\r\n]/.test(cookie) || /;\s*Domain=/i.test(cookie)) throw Error('unexpected session cookie')
  const admitted = connection.admit({ headers: { host: RP, origin: ORIGIN, cookie: cookie.split(';', 1)[0] } })
  if (!admitted || 'rejection' in admitted || admitted.peer?.principal?.kind !== 'owner') throw Error('exchanged session is not admissible')
  return /;\s*Secure(?:;|$)/i.test(cookie) ? cookie : cookie + '; Secure'
}
export async function createHandler({ connection, credentials, page }) {
  const flows = new Map()
  const init = await credentials.modifyRecord(KEY, async current => current === undefined ? { kind: 'grant', payload: record() } : (record(current), undefined))
  if (init === undefined) throw Error('credential store initialization failed')
  record(init)
  return async (req, res) => {
    try {
      const path = new URL(req.url, 'http://localhost').pathname
      if (req.method === 'GET' && path === '/passkey') {
        if (req.headers.host !== RP) throw Error('host')
        res.writeHead(303, { location: '/', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }); res.end(); return
      }
      if (req.method !== 'POST') return send(res, 405, { error: 'method' })
      checkRequest(req)
      const input = await body(req)
      const register = path === '/passkey/register/options' || path === '/passkey/register/verify'
      const login = path === '/passkey/login/options' || path === '/passkey/login/verify'
      if (!register && !login) return send(res, 404, { error: 'not found' })
      if (register) {
        const admission = connection.admit({ headers: req.headers })
        if (!admission || 'rejection' in admission || admission.peer?.principal?.kind !== 'owner') return send(res, 401, { error: 'authentication required' })
      }
      if (path.endsWith('/options')) {
        const stored = await credentials.readRecord(KEY)
        if (stored === undefined) throw Error('credential store missing')
        const state = record(stored)
        if (register && state.keys.length >= MAX) throw Error('maximum credentials')
        if (login && !state.keys.length) throw Error('no credentials')
        const list = state.keys.map(k => ({ id: k.id, transports: k.transports }))
        const options = register ? await generateRegistrationOptions({ rpName: 'DSH', rpID: RP, userID: Buffer.from(state.userId, 'base64url'), userName: 'DSH owner', attestationType: 'none', excludeCredentials: list, authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' } }) : await generateAuthenticationOptions({ rpID: RP, userVerification: 'required', allowCredentials: list })
        const now = Date.now(); for (const [id, f] of flows) if (f.expires <= now) flows.delete(id)
        if (flows.size >= 256) throw Error('too many attempts')
        const id = b64(randomBytes(32)); flows.set(id, { challenge: options.challenge, type: register ? 'register' : 'login', expires: now + TTL })
        return send(res, 200, options, { 'set-cookie': `${COOKIE}=${id}; Path=/; Max-Age=120; HttpOnly; Secure; SameSite=Strict` })
      }
      const id = getFlowCookie(req), flow = flows.get(id); flows.delete(id)
      if (!flow || flow.expires <= Date.now() || flow.type !== (register ? 'register' : 'login')) throw Error('expired challenge')
      if (register) {
        const result = await verifyRegistrationResponse({ response: input, expectedChallenge: flow.challenge, expectedOrigin: ORIGIN, expectedRPID: RP, requireUserVerification: true })
        if (!result.verified || !result.registrationInfo) throw Error('verification failed')
        const c = result.registrationInfo.credential
        await credentials.modifyRecord(KEY, async current => {
          if (current === undefined) throw Error('credential store missing')
          const state = record(current)
          if (state.keys.length >= MAX || state.keys.some(k => k.id === c.id)) throw Error('credential already exists')
          return { kind: 'grant', payload: { ...state, keys: [...state.keys, { id: c.id, publicKey: b64(c.publicKey), counter: c.counter, transports: c.transports }] } }
        })
        return send(res, 200, { ok: true })
      }
      let verified = false
      await credentials.modifyRecord(KEY, async current => {
        if (current === undefined) throw Error('credential store missing')
        const state = record(current), k = state.keys.find(item => item.id === input?.id)
        if (!k) throw Error('unknown credential')
        const result = await verifyAuthenticationResponse({ response: input, expectedChallenge: flow.challenge, expectedOrigin: ORIGIN, expectedRPID: RP, requireUserVerification: true, credential: { ...k, publicKey: new Uint8Array(Buffer.from(k.publicKey, 'base64url')) } })
        if (!result.verified) throw Error('verification failed')
        const updated = { ...k, counter: result.authenticationInfo.newCounter }
        verified = true
        return { kind: 'grant', payload: { ...state, keys: state.keys.map(item => item.id === k.id ? updated : item) } }
      })
      if (!verified) throw Error('verification failed')
      return send(res, 200, { ok: true }, { 'set-cookie': exchange(connection) })
    } catch {
      if (!res.headersSent && !res.destroyed) send(res, 400, { error: 'request failed' })
    }
  }
}
export { exchange, record }
