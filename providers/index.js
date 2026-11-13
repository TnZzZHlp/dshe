import { assertProviderDefinition } from '../lib/provider.js'
import agyProvider from './agy.js'

/**
 * Static provider registry. To add a provider, create `providers/<id>.js`
 * exporting an object that satisfies the provider interface described in
 * `providers/README.md`, then add it to this list.
 */
const entries = [agyProvider]

export const providers = entries.map(definition => assertProviderDefinition(definition, `providers/${definition.id}.js`))

export default providers
