import { fileURLToPath } from 'node:url'
import { WorkspaceTypertGenerator, writeWorkspaceArtifacts } from '@deepseek-ai/dsh-typert-generator'

const root = fileURLToPath(new URL('.', import.meta.url))
const artifacts = new WorkspaceTypertGenerator(root).generate(undefined, ['host'])
writeWorkspaceArtifacts(root, artifacts)
