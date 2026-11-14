export async function mountModelsRemote(ctx, contribution) {
  const unmount = await ctx.remote.$mount(contribution)
  let fiber
  try {
    let namespace
    fiber = ctx.inject(['remote.agentWebsearchModels'], child => {
      namespace = child.remote.agentWebsearchModels
    })
    await fiber
    return {
      listModels: signal => namespace.listModels(signal),
      async dispose() {
        try {
          await fiber.dispose()
        } finally {
          await unmount()
        }
      },
    }
  } catch (error) {
    try {
      await fiber?.dispose()
    } finally {
      await unmount()
    }
    throw error
  }
}
