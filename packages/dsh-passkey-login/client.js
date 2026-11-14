window.__ModuleLoader__.load({
  id: '@tnzzzhlp/dsh-passkey-login',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const namespace = 'passkeyLoginSettings'
    const messages = {
      en: {
        title: 'Passkey', description: 'Bind a passkey to sign in to this DSH instance. You must already be signed in as the owner.',
        bind: 'Bind passkey', working: 'Waiting for passkey…', success: 'Passkey bound successfully.',
        unsupported: 'Passkeys require a secure context and a supported browser.',
        cancelled: 'Passkey setup was cancelled or timed out. Try again.',
        failed: 'Could not bind the passkey. Check your owner session and try again.',
      },
      zh: {
        title: 'Passkey', description: '绑定 Passkey 以登录此 DSH 实例。请先以所有者身份登录。',
        bind: '绑定 Passkey', working: '正在等待 Passkey 验证…', success: 'Passkey 绑定成功。',
        unsupported: 'Passkey 需要安全连接和受支持的浏览器。',
        cancelled: 'Passkey 设置已取消或超时，请重试。',
        failed: '无法绑定 Passkey。请检查所有者登录状态后重试。',
      },
    }
    const decode = value => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=')), c => c.charCodeAt(0))
    const encode = value => {
      const bytes = new Uint8Array(value)
      let binary = ''
      for (const byte of bytes) binary += String.fromCharCode(byte)
      return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    }
    async function post(path, data) {
      const response = await fetch(path, { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
      if (!response.ok) throw new Error('request failed')
      return response.json()
    }
    async function register() {
      const options = await post('/passkey/register/options', {})
      const publicKey = { ...options, challenge: decode(options.challenge), user: { ...options.user, id: decode(options.user.id) }, excludeCredentials: (options.excludeCredentials || []).map(item => ({ ...item, id: decode(item.id) })) }
      const credential = await navigator.credentials.create({ publicKey })
      if (!credential || !credential.response) throw new Error('missing credential')
      const response = credential.response
      const result = await post('/passkey/register/verify', {
        id: credential.id, rawId: encode(credential.rawId), type: credential.type,
        authenticatorAttachment: credential.authenticatorAttachment,
        clientExtensionResults: credential.getClientExtensionResults(),
        response: { clientDataJSON: encode(response.clientDataJSON), attestationObject: encode(response.attestationObject), transports: response.getTransports ? response.getTransports() : [] },
      })
      if (result?.ok !== true) throw new Error('verification failed')
    }
    function Settings({ t }) {
      const [busy, setBusy] = React.useState(false)
      const [status, setStatus] = React.useState('')
      const pending = React.useRef(false)
      const mounted = React.useRef(true)
      React.useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
      const supported = typeof window !== 'undefined' && window.isSecureContext && typeof navigator !== 'undefined' && !!navigator.credentials?.create && typeof window.PublicKeyCredential !== 'undefined'
      async function bind() {
        if (pending.current || !supported) return
        pending.current = true
        setBusy(true)
        setStatus('working')
        try { await register(); if (mounted.current) setStatus('success') }
        catch (error) { if (mounted.current) setStatus(error?.name === 'NotAllowedError' ? 'cancelled' : 'failed') }
        finally { pending.current = false; if (mounted.current) setBusy(false) }
      }
      return h('section', { className: 'passkey-login-settings' },
        h('style', null, '.passkey-login-settings{color:var(--dsw-alias-label-primary);padding:16px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}.passkey-login-settings h3{font-size:14px;font-weight:600;margin:0 0 4px}.passkey-login-settings p{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);margin:0 0 12px}.passkey-login-settings button{font:inherit;color:var(--dsw-alias-label-primary);background:transparent;border:1px solid var(--dsw-alias-border-l3);border-radius:6px;padding:6px 12px;cursor:pointer}.passkey-login-settings button:disabled{opacity:.5;cursor:not-allowed}.passkey-login-settings .passkey-login-status{margin:10px 0 0;overflow-wrap:anywhere}'),
        h('h3', null, t('title')),
        h('p', null, t('description')),
        h('button', { type: 'button', disabled: busy || !supported, onClick: bind }, t(busy ? 'working' : 'bind')),
        h('p', { className: 'passkey-login-status', role: 'status', 'aria-live': 'polite' }, !supported ? t('unsupported') : status ? t(status) : ''),
      )
    }
    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(namespace, messages), 'passkey settings locale')
        ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({ name: 'plugins.bundle.config', key: '@tnzzzhlp/dsh-passkey-login', locale: namespace }, Settings))
      },
    }
  },
})
