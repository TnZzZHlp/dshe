import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

const entryIds = (text) => [...text.matchAll(/^(\s*)- id: '?([\w@/.-]+)'?$/gm)]
  .map(([, indent, id]) => ({ indent: indent.length, id }))

test('the bundle manifest points at the patch and ships it', () => {
  assert.equal(manifest.name, '@tnzzzhlp/dsh-programming-agent')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.exports['./cordis.patch.yml'], './cordis.patch.yml')
  for (const file of ['cordis.patch.yml', 'README.md', 'LICENSE']) {
    assert.equal(manifest.files.includes(file), true, `${file} is published`)
  }
})

test('the profile-wide prompt rows that name the harness are corrected', () => {
  const rows = entryIds(patch).filter((entry) => entry.indent === 0).map((entry) => entry.id)
  assert.deepEqual(rows, ['system-prompt', 'harness-dev-context'])

  const preset = entryIds(patch).filter((entry) => entry.indent === 4).map((entry) => entry.id)
  assert.deepEqual(preset, ['preset-programming'])

  const systemPrompt = patch.slice(
    patch.indexOf('- id: system-prompt'),
    patch.indexOf('- id: harness-dev-context'),
  )
  assert.match(systemPrompt, /includeHarnessIdentity: false/)
  assert.match(systemPrompt, /personaPrefix: You are a coding agent powered by the \{\{model\}\} model\./)

  const devContext = patch.slice(patch.indexOf('- id: harness-dev-context'), patch.indexOf('- insert:'))
  assert.match(devContext, /^  disabled: true$/m)
})

test('the preset keeps its curated plugin order', () => {
  const plugins = entryIds(patch).filter((entry) => entry.indent === 10).map((entry) => entry.id)
  assert.deepEqual(plugins, [
    'persona',
    'agent-instructions',
    'tool-bash',
    'tool-pwsh',
    'tool-fs',
    'tool-fs-search',
    'tool-jobs',
    'skill-filesystem',
    'tool-skill',
    'planning',
    'compaction',
    'delegation',
    'tool-ask-user',
    'tool-todo',
    'tool-web',
  ])
})

test('nothing in the patch text can put the harness name into a prompt', () => {
  assert.equal(patch.includes('DeepSeek Harness'), false)
  assert.equal(patch.includes('deepseek harness'), false)
})
