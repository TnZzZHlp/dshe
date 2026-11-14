export function createModelsTool(instance) {
  return {
    name: 'agy_list_models',
    description: 'List models available to the local agy account.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        properties: {
          models: {
            type: 'array',
            items: {
              type: 'object',
              properties: { id: { type: 'string' }, name: { type: 'string' } },
              required: ['id', 'name'],
              additionalProperties: false,
            },
          },
        },
        required: ['models'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    timeoutMs: 35_000,
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      return instance.listModels(exec?.signal)
    },
  }
}
