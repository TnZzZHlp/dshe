export function formatStatus(status) {
  const lines = [`Codex 订阅：${status.autoSwitch ? '自动切换已启用' : '手动选择账号'}`]
  for (const account of status.accounts) {
    const state = !account.enabled ? '需要登录或订阅授权' : account.paused ? '用量限制，已暂停' : '已授权'
    lines.push(`${account.id === status.active ? '* ' : '  '}${account.label} (${account.id})：${state}`)
    if (account.lastUsage) lines.push(`  最近请求 token：输入 ${account.lastUsage.inputTokens}，输出 ${account.lastUsage.outputTokens}，缓存读取 ${account.lastUsage.cacheReadTokens || 0}`)
    if (account.error) lines.push(`  状态：${account.error}`)
  }
  if (!status.accounts.length) lines.push('尚未添加账号。使用 /codex login personal 开始。')
  if (status.pending.length) lines.push(`等待浏览器授权：${status.pending.join(', ')}`)
  lines.push('剩余额度与重置时间：官方 SIWC API 未提供，不能从 token 用量推算。', status.usageUrl)
  return lines.join('\n')
}

export function registerCommands(ctx, pool) {
  return ctx.commands.register({
    name: 'codex',
    description: '管理 Codex 订阅账号、登录和用量状态',
    input: { hint: 'status | login <id> | use <id> | retry <id> | cancel <id> | logout <id>' },
    async handler({ rawInput }) {
      const [action = 'status', id, ...extra] = rawInput.trim().split(/\s+/).filter(Boolean)
      if (extra.length || (action !== 'status' && !id)) return { kind: 'error', text: '用法：/codex status 或 /codex login|use|retry|cancel|logout <账号ID>' }
      try {
        if (action === 'status') return { kind: 'success', text: formatStatus(await pool.status()) }
        if (action === 'login') {
          const { url } = await pool.login(id)
          return { kind: 'success', text: `Continue with ChatGPT\n${url}\n请在浏览器中授权订阅用量。登录完成后使用 /codex status 查看。远程部署需把浏览器的回环回调端口转发到 DSH 主机；不要把回调地址或授权码发送到聊天中。` }
        }
        if (action === 'use') await pool.select(id)
        else if (action === 'retry') await pool.retry(id)
        else if (action === 'cancel') await pool.cancel(id)
        else if (action === 'logout') {
          const confirmed = await pool.logout(id)
          return { kind: 'success', text: confirmed ? '已退出并撤销该账号授权会话。' : '已清除本地令牌，但未能确认远程撤销。请在 https://chatgpt.com/settings/usage 断开此应用。' }
        } else return { kind: 'error', text: '未知操作。使用 /codex status 或 login、use、retry、cancel、logout。' }
        return { kind: 'success', text: formatStatus(await pool.status()) }
      } catch (error) {
        return { kind: 'error', text: error instanceof Error ? error.message : '订阅账号操作失败。' }
      }
    },
  })
}

export function registerStatusTool(ctx, pool) {
  return ctx.tools.register({
    name: 'codex_subscription_status',
    description: 'Show authorized Codex subscription accounts, pause states and last-request token usage. Remaining subscription quota is unavailable; no credentials are returned.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute() { return formatStatus(await pool.status()) },
  })
}
