# @tnzzzhlp/dsh-agent-websearch

> 本包是 [dshe](../../) 单体仓库的一部分；版本、安装和仓库约定以包内文档为准。

为 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/dsh) 提供**可插拔搜索提供方**的组合包（bundle）。它不绑定具体搜索引擎：当前内置一个通过本机 `agy`（Google Antigravity）CLI 联网搜索的提供方，后续可以按同一接口接入其他模型 CLI、API 或本地服务。

组合包向 DSH 做两件事：

1. 把每个**启用的提供方**注册进 DSH 的 Web 运行时，使内置 `web_search` 可以选择它；
2. 注册一个中立的专用工具 **`agent_web_search`**，可以直接指定 `provider`、并行执行多条查询，不依赖内置 `web_search` 当前选中了哪个提供方。

内置 `web_search` 的提供方选择是 profile 的持久配置，本组合包不会自动改写它。首次使用需要到 **设置 → 插件 → 网页搜索与获取设置**（Settings → Plugins → Web Search & Fetch Settings）的“搜索提供方”里选择 `agy (local CLI)`。在此之前，`agent_web_search` 已经可用。

## 功能

- **提供方注册**：一个提供方模块 = 一个 `providers/<id>.js`，注册表在 `providers/index.js`，新增提供方只改一行。
- **统一契约**：`status()` / `ready()` / `search()` / `searchMany?()` / `toolTimeoutMs?()` / `dispose?()`，详见 [`providers/README.md`](providers/README.md)。
- **专用工具 `agent_web_search`**：`queries[]`（1-10 条，去重后并行）、可选 `provider`、可选 `maxResults`（1-10）；返回综合答案与来源列表；声明并发安全。
- **agy 提供方**：解析本机 `agy` 可执行文件，检测登录状态，把 agy 登录文件播种进可写的隔离 HOME，按槽位隔离多开，子进程支持超时与取消，插件卸载时终止仍在运行的 agy。
- **模型设置**：在插件详情页配置 agy 模型；留空并保存可恢复继承的配置。

## 安装

要求：DSH `0.2.2-rc.2` 或兼容版本；使用 agy 提供方时还需本机已安装并已登录 `agy`。

发布到 npm 后，可安装进目标 profile（这里以 web 为例）：

```sh
dsh plugin --profile web add @tnzzzhlp/dsh-agent-websearch
```

也可以在 DSH 的插件管理界面输入 `@tnzzzhlp/dsh-agent-websearch` 安装。源码开发时，先安装仓库依赖，在包目录执行 `pnpm run build:remote` 和 `pnpm run build:client`，再用 `dsh plugin --profile web add .` 安装本地目录。安装后按 DSH 提示重载或重启目标 profile。

**从旧单提供方插件升级**：如果已安装 `dsh-agy-websearch`，请先移除它再装本组合包，否则两个 bundle 会注册同一个提供方 id `agy`，Web 运行时将报 `WEB_DUPLICATE_PROVIDER` 并导致加载失败：

```sh
dsh plugin --profile web remove dsh-agy-websearch
```

卸载：

```sh
dsh plugin --profile web remove @tnzzzhlp/dsh-agent-websearch
```

## 使用

### 专用工具 `agent_web_search`

```json
{
  "queries": ["DeepSeek Harness 0.2.2 release notes", "Cordis fiber effect cleanup"],
  "provider": "agy",
  "maxResults": 6
}
```

- 多条查询并行，结果按排名交错合并，URL 去重；任一查询失败即取消其余查询并报错（不返回部分结果）。
- 单次 agy 会话约 15-30 秒；超过并发槽（默认 3）的查询会排队，工具超时会按查询波次估算（至少 120 秒，可用 `tool.timeoutMs` 覆盖）。
- `provider` 缺省为配置里的 `provider`，再缺省为第一个启用的提供方。

### 内置 `web_search`

在设置页的“搜索提供方”中选择 `agy (local CLI)` 后，内置 `web_search` 会走本组合包注册的提供方。注意内置 `web_search` 对单次调用有约 30 秒的预算，而 agy 单次通常需要 15-30 秒，临界查询可能超时；如果频繁超时，可以：

- 优先使用 `agent_web_search`；或
- 在 profile 的 `cordis.patch.yml` 中调大内置搜索工具的超时（例如 `tool-web` 的 `searchTimeoutMs: 120000`）。

## 配置

组合包默认配置已经可用。需要调整时，在 profile 自己的 `cordis.patch.yml` 中覆盖 `agent-websearch` 行（patch 会替换整行 `config`，未写的键使用插件默认值）：

```yaml
- id: agent-websearch
  name: '@tnzzzhlp/dsh-agent-websearch'
  config:
    provider: agy            # 默认提供方 id
    tool:
      maxResults: 6          # 1-10，agent_web_search 默认返回来源数
      maxQueries: 3          # 1-10，单次调用允许的查询数
      timeoutMs: 120000      # 可选，10000-900000；不写则按提供方估算
    providers:
      agy:
        enabled: true
        agyPath: /root/.local/bin/agy   # 可选；默认从 PATH、AGY_BIN、常见目录解析
        home: /var/lib/dsh/agy-home     # 可选；显式 HOME（不再做隔离多开）
        sourceHome: /root               # 可选；从这里复制 agy 登录文件
        effort: low                     # low | medium | high | xhigh | max
        model: gemini-3.1-pro-preview   # 可选，传给 agy --model
        logFile: /tmp/agy-search.log    # 可选，传给 agy --log-file
        extraArgs: []                   # 可选，追加到 agy 命令行
        timeoutMs: 120000               # 每次 agy 调用的超时
        maxResults: 6                   # agy 返回来源上限
        maxConcurrent: 3                # 隔离 HOME 下的并发 agy 进程数（1-5）
```

`providers.agy.enabled: false` 可以单独禁用 agy；若所有提供方都被禁用，插件加载会报错。配置里的未知顶层键、未知提供方 id、超出范围的数值都会在加载时被拒绝，错误信息指明具体路径。

## agy 提供方如何工作

1. **定位 CLI**：`providers.agy.agyPath` → `AGY_BIN` → `PATH` → `~/.local/bin/agy` → `/root/.local/bin/agy`、`/usr/local/bin/agy`、`/usr/bin/agy`。
2. **检测登录**：检查 `$HOME/.gemini/antigravity-cli/antigravity-oauth-token`；显式 `home` 优先，否则在 `sourceHome`、`AGY_SOURCE_HOME`、`/root`、当前 `HOME` 中找登录来源。
3. **可写 HOME**：agy 需要可写的 `HOME`，而 DSH 宿主的 HOME 可能是只读的。插件把登录文件以 `0600` 播种到运行 HOME：
   - 显式 `home`：直接使用，并发固定为 1；
   - 否则优先 `$DSH_HOME/agent-websearch-home`，没有 `DSH_HOME` 时退到 `$TMPDIR/dsh-agent-websearch-home`，每个并发槽一个 `slot-N` HOME；
   - 都不可写时退回登录来源 HOME（非隔离，并发 1）。
4. **单次搜索**：启动 `agy -p <prompt> --output-format json --json-schema <schema> --settings '{"permissions":{"allow":["search_web"]}}' --effort <effort>`，只允许内置 `search_web` 工具，禁止 shell/文件工具；解析 JSON envelope 的 `structured_output`。
5. **并发与清理**：`SlotPool` 限制同时运行的 agy 数量，取消/超时通过信号传递给子进程（SIGTERM，5 秒后 SIGKILL）。

agy 的登录 token 会被复制到运行 HOME（`0600`），不会上传到任何网络位置；搜索查询会作为 prompt 文本发送给 agy，因此会经过 agy 所连接的模型服务。

## 开发

Node ≥ 22（使用 `node:test`、`AbortSignal`）：

```sh
npm test                     # node:test 单元测试，不联网、不启动 agy
node scripts/e2e-agy.mjs     # 真实调用本机 agy，要求已安装并登录
```

在仓库根目录（`dshe/`）也可以运行 `npm test` 和 `npm run e2e:agent-websearch`，前者会跑所有插件的测试。

`npm test` 覆盖配置校验、提供方契约、工具参数/并行/合并、agy 输出解析和插件注册，全部基于假提供方与假 ctx，不需要网络或 agy。`scripts/e2e-agy.mjs` 会依次检查提供方状态、执行一次 provider `search()`、再通过 `agent_web_search` 工具执行两条并行查询并打印耗时与来源；agy 不可用时脚本以非零码退出。

### 项目结构

```
index.js              # 组合包入口：注册提供方 + 工具 + fiber 清理
lib/
  config.js           # 顶层配置、tool、providers 段的校验与实例化
  provider.js         # 提供方定义/实例契约校验、status 读取
  tool.js             # agent_web_search 定义、参数校验、并行与合并
  search.js           # 统一结果规范化、去重、渲染
  process.js          # 子进程超时/取消/输出上限
  slot-pool.js        # 可取消的 FIFO 并发槽
  signals.js          # AbortSignal 组合
  errors.js           # 插件错误类型与消息工具
  values.js           # 小工具函数
providers/
  index.js            # 静态提供方注册表
  agy.js              # agy 提供方
  README.md           # 提供方扩展指南
locale/{en,zh}.json   # 插件管理界面文案
cordis.patch.yml      # 把 index.js 挂进 profile
test/                 # node:test 单元测试
scripts/e2e-agy.mjs   # 真实 agy 端到端脚本
```

## 已知限制

- agy 一次查询一个 CLI 会话，约 15-30 秒，明显慢于 HTTP API 类提供方；插件没有结果缓存。
- 内置 `web_search` 的提供方切换是 profile 持久设置，本组合包不会自动改；需要用户手动选择。
- `provider` 选择只在注册的、已启用的提供方之间生效；未来新增提供方需要改 `providers/index.js` 并重新加载。
- agy 的命令行参数、JSON envelope 和 `search_web` 工具名可能随 agy 版本变化；升级 agy 后请运行 `scripts/e2e-agy.mjs` 验证。

## 许可证

MIT，见 [LICENSE](LICENSE)。
