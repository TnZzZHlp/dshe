import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const anchor = process.env.DSH_INSTALL_DIR
  ? pathToFileURL(join(process.env.DSH_INSTALL_DIR, 'package.json'))
  : import.meta.url
const require = createRequire(anchor)
const llm = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')).href)
const schema = await import(pathToFileURL(require.resolve('@deepseek-ai/schemastery')).href)

export const { LlmAdapter, LlmError, attributionHeaders } = llm
export const Schema = schema.default
