import assert from 'node:assert/strict'
import test from 'node:test'

import { REWRITTEN_FILE_REFERENCE, rewriteFileReference } from '../lib/file-reference.js'

const upstream = 'Tokens prefixed with @ are paths the user explicitly referenced. Relative paths resolve from the workspace root; absolute paths identify files or directories on the host. A trailing slash marks a directory.'

test('the upstream file-reference section is replaced', () => {
  const assembly = { sections: [
    { name: 'harness:identity', text: 'identity' },
    { name: 'context:file-reference', text: upstream },
  ] }
  const rewritten = rewriteFileReference(assembly)
  assert.deepEqual(rewritten.sections, [
    { name: 'harness:identity', text: 'identity' },
    { name: 'context:file-reference', text: REWRITTEN_FILE_REFERENCE },
  ])
})

test('sections that are not the upstream paragraph are left alone', () => {
  const sections = [{ name: 'context:file-reference', text: 'Path notes for this preset.' }]
  assert.deepEqual(rewriteFileReference({ sections }).sections, sections)
})
