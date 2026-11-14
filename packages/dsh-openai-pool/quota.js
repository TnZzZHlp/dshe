const endpoints = {
  costs: 'https://api.openai.com/v1/organization/costs',
  completions: 'https://api.openai.com/v1/organization/usage/completions',
}

async function readBuckets(endpoint, key, start, end, signal) {
  const buckets = []
  const seen = new Set()
  let page
  for (let count = 0; count < 32; count++) {
    const url = new URL(endpoint)
    url.searchParams.set('start_time', String(start))
    url.searchParams.set('end_time', String(end))
    url.searchParams.set('bucket_width', '1d')
    url.searchParams.set('limit', '31')
    if (page) url.searchParams.set('page', page)
    let response
    try {
      response = await fetch(url, {
        headers: { Authorization: `Bearer ${key}` },
        redirect: 'error',
        signal,
      })
    } catch (error) {
      if (signal?.aborted) throw error
      return { status: 'unavailable', reason: 'network_error' }
    }
    if (!response.ok) {
      return { status: 'unavailable', reason: response.status === 401 || response.status === 403 ? 'admin_key_rejected' : 'http_error', httpStatus: response.status }
    }
    let body
    try {
      body = await response.json()
    } catch {
      return { status: 'unavailable', reason: 'invalid_response' }
    }
    if (!Array.isArray(body?.data) || typeof body.has_more !== 'boolean') return { status: 'unavailable', reason: 'invalid_response' }
    for (const bucket of body.data) {
      if (!Array.isArray(bucket?.results)) return { status: 'unavailable', reason: 'invalid_response' }
      buckets.push(...bucket.results)
    }
    if (!body.has_more) return { status: 'ok', results: buckets }
    if (typeof body.next_page !== 'string' || !body.next_page || seen.has(body.next_page)) return { status: 'unavailable', reason: 'invalid_pagination' }
    seen.add(body.next_page)
    page = body.next_page
  }
  return { status: 'unavailable', reason: 'pagination_limit' }
}

function summarizeCosts(response) {
  if (response.status !== 'ok') return response
  const totals = new Map()
  for (const item of response.results) {
    const value = item?.amount?.value
    const currency = item?.amount?.currency
    if (item?.object !== 'organization.costs.result' || typeof value !== 'number' || !Number.isFinite(value) || typeof currency !== 'string' || !/^[a-z]{3}$/.test(currency)) return { status: 'unavailable', reason: 'invalid_response' }
    totals.set(currency, (totals.get(currency) ?? 0) + value)
  }
  return { status: 'ok', totals: [...totals].map(([currency, value]) => ({ currency, value })) }
}

function summarizeCompletions(response) {
  if (response.status !== 'ok') return response
  const totals = { inputTokens: 0, outputTokens: 0, requests: 0 }
  for (const item of response.results) {
    if (item?.object !== 'organization.usage.completions.result' || ![item.input_tokens, item.output_tokens, item.num_model_requests].every(value => Number.isSafeInteger(value) && value >= 0)) return { status: 'unavailable', reason: 'invalid_response' }
    totals.inputTokens += item.input_tokens
    totals.outputTokens += item.output_tokens
    totals.requests += item.num_model_requests
    if (!Object.values(totals).every(Number.isSafeInteger)) return { status: 'unavailable', reason: 'invalid_response' }
  }
  return { status: 'ok', ...totals }
}

export function registerQuotaTool(ctx, config = {}) {
  return ctx.tools.register({
    name: 'openai_organization_usage',
    description: 'Show OpenAI organization costs and completions usage for the current UTC month. Requires an administrator API key; does not report balance or remaining quota.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    timeoutMs: 30000,
    async execute(_args, exec) {
      const reference = config.adminKeyEnv
      if (typeof reference !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(reference)) return JSON.stringify({ status: 'unavailable', reason: 'admin_key_not_configured', balance: 'unavailable' })
      const key = process.env[reference]
      if (!key) return JSON.stringify({ status: 'unavailable', reason: 'admin_key_not_configured', balance: 'unavailable' })
      const now = new Date()
      const start = Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) / 1000)
      const end = Math.floor(now.getTime() / 1000)
      const timeout = AbortSignal.timeout(30000)
      const signal = exec.signal ? AbortSignal.any([exec.signal, timeout]) : timeout
      const [costs, completions] = await Promise.all([
        readBuckets(endpoints.costs, key, start, end, signal),
        readBuckets(endpoints.completions, key, start, end, signal),
      ])
      return JSON.stringify({ period: { start, end, timezone: 'UTC' }, balance: 'unavailable', costs: summarizeCosts(costs), completions: summarizeCompletions(completions) })
    },
  })
}
