import { Schema } from './lib/host.js'
import { AccountPool } from './lib/accounts.js'
import { CodexSubscriptionAdapter, PROVIDER } from './lib/adapter.js'
import { registerCommands, registerStatusTool } from './lib/commands.js'

export const name = 'codex-subscription'
export const inject = ['llm', 'credentials', 'commands', 'tools']
export const Config = Schema.object({
  autoSwitch: Schema.boolean().default(true),
  timeoutMs: Schema.number().min(1000).max(1800000).default(180000),
  models: Schema.array(Schema.object({
    id: Schema.string().required(),
    name: Schema.string(),
    contextWindow: Schema.number().min(1),
  })).default([]),
}).default({})

export async function apply(ctx, config) {
  const pool = new AccountPool(ctx.credentials, config, () => ctx.emit('llm/models-updated', PROVIDER))
  ctx.effect(() => () => pool.dispose())
  await pool.init()
  ctx.effect(() => ctx.llm.registerAdapter([PROVIDER], new CodexSubscriptionAdapter(pool, config)))
  ctx.effect(() => registerCommands(ctx, pool))
  ctx.effect(() => registerStatusTool(ctx, pool))
}
