import z from '@deepseek-ai/schemastery'
import { registerQuotaTool } from './quota.js'

export const name = 'openai-organization-usage'
export const inject = ['tools']
export const Config = z.object({
  adminKeyEnv: z.string(),
})

export function apply(ctx, config) {
  ctx.effect(() => registerQuotaTool(ctx, config))
}
