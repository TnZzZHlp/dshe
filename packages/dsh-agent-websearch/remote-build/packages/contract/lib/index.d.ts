import { Context } from '@deepseek-ai/cordis';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
declare module '@deepseek-ai/cordis' {
    interface Context {
        agentWebsearchModels: AgentWebsearchModels;
    }
}
export declare class AgentWebsearchModels extends TypertRemoteService {
    private readonly provider;
    constructor(ctx: Context, provider: {
        listModels(signal: AbortSignal): Promise<{
            models: {
                id: string;
                name: string;
            }[];
        }>;
    });
    listModels(signal: AbortSignal): Promise<{
        models: {
            id: string;
            name: string;
        }[];
    }>;
}
