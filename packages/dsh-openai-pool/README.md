# OpenAI 组织用量

此 bundle 提供 `openai_organization_usage` 工具，用于查询当前 UTC 月的 OpenAI 组织费用和模型用量。它不提供账户余额、自动账号切换或图形化额度面板，也不注册模型提供商。

在 DSH 的插件管理页面添加此本地目录。配置插件的 `adminKeyEnv` 为保存 OpenAI Admin API key 的环境变量名称，并确保启动 DSH 的进程可以读取该环境变量。不要把密钥本身写进配置或聊天。然后让智能体调用 `openai_organization_usage`。该工具返回组织费用、completions 输入和输出 token 数及请求数；未配置密钥或查询失败时返回不可用状态。查询结果是组织级用量，并非各账号余额。管理员密钥权限较高，只有在信任该 DSH 实例及其运行环境时才应配置。

DSH 自带的 `@deepseek-ai/dsh-llm-pi-ai` 可配置 OpenAI API 模型和多个独立路由，每个路由使用单独的 `apiKeyEnv` 凭据引用；切换路由需要手动选择。本 bundle 不会自动创建这些路由，也不会在请求失败时自动切换。

参考 [OpenAI 用量 API](https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage/methods/completions)、[费用 API](https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage/methods/costs) 和 [限流说明](https://developers.openai.com/api/docs/guides/rate-limits)。
