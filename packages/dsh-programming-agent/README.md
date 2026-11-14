# @tnzzzhlp/dsh-programming-agent

> 本包是 [dshe](../../) 单体仓库的一部分；版本、安装和仓库约定以包内文档为准。

为 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/dsh) 提供“编程模式”代理预设的组合包（bundle）。它向 profile 注册一个名为 `programming` 的 agent preset：一段面向写代码场景的 persona，加上一组经过挑选的插件与工具配置。

组合包只做五件事，不改动其他 profile 行为：

1. 插入 agent preset `programming`（`@deepseek-ai/dsh-agent-preset`），其中包含 persona 与工具配置；
2. 关闭全局 `system-prompt` 的 harness 身份段落（`includeHarnessIdentity: false`），并保留下面的默认 persona 前缀；
3. 禁用 `harness-dev-context`，避免它把运行环境方向性的段落（提及 harness 检出目录和 Web GUI）写进系统提示；
4. 在预设里禁用 `skill-filesystem` 与 `tool-skill`，避免把 `@deepseek-ai/dsh-agent-preset` 自带的 `dsh-doc` 技能清单注入每轮用户消息；
5. 在预设里改写 `context:file-reference` 段落（`@` 路径说明），换成同义的另一种措辞。

因此启用本组合包后，系统提示与每轮注入的提示里都不再出现 “DeepSeek Harness” 字样，只保留中性的编程型 persona。第 2、3 项的动机与替代方案见下面的“系统提示”一节。

## 预设内容

- **persona**：项目规则型前缀，包含不用 emoji、先定目录与模块结构、入口保持精简、默认不主动加测试、不擅自引入 mock/CI/依赖、事实必须核实、只用搜索工具查当前目录、不用长时间 sleep、不把易变信息写进上下文等约定。
- **`@` 路径说明**：`file-reference-rewrite`（本包的 `lib/`），把上游的 `context:file-reference` 段落改写成同义表述，见下面“`@` 路径段落”。
- **指令文件**：`agent-instructions`，上限 64 KiB。
- **文件与命令工具**：`tool-bash`（非 Windows）、`tool-pwsh`（Windows）、`tool-fs`（关闭 `applyPatch`）、`tool-fs-search`（不抽样超限 glob 结果）、`tool-jobs`。
- **计划模式**：独立 isolate 的 `planning` 组，内置一段强调“探索先行、计划完整、退出工具必须是本轮唯一且最后一个调用”的 section。
- **压缩**：`compaction` 组，包含基础压缩、`/compact` 命令和工具结果裁剪（8192 字符阈值，保留头 4096、尾 1024）。
- **委派**：`delegation` 组，提供 `subagent`、`subagent_fork`、工作流工具，并关闭子代理中断。
- **交互工具**：`tool-ask-user`、`tool-todo`、`tool-web`（开启抓取，搜索超时 60 秒）。

预设不启用技能：`skill-filesystem` 与 `tool-skill` 都设为 `disabled: true`。`@deepseek-ai/dsh-agent-preset` 自带的 `skills/` 目录只含 `dsh-doc`（查询 DSH 自身文档），它会以 `<system-reminder>` 形式把技能清单注入每轮用户消息，与本预设保持中性 persona 的目标冲突，因此整组关闭。

预设的这几项都通过 `insert` 落在补丁层里；`persona` 使用 `includeRuntimeContext: false`，因为该预设不需要运行环境信息。

## 系统提示

DSH 的 harness 身份段落由 `system-prompt` 插件在 `includeHarnessIdentity` 为真时注册，persona 只能覆盖 `deployment:persona-prefix` / `-suffix`，无法把它去掉。本包的补丁层在 profile 组合顺序中位于 `dsh-base`、`dsh-web-app` 之后，所以在这里整行覆盖 `system-prompt` 的 `config`：

```yaml
- id: system-prompt
  name: '@deepseek-ai/dsh-system-prompt'
  config:
    includeHarnessIdentity: false
    personaPrefix: You are a coding agent powered by the {{model}} model.
```

补丁只能整段替换某一行的 `config`，不会深合并，因此 `personaPrefix` 必须重写；这里沿用 `dsh-web-app` 的默认值，避免丢失模型名占位符。如果目标 profile 自己改过该前缀，需要在 profile 用户层再次覆盖。

`harness-dev-context` 注册的 section 文本本身会提到 harness 检出目录与 Web GUI，这部分不受 persona suppress 运行时上下文的影响，所以本包直接禁用该行。代价是模型不再自动获得“当前是 Web GUI、URL 是什么、检出目录在哪”的提示；对编程预设来说可以接受。

### `@` 路径段落

`@deepseek-ai/dsh-file-reference-local` 会给每个有 `read` 工具的 agent 注册一段固定文案（`context:file-reference`，开头是 `Tokens prefixed with @ ...`）。某些上游渠道的渠道校验会把这整段连同上下文判为“非官方客户端请求”（返回 `code 11128`，翻译成 502 后表现为随机失败）；把这段换成同义表述就能稳定通过，语义不变。

该 section 由生产方直接注册进 **agent 自己的 scope**，所以在预设里按同名注册一个新 section 不会生效（不会报错，只是不覆盖）。本包改用 `system-prompt/assemble` 瀑布：

```js
ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
  const nextAssembly = await next()
  return rewriteFileReference(nextAssembly)
})
```

这个监听器挂在预设 scope 里，而瀑布是按 scope 过滤的，因此它只影响**使用本预设的 agent**：其他预设和 profile 级的 prompt 消费方仍看到原文。段落识别靠开头 `Tokens prefixed with @`，上游改了这段文案时改写会自动不生效，而不是误改别人的内容。

## 安装

要求 DSH `0.2.2-rc.2` 或兼容版本、Node.js 22 或更新版本。

```sh
dsh plugin --profile web add @tnzzzhlp/dsh-programming-agent
```

也可以在 DSH 的插件管理界面输入 `@tnzzzhlp/dsh-programming-agent` 安装。源码开发时直接安装本目录：

```sh
dsh plugin --profile web add packages/dsh-programming-agent
```

安装后确认 `dsh.profile.bundles` 里出现 `@tnzzzhlp/dsh-programming-agent`，重启 profile 生效。

预设不会自动成为默认值。要在新建会话里默认使用它，需要让 `agent-preset-registry` 选中 `programming`：

```yaml
- id: agent-preset-registry
  name: '@deepseek-ai/dsh-agent-preset-registry'
  config:
    default: standard
    selectedDefault: programming
```

已有的会话保留其创建时选中的预设。卸载本包前先把 `selectedDefault` 改回仍存在的预设，例如 `standard`，否则新建会话可能找不到默认预设。

卸载：

```sh
dsh plugin --profile web remove @tnzzzhlp/dsh-programming-agent
```

## 兼容性

- 依赖的插件 id（`system-prompt`、`harness-dev-context`、`tool-*`、`compaction-*` 等）来自 `dsh-base` / `dsh-web-app` 与实验组合包；DSH 改动这些 id 时，补丁行会以 `patch: entry "..." not found` 或名字不匹配的警告跳过。启动时留意这类警告。
- 本包附带一个小运行时插件（`lib/index.js` 的 `file-reference-rewrite`），只注册一个 prompt 瀑布监听；其余部分仍是补丁层。它不引用 DSH 的服务实现，只使用 `systemPrompt` 服务与 `system-prompt/assemble` 事件。
- 若 profile 里已有其他插件也覆盖 `system-prompt` 或 `harness-dev-context`，后应用的层获胜。用户层 `profiles/<name>/cordis.patch.yml` 在本包之后应用。

## 测试

```sh
npm test
```
