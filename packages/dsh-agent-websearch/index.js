import Schema from '@deepseek-ai/schemastery'
import { AgentWebsearchModels } from './remote-build/packages/contract/lib/index.js'
import { TYPERT } from './remote-build/packages/contract/lib/typert.host.js'
import { normalizeConfig } from './lib/config.js'
import { createToolDefinition } from './lib/tool.js'
import { createModelsTool } from './lib/models-tool.js'
import { createSearchLogger } from './lib/search-log.js'
import { createWebSearchProvider } from './lib/web-provider.js'
import { providers as builtinProviders } from './providers/index.js'

export const name = 'dsh-agent-websearch'
export const inject = ['web', 'tools', 'typert']
export const Config = Schema.object({
  providers: Schema.object({
    agy: Schema.object({ model: Schema.string().volatile() }).default({}),
  }).default({}),
}).default({})

/**
 * Register every enabled provider with the web runtime, plus one dedicated
 * provider-neutral search tool. Provider instances own their resources; the
 * fiber effect below disposes them when the plugin is unloaded or reloaded.
 */
export function apply(ctx, rawConfig = {}) {
  const model = rawConfig?.providers?.agy?.model
  const modelSource = model !== null && typeof model === 'object' && typeof model.get === 'function'
    ? model
    : undefined
  const modelValue = modelSource?.get()
  const input = modelSource === undefined ? rawConfig : {
    ...rawConfig,
    providers: {
      ...rawConfig.providers,
      agy: {
        ...rawConfig.providers.agy,
        model: typeof modelValue === 'string' && modelValue.trim() === '' ? undefined : modelValue,
      },
    },
  }
  const config = normalizeConfig(input, builtinProviders)
  if (modelSource !== undefined) {
    const agy = config.entries.find(entry => entry.definition.id === 'agy')
    if (typeof agy?.instance.setModelSource === 'function') agy.instance.setModelSource(modelSource)
  }
  const recordSearch = createSearchLogger(ctx)
  for (const entry of config.entries) {
    ctx.web.registerSearchProvider(createWebSearchProvider(entry, recordSearch))
  }
  ctx.tools.register(createToolDefinition(config, recordSearch))
  const agy = config.entries.find(entry => entry.definition.id === 'agy')
  if (typeof agy?.instance.listModels === 'function') {
    ctx.tools.register(createModelsTool(agy.instance))
    new AgentWebsearchModels(ctx, agy.instance)
    ctx.typert.register(TYPERT)
  }

  const disposable = config.entries.filter(entry => typeof entry.instance.dispose === 'function')
  if (disposable.length > 0) {
    ctx.effect(function* () {
      yield () => {
        for (const entry of disposable) {
          try {
            entry.instance.dispose()
          } catch {
            // Cleanup must not mask the original fiber disposal. The host logs
            // plugin load failures; a failing best-effort kill is not fatal.
          }
        }
      }
    }, 'dsh-agent-websearch provider cleanup')
  }
}
