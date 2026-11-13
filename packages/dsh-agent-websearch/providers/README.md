# 搜索提供方接口

`dsh-agent-websearch` 本身不绑定任何搜索引擎。每个提供方是一个独立模块，插件负责把启用的提供方注册到 DSH 的 Web 运行时，并提供一个中立的 `agent_web_search` 工具。

## 目录约定

```
providers/
  index.js        # 静态注册表：新增提供方时只改这里
  agy.js          # 内置提供方：本机 agy CLI
  <id>.js         # 你新增的提供方
```

`providers/index.js` 当前内容：

```js
import agyProvider from './agy.js'

const entries = [agyProvider]

export const providers = entries.map(definition =>
  assertProviderDefinition(definition, `providers/${definition.id}.js`),
)
```

新增提供方只需两步：

1. 创建 `providers/<id>.js`，默认导出提供方定义（见下）；
2. 把该模块加入 `entries` 数组。

定义会在模块加载时由 `assertProviderDefinition()` 校验，字段写错会直接让 bundle 加载失败并给出具体路径。

## 提供方定义

```js
export default {
  id: 'my-provider',                       // 必填，小写字母开头，仅小写字母/数字/连字符，≤32 字符
  title: 'My Provider',                    // 必填，string 或 { en, zh? }
  description: { en: '...', zh: '...' },   // 必填，string 或 { en, zh? }
  normalizeConfig(rawSection) {},          // 可选，校验并补全配置
  create(config) {},                       // 必填，返回提供方实例
}
```

- `id` 在**整个 DSH 进程内必须唯一**。若与另一个已启用 bundle 的提供方重名，Web 运行时会报 `WEB_DUPLICATE_PROVIDER`，插件加载失败。
- `description` 使用 DSH 的 `LocalizedText` 规则：`{ en: '...' }` 里的英文必须存在，`zh` 可选。
- 插件只会把用户配置里的 `providers.<id>` 段（去掉通用的 `enabled` 键）交给 `normalizeConfig`；未知键由提供方自己拒绝并列出支持项，这样各提供方的配置可以自由扩展。
- 插件不导入任何 `@deepseek-ai/*` 包，提供方模块也不要导入。通过 `link:` 本地目录安装的 bundle 会按真实路径解析，导入 DSH 内部包会失败；请只使用 Node 内置模块（`node:fs`、`node:path`、`node:child_process` 等）。bundle 自己的相对 ESM 导入没有问题。

## 提供方实例

`create(config)` 返回一个普通对象：

```js
{
  status() {},                    // 必填，同步返回 { available: boolean, reason?: string }
  async ready() {},               // 可选，异步返回 boolean；缺省时插件用 status()
  async search(request, signal) {},// 必填，request = { query, maxResults? }
  async searchMany(request, signal) {}, // 可选，request = { queries, maxResults }，返回合并结果
  toolTimeoutMs(maxQueries) {},   // 可选，返回整数毫秒，用于给 agent_web_search 估算超时
  async dispose() {},             // 可选，插件卸载时调用
}
```

### `status()` 与可用性

`status()` 必须**同步**返回，因为 DSH 的 `available()` 是同步接口（插件设置页也会同步读取）。它每次都可能被调用，应该只做轻量检查（例如 `access()`、读取登录文件是否存在），不要启动进程或联网。

- `{ available: false, reason: '...' }` 里的 `reason` 会出现在 `agent_web_search` 的错误信息中，写清楚缺什么、怎么修。
- 插件对 `status()` 抛错做了保护：注册的 `available()` 会返回 `false`；但工具执行时会重新读取并报错。
- `ready()` 可以执行更重的准备（例如启动一次探测），失败时返回 `false`。

### `search()`

- `request.query` 已由插件 trim 并保证非空；`request.maxResults` 可能是 `undefined`，表示使用提供方默认值。
- `signal` 是 `AbortSignal`。**必须传递并观察它**：取消时尽快停止工作，并抛出 `abortError()`（来自 `lib/errors.js`）或任何 `name === 'AbortError'` 的错误。工具层会原样把取消错误交还宿主，不会包装成提供方失败。
- 返回 `{ content?, sources, truncated }`：
  - `sources` 每项是 `{ url, title?, snippet?, publishedAt? }`，`url` 必须是 http(s)；插件会统一去重并限制数量。
  - `content` 是可选的综合答案。
  - `truncated` 表示源列表是否因上限被截断。
- 单个查询失败时抛错即可；多查询时每个查询独立调用 `search()`，插件会并行执行、合并结果。

### `searchMany()`

可选。提供方如果需要自行控制多查询的并发、共享会话或批量合并，可以实现它；插件检测到该方法时会优先调用，并把规范化的工作交给提供方（返回值仍会被插件再校验一次）。没有实现时，插件的行为是：

1. 一批 `search()` 并行执行；
2. 任一查询失败即取消其余查询并抛出该错误（不返回部分结果）；
3. 全部成功后按查询顺序做排名交错合并（每个查询的第一条依次排列，依此类推），URL 去重。

### `toolTimeoutMs()`

可选。`agent_web_search` 的超时优先级：

1. 插件配置 `tool.timeoutMs`；
2. 所有启用提供方 `toolTimeoutMs(tool.maxQueries)` 的最大值，至少 120 秒；
3. 都没有时 120 秒。

agy 提供方的提示值为 `max(60s, timeoutMs × ceil(maxQueries / 并发槽数) + 30s)`，因为一次 agy 会话本身就要约 15-30 秒，超过并发槽数的查询会排队。

### `dispose()`

可选。插件卸载或重载时调用（实现为 Cordis fiber 的清理函数），用于终止仍在运行的子进程、关闭连接或释放临时资源。清理错误不会中断其他提供方的清理。

## 配置

```yaml
- id: agent-websearch
  name: 'dsh-agent-websearch'
  config:
    provider: agy                 # 默认提供方 id；缺省为第一个启用的提供方
    tool:
      maxResults: 6               # 1-10
      maxQueries: 3               # 1-10
      timeoutMs: 120000           # 可选，10000-900000
    providers:
      agy:
        enabled: true             # 通用键，插件消费，不会传给 agy 的 normalizeConfig
        effort: low
        timeoutMs: 120000
        maxConcurrent: 3
```

`providers.<id>` 中除 `enabled` 外的键由提供方定义；未知提供方 id 和未知顶层键都会被插件拒绝。

## 并发约定

- 工具本身声明 `isConcurrencySafe: () => true`，因此 DSH 可以并发调用 `agent_web_search`。
- 单个提供方实例被多个工具调用共享；有状态资源（进程槽、连接池）请在实例内部用队列/池管理，并对每槽资源做隔离（agy 的做法见下）。
- 不要在模块顶层执行副作用；所有资源在 `create()` 里初始化。

## 内置 agy 提供方作为参考

`providers/agy.js` 是完整示例：配置校验、CLI 解析、登录状态播种、按槽隔离的 HOME、`SlotPool` 并发控制、子进程超时/取消、`searchMany` 并行合并、`dispose()` 终止子进程。实现新提供方时建议先读该文件顶部的导入和 `create()` 结构。
