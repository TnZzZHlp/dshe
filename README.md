# dshe

[DeepSeek Harness (DSH)](https://github.com/deepseek-ai/dsh) 插件单体仓库，用来维护和发布我自己使用的各种 DSH 插件。每个插件是一个可独立安装的 bundle，放在 `packages/` 下，有自己的版本号、README 和测试。

## 插件列表

| 包 | 说明 | 提供方/工具 |
| --- | --- | --- |
| [`dsh-agent-websearch`](packages/dsh-agent-websearch) | 可插拔的联网搜索 bundle，内置本机 `agy`（Google Antigravity）CLI 提供方 | 搜索提供方 `agy (local CLI)`；工具 `agent_web_search` |
| [`dsh-codex-subscription`](packages/dsh-codex-subscription) | ChatGPT/Codex 订阅授权，直接调用官方 Responses API，支持多账号与输出前限额切换 | 模型提供方 `codex-subscription`；命令 `/codex`；只读工具 `codex_subscription_status` |

## 安装插件

DSH 插件通过 profile 安装，本地目录即可（`link:` 依赖）。以 `web` profile 为例：

```sh
git clone https://github.com/TnZzZHlp/dshe.git
cd dshe

# 安装某个包；路径指向 packages/ 下的插件目录
dsh plugin --profile web add packages/dsh-agent-websearch

# 重启该 profile 后生效
```

也可以直接在 DSH 的插件管理界面里安装对应本地目录。安装后 `$DSH_HOME/profiles/<profile>/package.json` 会多出指向该目录的 `link:` 依赖，`dsh.profile.bundles` 会追加对应包名；`dsh --profile <profile> --dump-config` 可以看到插件层。

卸载：

```sh
dsh plugin --profile web remove dsh-agent-websearch
```

各插件的详细配置、示例和限制见包内 README，例如 [`packages/dsh-agent-websearch/README.md`](packages/dsh-agent-websearch/README.md)。

## 仓库结构

```
packages/
  dsh-agent-websearch/       # 插件包：index.js、providers/、lib/、test/ 等
  dsh-codex-subscription/    # 官方订阅授权、Responses 适配、多账号与状态查询
README.md                    # 本文件：仓库说明与插件索引
LICENSE
package.json                 # 私有 workspace 根，只用于开发脚本
```

约定：

- 每个插件目录是一个完整、可独立 `dsh plugin ... add <dir>` 的包，包名与目录名一致；
- 插件之间不共享运行时代码；如果将来需要共享库，再引入单独的 workspace 包。`link:` bundle 如需 DSH 公开 Host API，应从运行时提供的 `DSH_INSTALL_DIR` 锚点解析，不能假定工作区能直接解析 `@deepseek-ai/*`，也不导入私有实现路径；
- 插件保持零运行时依赖，直接使用 Node 内置模块和包内相对导入；
- 每个插件至少带 `README.md`、`LICENSE` 兼容声明和 `node:test` 测试。

## 开发与测试

需要 Node.js ≥ 22（DSH 插件使用 `node:test`、`AbortSignal`）。仓库本身零依赖，不需要 `npm install`。

```sh
npm test                    # 运行所有 packages/*/test/*.test.mjs
npm run e2e:agent-websearch # 真实调用本机 agy 的端到端检查（需已安装并登录 agy）
```

单独运行某个插件：

```sh
npm run test:agent-websearch
```

新增插件时，在 `packages/<name>/` 下放好可安装包，并把根 `package.json` 的 `workspaces` 或脚本补上（`packages/*` 已是默认 workspace 范围），同时更新本文件的插件列表。

## 许可证

MIT，见 [LICENSE](LICENSE)。
