/** Section name registered by `@deepseek-ai/dsh-file-reference-local`. */
const SECTION_NAME = 'context:file-reference'

/** Opening words of the upstream paragraph this module replaces. */
const UPSTREAM_OPENING = 'Tokens prefixed with @'

/** The same path rules, phrased so the paragraph is not the upstream wording. */
export const REWRITTEN_FILE_REFERENCE = 'An @ token marks a path the user picked on purpose. '
  + 'A path ending in a slash is a directory: list it when what it contains matters. '
  + 'Any other path is a file: read it before using what is inside, and never describe a file you have not read. '
  + 'Relative paths start from the workspace root, absolute ones point at this machine. '
  + 'Wrap a path that contains spaces in double quotes, as in @"...".'

/**
 * Replace the upstream file-reference paragraph with the rewritten one.
 * @param assembly - assembled prompt with its resolved sections.
 * @returns the same assembly, with that section rewritten when it is present.
 */
export function rewriteFileReference(assembly) {
  const sections = Array.isArray(assembly?.sections) ? assembly.sections : []
  const section = sections.find((entry) => entry.name === SECTION_NAME)
  if (section === undefined || typeof section.text !== 'string') return assembly
  if (!section.text.startsWith(UPSTREAM_OPENING)) return assembly
  section.text = REWRITTEN_FILE_REFERENCE
  return assembly
}
