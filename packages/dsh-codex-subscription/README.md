# Codex 订阅

这是 DeepSeek Harness 的 Host bundle，使用 OpenAI 的 Sign in with ChatGPT 开源应用授权流程，直接调用 `https://api.openai.com/v1/models` 和 `https://api.openai.com/v1/responses`。不需要 API key，不使用 Codex CLI、app-server 或 ChatGPT 非公开 backend-api。

## 安装与使用

本仓库以 Git 中的独立 bundle 发布，与其他插件一样不发布到 npm registry。从仓库根目录安装：

```sh
dsh plugin --profile web add ./packages/dsh-codex-subscription
```

也可以在 DSH 的 **插件 → 添加插件** 中选择本目录。CLI 安装后重启对应 profile；实际是否热加载以插件管理界面的结果为准。适配目标是 DSH `0.2.2-rc.2`、Node.js 22 及以上；插件需要 `llm`、`credentials`、`commands` 和 `tools` 服务。Host API 从当前 `DSH_INSTALL_DIR` 安装锚点的公开导出解析，插件没有外部运行时依赖。

1. 在聊天输入框执行 `/codex login personal`，打开返回的 **Continue with ChatGPT** 官方授权链接，并同意使用 ChatGPT 套餐。授权在浏览器中完成，不要把密码、回调 URL 或令牌发给智能体。
2. 执行 `/codex status` 确认登录，再从模型选择器选择 **Codex subscription** 下的模型。模型目录来自当前账号的官方接口，不预置套餐权限。
3. 添加另一个账号时执行 `/codex login work`。`personal`、`work` 是你选择的本地账号标识，可以替换为小写字母开头、最多 48 字符的小写字母、数字或连字符。
4. `/codex use personal` 选择首选账号；`/codex logout personal` 撤销该账号会话并清除本地令牌；`/codex cancel personal` 取消待完成的登录。

回调监听于 DSH 主机 `127.0.0.1` 随机端口，路径固定 `/auth/callback`。浏览器必须能访问该端口。自托管远程主机可根据授权 URL 的 `redirect_uri` 建立对应的 SSH 本地端口转发后再完成登录；回调端口不会公开监听到网络。授权等待最多十分钟。

## 多账号与切换

每个账号分别保存已验证的 OpenAI 身份、独立 issued client ID、access/refresh token 和授权 scopes；同一个 host ID 持久复用。刷新通过 DSH 凭据服务的排他事务串行执行，不在配置或前端保存令牌。

默认启用自动切换。仅当官方明确返回 `subscription_sharing_usage_limit_exceeded`，且当前请求没有向 DSH 输出任何块时，才尝试另一个已授权且拥有同一模型的账号。每个账号每次请求最多尝试一次，不切换模型、不转 API 计费、不购买 credits。网络错误、授权错误、政策限制和已经输出部分内容的请求不会触发自动切换。

受限账号持久暂停，不猜测恢复时间。用户在官方页面调整限制或确认已恢复后，可执行 `/codex retry personal` 解除该账号的本地暂停。仅使用你获授权使用的账号，并遵守账号、工作区和服务的使用限制；切换不增加任何套餐额度。

插件配置：`autoSwitch` 默认 `true`，`timeoutMs` 默认 `180000`。`models` 是可选的模型元数据覆盖数组，每项包括 `id`、可选 `name` 和 `contextWindow`；不向账号授予模型访问权限。

## 用量展示与限制

`/codex status` 显示首选账号、授权/暂停状态及最近一次请求的输入、输出和缓存 token。智能体也可以调用只读工具 `codex_subscription_status` 查看相同信息；登录、选择和重试只提供用户命令。

**这不是订阅剩余额度百分比。** 官方 SIWC 文档目前没有公开该流程的剩余百分比或重置时间查询接口，插件会明确显示不可用，并提供 https://chatgpt.com/settings/usage 。单次 token 用量不能用于推算余额；限制错误也可能是应用限制，而不是整个套餐耗尽。

当前提供文本与 DSH function tools；图片按 DSH 的文本模型规则投影为附件提示，不直接发送图片。完整历史每次发送，不使用 `previous_response_id`。加密 reasoning 仅在账号、模型与块结构匹配时回传；跨账号不复用加密 reasoning，思考摘要不混入普通历史文本。保留 assistant commentary/final_answer 阶段。不提供思考级别选择或托管工具；请求显式设置 `temperature`、`maxTokens` 或 `stop` 时会明确拒绝，不会静默忽略。界面采用 DSH 原生命令结果，不另开网页面板。

OpenAI 的该授权流程是预览能力，账号、工作区、地域或集成开通状态可能使授权或推理不可用。开源、本地与自托管适用范围以官方条款为准；付费或远程托管服务需遵循官方申请要求。插件未通过真实订阅账号的端到端验证，需要安装后由用户授权完成联调。

DSH 默认本地凭据存储限制其他系统用户访问，但不是同用户运行的智能体工具的隔离边界。

## 官方依据

- [开源与本地应用概览](https://developers.openai.com/siwc/token-sharing-open-source)
- [注册、PKCE 和身份验证](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [多账号、刷新和撤销](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)
- [模型与官方推理端点](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [请求能力限制](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
- [错误恢复与订阅用量限制](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery)
