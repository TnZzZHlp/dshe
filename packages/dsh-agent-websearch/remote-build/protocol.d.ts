declare module '@deepseek-ai/dsh-typert-protocol' {
  import { Context, Service } from '@deepseek-ai/cordis'
  export abstract class TypertRemoteService extends Service { constructor(ctx: Context, key: string) }
  export function Remote(name: string): <This extends object, Args extends unknown[], Result>(method: (this: This, ...args: Args) => Result, context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>) => void
}
