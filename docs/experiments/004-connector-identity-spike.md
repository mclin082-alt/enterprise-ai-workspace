# BUILD-004：连接身份与受控工具 spike

日期：2026-09-07。结论：**BUILD-004 已实现并通过真实 Codex runtime / kimi-k3 MCP 调用验收。BUILD-005–007 尚未完成真实账号与业务数据验收。**

## 本轮交付

- 新增独立 `ConnectionStore`：本地 actor 只能查看自己的 Outlook / 飞书连接；稳定账号 ID、显示名和实际 scope 只从 OAuth 后的远端 profile/token 响应绑定，不接受 prompt 指定。
- 新增 mode `0600` 的本地 token vault。token、refresh token 和飞书 app secret 不进入 Task SQLite、prompt、Codex tool shell environment 或 MCP tool 参数。
- 新增本地 STDIO MCP server，只暴露四个固定 schema 的只读工具：`connection_status`、`lark_read_document`、`outlook_search_messages`、`outlook_get_message`。
- runtime 每轮从 Task service 注入固定 `actor`、`taskId` 和 connector 数据目录；MCP allowlist 只包含上述只读工具。
- 新增 Outlook delegated device-code 登录、飞书 OAuth authorization-code 登录、refresh token 轮换和断开连接命令。
- 新增飞书 Docx/Wiki URL 严格解析、Wiki → Docx token 解析、标题/版本/纯文本读取；新增 Outlook `/me/messages` 搜索和单封正文读取。
- 每次业务来源工具调用写入独立 `source_accesses` 记录，保存 task、actor、provider、tool、来源与结果，不保存 token。

## 真实 runtime 验收

执行：

```bash
npm run verify:mcp
```

2026-09-07 的实际结果：

```json
{
  "provider": "qwen",
  "model": "kimi-k3",
  "calls": [
    {
      "server": "enterprise_connectors",
      "tool": "connection_status",
      "status": "completed"
    }
  ],
  "completed": true
}
```

证据保存在 Git 忽略目录 `.runtime/mcp-spike/session-ds2Uad/mcp-spike-summary.json`。第一次 sandbox 内调用在 90 秒超时，没有产生模型响应；允许访问已配置 provider 后，18 秒内完成。由此可区分外网受限与 MCP/runtime 不兼容。

离线验收：

```bash
npm test
```

14 个测试全部通过，覆盖连接身份与 token 分离、URL 边界、`/me` 只读请求、OAuth v3 单次 refresh、MCP tool allowlist、无连接权限失败、原 BUILD-003 恢复/并发/超时语义。

## 官方规范核对

- Codex 官方文档确认本地主机支持 STDIO MCP，`mcp_servers.<id>.enabled_tools` 可作为 tool allowlist，`required` 可让初始化失败阻断启动：[MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)、[Configuration Reference](https://learn.chatgpt.com/docs/config-file/config-reference)。
- Microsoft Graph 使用 delegated access；本轮只申请 `User.Read`、`Mail.Read` 和 refresh 所需的 OIDC scope，以 `/me/messages` 读取当前登录用户邮箱：[delegated access](https://learn.microsoft.com/en-us/graph/auth-v2-user)、[list messages](https://learn.microsoft.com/en-us/graph/api/user-list-messages?view=graph-rest-1.0)。
- 飞书授权页为 `https://accounts.feishu.cn/open-apis/authen/v1/authorize`，token/refresh 使用当前 v3 `https://accounts.feishu.cn/oauth/v3/token`；只读文档 API 为 `GET /open-apis/docx/v1/documents/:id`、`GET /raw_content`，Wiki 解析为 `GET /open-apis/wiki/v2/spaces/get_node`。请求 scope 为 `offline_access docx:document:readonly wiki:wiki:readonly`，仍需应用后台开通且用户对目标资源有阅读权限。

## 尚未完成与下一断点

BUILD-005–007 的 connector 代码路径已具备，但没有用 mock 冒充真实完成。继续验收需要：

1. Outlook App Registration 的 public/native client ID；tenant 使用 `common`（个人和组织账号）或明确 tenant ID，并由测试用户完成 device-code 授权。
2. 飞书自建应用 App ID / App Secret、精确回调 `http://127.0.0.1:8765/callback`、上述三个 user scope、应用可用范围，以及一份测试用户确有阅读权的 Docx/Wiki URL。
3. 在 `config.local.toml` 本机填写这些值，不在聊天、Git 或报告中传递 secret。

随后依次执行 `npm run connect:lark`、`npm run connect:outlook`，在同一个 `npm start` 自然语言任务中完成飞书真实读取、Outlook 真实读取和跨来源总结。只有远端正文、来源、权限失败与业务结果均核对后，才将 BUILD-005–007 标记完成。

## 边界

- token vault 的 mode `0600` 只是单机 spike 防误读，不是 Keychain/KMS、独立系统用户或企业 secrets service。
- 当前 runtime shell 与 connector 仍在同一 OS 用户下；MCP 参数隔离不证明恶意进程无法读取本机文件。该问题属于 M4 执行隔离，不能用 prompt 或配置替代。
- `raw_content` 不表示读取了表格、Base、图片、附件等所有嵌入对象；遇到这些内容必须报告不完整。
- 本轮没有发信、建草稿或修改飞书文档；M3 写入审批尚未开始。
