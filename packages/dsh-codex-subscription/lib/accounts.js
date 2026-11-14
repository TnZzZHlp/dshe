import { randomUUID } from 'node:crypto'
import { attributionHeaders } from './host.js'
import { beginLogin, refreshRegistration, revokeRegistration } from './oauth.js'
import { readJsonBody } from './http.js'

const scope = 'codex-subscription'
const terminalRefresh = new Set(['INVALID_GRANT', 'INVALID_REFRESH_TOKEN', 'TOKEN_EXPIRED', 'REFRESH_TOKEN_EXPIRED', 'REFRESH_TOKEN_INVALIDATED', 'REFRESH_TOKEN_REUSED'])
const keyOf = id => `${scope}/account-${id}`
const validId = id => typeof id === 'string' && /^[a-z][a-z0-9-]{0,47}$/.test(id)

export class AccountPool {
  constructor(credentials, config, updated = () => {}) {
    this.credentials = credentials
    this.config = config
    this.updated = updated
    this.pending = new Map()
    this.states = new Map()
    this.disposed = false
  }

  async init() {
    await this.credentials.modifyRecord(`${scope}/host`, current => {
      if (current?.payload?.hostId) return undefined
      return { kind: 'grant', payload: { hostId: `urn:uuid:${randomUUID()}` } }
    })
  }

  async accounts() {
    const records = await this.credentials.listRecords()
    const result = []
    for (const { key } of records) {
      if (!key.startsWith(`${scope}/account-`)) continue
      const id = key.slice(`${scope}/account-`.length)
      if (!validId(id)) continue
      const record = await this.credentials.readRecord(key)
      const payload = record?.payload
      if (!payload) continue
      result.push({ id, label: payload.label || id, email: payload.email, enabled: Boolean(payload.access_token && payload.scopes?.includes('chatgpt.tokens.use.direct')), paused: Boolean(payload.paused), ...this.states.get(id) })
    }
    return result
  }

  async available() {
    const host = await this.credentials.readRecord(`${scope}/host`)
    const all = await this.accounts()
    const preferred = host?.payload?.active
    if (!this.config.autoSwitch && preferred) return all.filter(account => account.id === preferred && account.enabled && !account.paused)
    const accounts = all.filter(account => account.enabled && !account.paused)
    accounts.sort((a, b) => Number(b.id === preferred) - Number(a.id === preferred))
    return this.config.autoSwitch ? accounts : accounts.slice(0, 1)
  }

  async login(id, signal) {
    if (!validId(id)) throw new Error('账号 ID 只能包含小写字母、数字和连字符，必须以字母开头，最多 48 字符。')
    if (this.disposed) throw new Error('插件已停止。')
    if (this.pending.has(id)) throw new Error('该账号正在登录；请先完成或取消登录。')
    const marker = { cancel() {} }
    this.pending.set(id, marker)
    try {
      const current = await this.credentials.readRecord(keyOf(id))
      const host = await this.credentials.readRecord(`${scope}/host`)
      if (this.disposed || this.pending.get(id) !== marker) throw new Error('登录已取消。')
      const attempt = await beginLogin({
        hostId: host.payload.hostId,
        registration: current?.payload,
        signal,
        onSuccess: async registration => {
          if (this.disposed || this.pending.get(id) !== marker) throw new Error('登录已取消。')
          await this.credentials.modifyRecord(keyOf(id), () => {
            if (this.disposed || this.pending.get(id) !== marker) throw new Error('登录已取消。')
            return { kind: 'grant', payload: { ...registration, label: id, paused: false } }
          })
          this.states.delete(id)
          await this.markActive(id)
          this.updated()
        },
      })
      marker.cancel = attempt.cancel
      if (this.disposed || this.pending.get(id) !== marker) {
        await attempt.cancel()
        throw new Error('登录已取消。')
      }
      marker.url = attempt.url
      attempt.done.then(() => {
        if (this.pending.get(id) === marker) this.pending.delete(id)
      }, () => {
        if (this.pending.get(id) === marker) {
          this.pending.delete(id)
          this.recordError(id, 'LOGIN_FAILED')
        }
      })
      return { url: attempt.url }
    } catch {
      if (this.pending.get(id) === marker) this.pending.delete(id)
      throw new Error('无法启动 OpenAI 登录；请检查网络、回调端口与凭据存储。')
    }
  }

  async cancel(id) {
    const attempt = this.pending.get(id)
    this.pending.delete(id)
    await attempt?.cancel()
  }

  async accessToken(id, { signal } = {}) {
    let token
    let failed
    await this.credentials.modifyRecord(keyOf(id), async current => {
      const record = current?.payload
      if (!record?.access_token || !record.scopes?.includes('chatgpt.tokens.use.direct')) throw new Error('该账号尚未授权订阅用量。')
      if (record.expires_at > Date.now() + 60000) {
        token = record.access_token
        return undefined
      }
      try {
        const next = await refreshRegistration(record, { signal })
        if (next.scopes?.includes('chatgpt.tokens.use.direct')) token = next.access_token
        else failed = true
        return { kind: 'grant', payload: { ...next, label: record.label || id } }
      } catch (error) {
        failed = true
        if (!terminalRefresh.has(error?.code)) return undefined
        this.recordError(id, 'LOGIN_REQUIRED')
        const { access_token, refresh_token, id_token, ...identity } = record
        return { kind: 'grant', payload: identity }
      }
    })
    if (failed || !token) throw new Error('订阅授权暂不可用；请检查连接，必要时重新登录。')
    return token
  }

  async models(id, { signal } = {}) {
    const token = await this.accessToken(id, { signal })
    const timeout = AbortSignal.timeout(30000)
    const response = await fetch('https://api.openai.com/v1/models', {
      headers: { ...attributionHeaders(), Authorization: `Bearer ${token}` },
      redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`OpenAI 模型列表不可用 (HTTP ${response.status})。`)
    }
    const body = await readJsonBody(response)
    if (!Array.isArray(body.models)) throw new Error('OpenAI 未返回订阅模型列表。')
    const ids = new Set()
    return body.models.filter(model => model.visibility === 'list' && typeof model.slug === 'string' && model.slug && !ids.has(model.slug) && ids.add(model.slug)).map(model => ({
      id: model.slug,
      name: typeof model.display_name === 'string' ? model.display_name : model.slug,
      ...(Number.isSafeInteger(model.context_window) && model.context_window > 0 ? { contextWindow: model.context_window } : {}),
    }))
  }

  async markLimited(id, error) {
    await this.credentials.modifyRecord(keyOf(id), current => current ? { kind: 'grant', payload: { ...current.payload, paused: true } } : undefined)
    const previous = this.states.get(id) || {}
    this.states.set(id, { ...previous, error: 'subscription_sharing_usage_limit_exceeded' })
    this.updated()
  }

  recordError(id, code) {
    this.states.set(id, { ...this.states.get(id), error: code })
  }

  observeUsage(id, usage) {
    this.states.set(id, { ...this.states.get(id), lastUsage: usage, error: undefined })
  }

  async markActive(id) {
    await this.credentials.modifyRecord(`${scope}/host`, current => ({ kind: 'grant', payload: { ...current.payload, active: id } }))
  }

  async select(id) {
    if (!(await this.accounts()).some(account => account.id === id)) throw new Error('找不到该账号。')
    await this.markActive(id)
    this.updated()
  }

  async retry(id) {
    if (!validId(id)) throw new Error('无效的账号 ID。')
    await this.credentials.modifyRecord(keyOf(id), current => {
      if (!current) throw new Error('找不到该账号。')
      return { kind: 'grant', payload: { ...current.payload, paused: false } }
    })
    this.states.delete(id)
    this.updated()
  }

  async logout(id) {
    if (!validId(id)) throw new Error('无效的账号 ID。')
    await this.cancel(id)
    let confirmed = true
    await this.credentials.modifyRecord(keyOf(id), async current => {
      if (!current?.payload) throw new Error('找不到该账号。')
      try { await revokeRegistration(current.payload, {}) } catch { confirmed = false }
      const { access_token, refresh_token, id_token, ...identity } = current.payload
      return { kind: 'grant', payload: identity }
    })
    this.states.delete(id)
    this.updated()
    return confirmed
  }

  async status() {
    const host = await this.credentials.readRecord(`${scope}/host`)
    return { active: host?.payload?.active, autoSwitch: this.config.autoSwitch, accounts: await this.accounts(), pending: [...this.pending.keys()], quota: 'not_exposed_by_official_siwc_api', usageUrl: 'https://chatgpt.com/settings/usage' }
  }

  async dispose() {
    this.disposed = true
    const attempts = [...this.pending.values()]
    this.pending.clear()
    await Promise.all(attempts.map(attempt => attempt.cancel()))
  }
}
