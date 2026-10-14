# Enterprise AI Workspace：贡献与验证索引

[返回项目首页](../README.md) · [本地开发指南](DEVELOPMENT.md)

## 本次实际验证：2026-10-14

基准代码：`13a584fb8deb9beef79ece0d1db915366ed45521`。Linux、Node.js `24.19.0`、npm `11.9.0`，依赖使用仓库 `package-lock.json`。本轮仅修改 Markdown 展示资料。

首次 `npm ci` 请求锁文件内 `registry.npmmirror.com` 的包，被当前网络代理返回 403。随后使用 npm 支持的 registry host 替换，保持锁文件和 integrity 校验不变，安装成功：

```bash
npm ci --registry=https://registry.npmjs.org --replace-registry-host=always --no-audit --no-fund
npm test
```

实际安装另指定了 workspace 内 npm cache；未修改 `package.json` 或锁文件。测试输出：

```text
tests 14
pass 14
fail 0
cancelled 0
skipped 0
todo 0
```

本次未运行 `smoke`、`repair`、`verify:resume`、`verify:mcp` 或 OAuth 登录；没有新的 live 模型结果，也没有读取任何真实邮件/飞书正文。`npm test` 中包含真实 runtime 的离线 `debug prompt-input` 检查，不调用远端模型。connector 网络响应与 Task service 事件使用受控替身。

## 贡献与证据对应关系

| 陈述 | 项目实现 | 可核对证据 |
| --- | --- | --- |
| 在官方 SDK 上实现应用级任务生命周期 | [task-service.mjs](../scripts/task-service.mjs)、[task-store.mjs](../scripts/task-store.mjs) | [任务测试](../tests/tasks.test.mjs)：持久化、恢复、显式验收、失败/超时/取消与并发拒绝 |
| 为任务建立独立配置目录，控制上下文与工具环境 | [runtime.mjs](../scripts/runtime.mjs) | [runtime tests](../tests/runtime.test.mjs)：保留用户原话和项目规则，排除 memory canary 与 provider key |
| 固定 actor/task 上下文，token 与连接元数据分开保存 | [connection-store.mjs](../scripts/connection-store.mjs)、[connector-mcp.mjs](../scripts/connector-mcp.mjs) | [connector tests](../tests/connectors.test.mjs)：绑定身份、token 不进入 metadata、只读 allowlist、未连接报错 |
| 实现飞书 Wiki→Docx 解析与 Outlook `/me` 只读 API 路径 | [connectors.mjs](../scripts/connectors.mjs) | [connector tests](../tests/connectors.test.mjs)：使用模拟 HTTP 响应，验证请求与返回结构；不代表真实数据验收 |
| Fixture 修复有独立结果检查 | [experiment.mjs](../scripts/experiment.mjs) | [实验 001](experiments/001-fixture-repair.md)：历史 4 项测试全通过、仅 `cart.py` 改动，fixture 不在本仓库 |

## 历史 live 记录

以下为仓库已有报告，本次核对文字与实现，没有重跑：

| 日期与报告 | 当时记录的结果 | 不包含什么 |
| --- | --- | --- |
| 2026-09-07，[实验 001](experiments/001-fixture-repair.md) | 官方 SDK/runtime + Kimi 修复一个外部 fixture，前后独立测试和文件哈希检查通过 | 通用 benchmark、复杂任务成功率；当时还使用本机个人配置 |
| 2026-09-07，[实验 002](experiments/002-natural-language-cli.md) | 独立 runtime 配置、真实两轮对话；当时 3 项测试通过 | 没有在这次实验重做隔离后的修复；工具环境在线探针未执行 |
| 2026-09-07，[BUILD-003](experiments/003-task-service.md) | 两个 CLI 进程恢复同一对话，`/done` 写入验收状态；当时 8 项测试通过 | 业务系统读写、企业多用户恢复；原始证据只在本地 |
| 2026-09-07，[BUILD-004](experiments/004-connector-identity-spike.md) | 真实 runtime/Kimi 调用一次 `connection_status`；当时 14 项测试通过 | Outlook/飞书正文与跨来源业务验收 |

`runs/...`、`.runtime/...` 和历史 `/Users/...` 路径均为作者当时的本地证据位置，不是公开可访问链接。已有 Markdown 是精简报告，未附完整原始事件、截图或视频。测试数量随阶段增加，不能把不同阶段结果相加。

## 能力与材料边界

当前代码提供 CLI 和本地 Task service，没有 Web/Chat UI、浏览器刷新恢复或独立 Stop 按钮；CLI 有 Ctrl+C 取消与 `/resume`。本机 UID 的 actor、0600 token 文件和配置隔离不等于企业 SSO、租户隔离或 OS 级读取限制。

当前只有四个只读 MCP 工具：`connection_status`、`lark_read_document`、`outlook_search_messages`、`outlook_get_message`。外部写入审批、冻结方案及审批后执行列在 [路线图](ROADMAP.md)，没有当前实现或验收证据。BUILD-005–007 正文与跨来源 live 验收仍待真实账号授权后完成。

待补：CLI 演示、可公开的脱敏原始证据包、可分发 fixture、真实读取的正文/来源/权限失败记录。若另有更新版本的 UI 或写入链路，应提供相应 commit 和验收记录后再调整展示。
