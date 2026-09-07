# Enterprise AI Workspace

企业 Agent 工作平台的早期本地 CLI。当前入口是 **你输入自然语言 → Task service / SQLite → 官方 Codex SDK → 本地 Codex runtime → kimi-k3 → 本地项目 / 只读 connector MCP**。BUILD-003、004 已完成；Outlook / 飞书只读代码已接入，尚待真实账号授权与正文验收。

当前没有 Web UI、后端 HTTP API、企业 RBAC 或技能包管理。此实验验证 runtime 集成，不代表企业部署或真实用户需求已验证。

后续实施依据：[Enterprise AI 路线图 v2](docs/ROADMAP.md)，覆盖 Outlook / Microsoft 365、飞书文档、身份权限、任务记录及企业试用。

## 使用本地 CLI

在本目录运行：

```bash
npm start
```

这是打开界面。随后在界面里选择项目并输入自己的任务：

```text
项目目录（绝对路径）：/Users/lll/Desktop/rollout-fixture
你 > 检查这个项目，修复错误，不可以修改 test。修复前后运行测试，告诉我改了什么。
```

自然语言原文直接交给 `thread.runStreamed(prompt)`，没有隐藏的修复 prompt、固定 bug 或失败测试数要求。支持继续追问；`/new` 开始新任务；`/exit` 退出；Ctrl+C 取消当前任务并退出（已有文件修改保留）。每轮最多 180 秒。

退出后再次 `npm start`，输入 `/tasks` 找到任务，再输入 `/resume <完整任务ID>` 继续。恢复时自动选择该任务原来的项目目录；不会自动重放上次输入。

| 命令 | 功能 |
|---|---|
| `/tasks` | 列出当前本地 owner 的所有任务和状态 |
| `/resume <完整ID>` | 选择历史任务，随后输入新指令继续 |
| `/history` | 查看当前任务历轮输入、回复及错误 |
| `/status` | 查看任务身份、目录与业务状态 |
| `/done` | 用户标记任务验收通过，不触发业务写入 |
| `/connections` | 查看当前本地 actor 的 Outlook / 飞书 OAuth 连接身份 |
| `/new` | 下次输入新建独立任务，沿用当前选中目录 |

模型 `turn.completed` 后任务进入 `awaiting_review`（待验收），不会直接记为业务成功。`/done` 才记录 `succeeded`；后续追问会重新进入运行和验收流程。执行异常、取消、超时与进程意外退出分别记录，历史查询不需要调用模型。

界面显示 Agent 回复、实际执行命令、命令输出和文件变更。项目自身的 `AGENTS.md` 仍生效。“不改 test”是用户指令和项目规则，不是文件级强制权限。CLI 的 `completed` 只表示 turn 完成，不代表独立验收通过；测试结果来自 runtime 的工具执行记录。

**2026-09-07 本轮交付检查时，rollout-fixture 已处于失败版本：4 个测试、2 个失败**，可以直接输入修复要求。CLI 不会自动制造 bug，也不会自动还原代码；修复成功后再次要求修复，可能得到“测试已通过、无需修改”。

每个新任务使用独立 `.runtime/session-*/`，保存私有 HOME、Codex 会话状态，以及每轮的 `prompt.txt`、`events.jsonl`、`summary.json`。恢复任务时复用该任务的目录及 thread ID。SQLite 业务状态存于 `.runtime/app/tasks.sqlite`，上述目录均被 Git 忽略。请保留完整 `.runtime/` 才能恢复历史；旧 BUILD-002 仅有日志的会话不会自动导入。

## 连接 Outlook / 飞书（BUILD-005–007 验收前置）

先参考 `config.example.toml`，在 Git 忽略的 `config.local.toml` 增加 connector 配置。不要把 App Secret 或 token 发到聊天或提交到 Git。

Outlook 需要注册 public/native client，允许 delegated device-code flow；本轮只申请 `User.Read` 与 `Mail.Read`：

```bash
npm run connect:outlook
```

飞书自建应用需配置精确回调 `http://127.0.0.1:8765/callback`，开通 user scope `offline_access`、`docx:document:readonly`、`wiki:wiki:readonly`，并确保测试用户在应用可用范围内：

```bash
npm run connect:lark
```

状态与撤销本地连接：

```bash
npm run connect:status
npm run disconnect:outlook
npm run disconnect:lark
```

授权后运行 `npm start`，可直接用自然语言要求读取飞书 Docx/Wiki 链接、搜索 Outlook 邮件、读取搜索结果正文并跨来源总结。四个 MCP 工具均为只读；没有发送邮件或修改文档工具。

## Runtime 配置隔离

CLI 和旧实验入口共用 `scripts/runtime.mjs`：

- 新任务新建 HOME、CODEX_HOME、ZDOTDIR、XDG 目录；只在明确恢复该任务时复用，不复制个人配置、memory、登录凭据或个人历史会话。旧实验入口仍每次新建目录。
- 关闭 memory 注入与生成；不继承父进程环境，只显式提供必要变量和当前 provider 凭据。
- 工具环境使用 `inherit = none` 和显式变量，不把 provider key 传给 shell。
- 保留 workspace-write sandbox、工具网络关闭、审批 never；不自动提权。

这是**配置与上下文隔离，不是操作系统级的文件读取隔离**。项目内指令/配置仍需信任；同一系统用户下的任意个人文件读取隔离、企业多租户隔离尚未实现。

依据：[官方 configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)、[Codex SDK](https://learn.chatgpt.com/docs/codex-sdk)，并针对已安装 0.153.4 runtime 实测 prompt。

验证：`npm test`。测试使用真实 runtime 的 `debug prompt-input` 检查用户原话、项目规则和 memory 排除，不调用模型。`npm run verify:mcp` 会真实调用现有 provider，要求 `kimi-k3` 调用一次本地 `connection_status` MCP；会产生模型用量。真实两轮 Kimi 对话也已通过，见 [实验 002](docs/experiments/002-natural-language-cli.md)。

## 安装与配置

- Node.js 24+；本次验证环境为 Node.js 24.14.1。使用内置 `node:sqlite`，该版本会显示 ExperimentalWarning，不影响执行。
- `npm ci` 安装锁定依赖。SDK 0.153.4 会安装配套 Codex runtime，无需 clone Codex 源码或调用桌面聊天窗口。
- 复制 `config.example.toml` 为 `config.local.toml`，在本地填写 API key。不要覆盖已有配置。
- `config.local.toml` 是本平台配置，由脚本转成 Codex provider 配置，不是原生 Codex 配置格式。
- 当前配置为 DashScope URL、`responses`、`kimi-k3`。脚本不擅自更换模型或服务地址。

```bash
npm run smoke
npm run repair -- /Users/lll/Desktop/rollout-fixture
```

默认 Python 为 `/opt/homebrew/bin/python3`。其他机器可通过 `FIXTURE_PYTHON=/absolute/path/python3` 指定解释器。Fixture 不在本仓库内，以上命令需要用户本地的真实 Fixture；当前不是开箱即用的跨机器 demo。

## 旧固定任务实验（不用于自然语言交互）

`smoke`：在只读模式运行 Codex，仅请求 `OK`，不授权工具操作。

`repair`：

1. 对真实 Fixture 的文件做 SHA-256 快照，拒绝符号链接。
2. 运行固定解释器的 `-B -m unittest -v`；只在 4 个测试、恰好 2 个 failure 的预期基线下继续。
3. 通过 SDK 的 `runStreamed` 发起修复，要求遵守 Fixture 的 `AGENTS.md`，只改 `cart.py`。
4. 保存流式事件。单次修复 180 秒超时，provider HTTP/stream 重试设为 0。
5. 无论 agent 成功或失败都尽可能独立复跑测试、核对文件哈希、生成 diff。
6. 只有 turn 完成、4 个测试通过且仅 `cart.py` 发生变化才判为通过。任何失败保留现场，不自动回滚。

修复完成后再次运行 `repair` 会因基线不再失败而停止。这是有意设计，脚本不会自动把正确代码改坏来重复演示。

## 证据

每次运行保存到 Git 忽略的 `runs/<timestamp>-<mode>/`：

- `summary.json`：状态、thread ID、模型、usage、文件变化与验证结果。
- `events.jsonl`：SDK 原始事件，经 key 字面值脱敏。
- `tests-before.txt` / `tests-after.txt`：独立测试输出。
- `hashes-before.json` / `hashes-after.json`：文件哈希。
- `cart.before.py` / `cart.after.py` / `changes.diff`：代码改动证据。

本地日志可能包含任务内容、路径和 runtime 上下文，不应直接上传为公开作品集。公开材料应另行审阅、整理。

## 当前边界

- `workspace-write` 限制 workspace 写入，工具网络关闭；审批策略 `never` 不会自动提权，需超出 sandbox 的操作应失败。
- “只改 cart.py”是任务约束加事后检查，不是文件级强制 ACL；workspace 内其他文件在 runtime 层仍可写。
- 实验 001 当时使用本机个人配置；当前入口已接入独立 runtime 配置，但尚未完成企业租户隔离。
- key 只在本地配置与 provider 进程环境中使用，不传入 prompt 或命令参数；工具环境过滤 key/token/secret。完整用户级文件读取隔离尚未实现。
- Codex 对 `kimi-k3` 没有内置模型元数据，使用 fallback metadata。基础响应通过不等于所有工具协议均兼容。

当前先使用自然语言 CLI，暂不增加 Web UI。本地 actor 来自系统 UID，不是企业 SSO；SQLite 归属检查与并发约束不是多租户安全证明。运行进程丢失后记为 interrupted，不自动重试；PID 复用可能保守地保留 running 状态。诊断日志不属于防篡改企业审计。

官方参考：[Codex SDK](https://learn.chatgpt.com/docs/codex-sdk)、[provider 配置](https://learn.chatgpt.com/docs/config-file/config-reference)。

## 已完成实验

[实验 001：真实 Fixture 修复](docs/experiments/001-fixture-repair.md) 已通过；详见报告中的验证结果与限制。

[BUILD-003：持久化任务服务与跨进程恢复](docs/experiments/003-task-service.md) 已通过。`npm test` 运行离线测试；`npm run verify:resume` 会真实调用现有 provider 两轮并产生用量，保留测试任务和证据，验证两个独立 CLI 进程间的上下文恢复。

[BUILD-004：连接身份与受控工具 spike](docs/experiments/004-connector-identity-spike.md) 已通过真实 MCP 调用。005–007 只有在用户完成产品自己的 OAuth，并核对真实正文、来源和权限失败后才算完成。
