# BUILD-003：持久化任务服务

> 阶段说明：以下保留 BUILD-003 当时的结果与边界；文末“BUILD-004–007 未完成”是该阶段状态。后续 BUILD-004 见 [MCP 验收报告](004-connector-identity-spike.md)，本次离线结果见 [验证索引](../VERIFICATION.md)。

日期：2026-09-07。状态：实现完成；离线测试与真实 Kimi 跨进程恢复通过。

## 交付

`scripts/chat.mjs` 负责交互，`scripts/task-service.mjs` 编排 runtime 和事件记录，`scripts/task-store.mjs` 保存 SQLite Task / Turn。新任务创建自己的 runtime 目录，恢复时复用该目录与 thread ID。SDK 行为依据[官方 SDK 文档](https://learn.chatgpt.com/docs/codex-sdk)与本地锁定的 0.153.4 源码核对，并通过真实调用验证。

原始自然语言输入不套 workflow 模板。任务记录 actor、workspace、thread、输入、model、usage、回复、错误码及日志路径。Task 与 Turn 分离：模型完成记为 turn completed、Task awaiting_review；用户 `/done` 验收后才标记 succeeded。`/done` 不授权外部写入。

取消记为 cancelled；超时记为 failed / timeout；无完成事件的断流记为 failed；启动时把已失去进程的 running turn 记为 interrupted。全部不自动重放。SQLite 事务与唯一索引拒绝同任务的并发 turn；不同任务保留独立 HOME / CODEX_HOME。

## 验证

`npm test`：8 项通过，覆盖原有真实 runtime prompt 隔离检查、CLI 退出、新增 Task service 成功/失败/取消/超时/断流、身份归属检查、并发拒绝、独立进程退出后的状态恢复、缺失 runtime 状态失败和凭据字面值脱敏。service 事件测试使用受控替身，不是 connector 或企业多用户实测。

`npm run verify:resume`：使用本地配置的真实 kimi-k3，启动两个独立 CLI 进程。第一进程保存随机标记并退出；第二进程仅询问上一轮标记，恢复后正确回答，并通过 `/done` 写入验收状态。

- Task：`87491dcb-4ad1-422e-8e3b-9d775a961605`
- Runtime thread：`01a07c0b-aafc-7f60-8867-6d0cbf841e10`
- 本地证据：`runs/build-003-uuKShm/summary.json`，同目录有两个进程的输出。
- 首次受限网络运行失败，已保留 `runs/build-003-pjvbxF/first.json` 和 failed 任务。允许网络后通过，没有把失败证据删除或改成成功。

本次只测试对话恢复，不读写业务系统。测试 workspace 和任务记录有意保留，供 `/tasks`、`/history` 核对；这些私有证据不进入 Git。

## 使用

运行 `npm start`，输入项目目录和自然语言。退出后再启动，依次输入 `/tasks`、`/resume <完整ID>`、新指令。`/history` 查当前任务对话，`/status` 查状态，`/connections` 明确显示 Outlook / 飞书未连接。

需要 Node.js 24+，已验证 24.14.1。数据库位于 `.runtime/app/tasks.sqlite`；恢复还需要完整保留各任务 `.runtime/session-*/codex`。旧实验会话仅保留原日志，没有自动迁移。

## 边界与下一步

本轮断点为 BUILD-003；BUILD-004–007 未完成。接下来需要产品自身的 Microsoft / 飞书应用注册与用户授权，以及受控工具 spike。当前助手已有的登录工具不属于产品 connector。

本地 actor 是系统 UID，不是 SSO。SQLite 文件权限与查询归属检查不等于企业用户隔离，runtime 的同用户文件读取边界仍未解决。原始 runtime 会话与诊断记录可能包含任务正文，不能当作已脱敏的公开材料或防篡改审计。

恢复检查基于同一台机器的 PID；PID 复用会保守地认为旧进程仍存活。异常终止后应检查残留 runtime 进程和文件现场；interrupted 不表示先前操作已回滚。缺失 runtime 状态时明确失败，不创建新 thread 冒充恢复。M3 写入确认、企业凭据隔离和 M4 多用户治理仍按路线图推进。
