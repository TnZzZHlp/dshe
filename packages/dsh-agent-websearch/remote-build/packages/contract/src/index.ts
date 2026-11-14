import { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

declare module '@deepseek-ai/cordis' {
  interface Context { agentWebsearchModels: AgentWebsearchModels }
}

export class AgentWebsearchModels extends TypertRemoteService {
  private readonly provider: { listModels(signal: AbortSignal): Promise<{ models: { id: string; name: string }[] }> }

  constructor(ctx: Context, provider: { listModels(signal: AbortSignal): Promise<{ models: { id: string; name: string }[] }> }) {
    super(ctx, 'agentWebsearchModels')
    this.provider = provider
  }

  @Remote('listModels')
  listModels(signal: AbortSignal): Promise<{ models: { id: string; name: string }[] }> {
    return this.provider.listModels(signal)
  }
}
