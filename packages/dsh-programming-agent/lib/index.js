import { REWRITTEN_FILE_REFERENCE, rewriteFileReference } from './file-reference.js'

export { REWRITTEN_FILE_REFERENCE, rewriteFileReference }

export const name = 'file-reference-rewrite'

export const inject = ['systemPrompt']

/**
 * Rewrite the file-reference paragraph for the prompting scope only.
 *
 * The upstream producer registers that section into each agent's own scope, so
 * a row mounted inside an agent preset cannot shadow it by name. The
 * presentation waterfall is scope-filtered: a listener registered here receives
 * the assemblies of agents composed under this preset and no others, which
 * keeps the rewrite out of the other presets and out of profile-level prompt
 * consumers.
 * @param ctx - the preset's scope context.
 */
export function apply(ctx) {
  ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
    const nextAssembly = await next()
    return rewriteFileReference(nextAssembly)
  })
}
