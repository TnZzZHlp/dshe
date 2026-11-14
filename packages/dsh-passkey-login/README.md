# DSH Passkey 登录（实验性，未经生产安全审计）

本包针对单一所有者 DSH 和固定地址 `https://dsh.tnzzz.top`。用户先使用现有 DSH 认证方式登录，在插件设置页绑定 Passkey；以后访问首页即可使用 Passkey 登录。平台必须支持 WebAuthn 和用户验证（PIN、生物识别等）。`@simplewebauthn/server` 负责 WebAuthn 验证；本插件要求匹配 RP ID、origin、一次性 challenge 和用户验证。绑定操作两步均要求有效 DSH 认证。登录成功在服务端交换 DSH 本身的 token 签发 cookie，不向浏览器发送 token。

**不要在未完成以下条件及真实环境验证前将此包用于生产或暴露公网。**

## 必要部署条件

- 本包允许 DSH Web HTTP 监听局域网地址，但这会使局域网设备能够绕开 HTTPS 代理；明文连接可能泄露凭据。强烈建议限制为 `127.0.0.1` 或 `::1`，或使用防火墙确保只有可信代理可以访问后端端口。在容器或多网络命名空间中单独确认隔离效果。不可信的本机进程仍可能连接后端。
- 仅由可信反向代理终止 TLS，证书和外网地址必须是上述固定 origin；不支持不同 host、端口、路径前缀或 origin。代理应拒绝其他 Host，并向 DSH 固定发送 `Host: dsh.tnzzz.top`，不要信任客户端提供的 Forwarded/X-Forwarded-*。DSH connection 的 `trustedHosts` 也必须明确允许该主机。确保 WebSocket 等 DSH 路由同样通过代理。
- DSH 自身的普通 token 登录在 HTTP 后端生成的 cookie **没有 Secure**。代理必须对所有来自后端的 `dsh-auth-*` Set-Cookie 强制加 `Secure`，保留 `HttpOnly`、`SameSite=Strict`、`Path=/`，不得加 Domain，且不能覆盖或剥离这些标志。插件的 Passkey 登录会核验 DSH 返回的 cookie 属性并补加 Secure，但它不能修复其他 DSH 登录路径。检查实际响应，包含初次 token 登录和 Passkey 登录；严禁把明文 cookie 暴露给公网 HTTP。禁止把 launch token、Cookie 或带 token 查询参数的 URL 写入代理日志、追踪或错误日志。
- 在代理上为 `/passkey` 配置按来源和全局的并发/请求速率限制、请求体大小及读取超时。未认证的 options 可以占用有限挑战槽，攻击者可造成拒绝服务；插件的 256 槽和两分钟有效期并非充分防护。不要缓存任何认证响应。
- 使用支持跨进程序列化修改且持久保存的 DSH credentials provider，并保护其文件及父目录，限制为 DSH 运行用户访问。插件只检查 provider 报告可写，**无法通过该接口证明持久性或文件权限**；部署者必须核验备份、权限、重启与并发语义。勿使用临时或多个互不共享状态的 provider；多实例的内存 challenge 不共享，需单实例或严格粘性路由。
- 必须防止同源 XSS、恶意同源插件和不可信用户访问本机凭据。拥有 DSH 所有者会话的任何人都可以绑定新的 Passkey；本功能不是多用户隔离或管理员审批。该端点要求精确 Origin、`Sec-Fetch-Site: same-origin` 和 JSON 请求；拦截这些请求头的代理/浏览器会导致拒绝。

## 安装与使用

完成上述部署条件并验证后，执行 `dsh plugin --profile web add @tnzzzhlp/dsh-passkey-login`，或在 DSH 的 **Plugins > Add plugin** 中添加该 npm 包。此包仅适用于上述固定部署，不是通用域名登录插件。确认插件已启用且加载成功后，先以已有方式登录 DSH，在设置的插件列表中打开 Passkey 登录插件详情，点击“绑定 Passkey”；之后访问 `https://dsh.tnzzz.top/` 即可使用 Passkey 登录。首次绑定仍需已有 DSH 会话，不能用未认证的浏览器进行绑定。局域网 HTTP 直连存在上述安全风险，应尽可能隔离。

## 生命周期与恢复

启用时创建持久记录 `passkey-login/credentials`，记录不存在才初始化；损坏、不可写、后续丢失或验证失败时拒绝操作。允许最多 64 个凭据；不提供界面级别的单个凭据撤销。需撤销时，由可信管理员通过 DSH 凭据服务的 `deleteRecord('passkey-login/credentials')` 删除整条记录并重启插件，然后通过已有认证重新绑定；删除记录不会撤销已签发的 DSH 浏览器 cookie，也不会删除其他已登录会话。若设备或会话已泄露，另需通过可信的 DSH 管理操作删除 `client-connection/browser-session` 签名密钥记录并重启 DSH，令旧 cookie 失效；这会影响所有浏览器，务必先准备本机恢复途径并核对运行版本。不要删除其他记录。进程重启也会使待处理 challenge 失效。认证器计数器始终为零时无法检测克隆。

## 测试与限制

Node.js 22 或更新版本，安装依赖后运行 `npm test`。当前自动测试覆盖拒绝非法 Origin/Host、未认证绑定、challenge 消费、cookie 属性检查、存储失败及真实库生成的注册选项。可另设置 `DSH_CORDIS_MODULE` 和 `DSH_CONNECTION_MODULE` 为已安装版本的对应 `lib/index.js` 绝对路径，运行相同测试以验证真实 Connection 的服务端 cookie 交换和 admit；未设置时该测试跳过。尚未覆盖真实浏览器/认证器注册签名、反代链路和持久化 provider 的端到端行为。投产前必须在目标安装版本中逐项测试这些行为、cookie 接收与过期、重启和撤销恢复，并进行独立安全审计。不要基于单元测试推断整套部署安全。
