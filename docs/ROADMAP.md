# Enterprise AI 实现路线 v2

日期：2026-09-07。状态：BUILD-003 已完成并通过真实跨进程恢复验收；BUILD-004 已完成并通过真实 runtime / MCP tool-call 验收；BUILD-005–007 的只读 connector 代码已就绪，等待真实应用配置、账号授权和业务数据验收。

本计划依据当前已运行的 CLI / Codex SDK / runtime / kimi-k3 更新。取代早期 BUILD-PLAN-v1 中“先做 Web UI、先用模拟项目资料、先接 app-server”的实施顺序；保留真实系统证据、权限和可追溯验收要求。早期计划保留为历史，不覆盖。

## 目标与范围

员工通过自己的本地入口，用自然语言处理授权范围内的文件、Outlook 邮件和飞书文档；系统识别当前身份，按权限调用企业工具，记录执行过程，对外部写入提供可审阅操作和回执。

统一自然语言入口保持不变。增加的是可复用的工具、身份和运行基础设施，不是为“周报”“回邮件”等每个任务写固定脚本。workflow 模板以后可选，不作为任务能力的硬编码边界。

首个可验收业务场景：

> 读取本周项目相关邮件和指定飞书文档，整理进展与阻塞，准备更新飞书周报，并起草一封回复邮件。展示内容后，按我的授权执行。

这个场景用于验收，用户仍可自由输入其他任务。最终 v1 指能供小团队受控试用的版本；一次个人演示不等于生产企业部署。

## 当前基线

- 已完成：本地 CLI 原话输入、真实 Kimi 调用、本地 runtime 工具执行、同次启动连续对话、取消/超时、每轮日志。
- 已完成：独立 HOME / CODEX_HOME 等配置目录，关闭个人 memory 注入与生成。
- 已观察：用户通过自然语言完成真实 Fixture 修复。平台仍有模型 metadata fallback、命令退出状态易混淆等体验问题。
- 已完成（BUILD-003）：Task service、SQLite、按本地 owner 查询历史、跨启动任务恢复、业务验收状态、进程异常退出恢复与同任务并发拒绝。
- 已完成（BUILD-004）：本地连接身份模型、token/metadata 分离、OAuth 命令、固定 schema 的只读 MCP 工具、tool allowlist、来源访问记录；真实 `kimi-k3` 已调用 `connection_status`。
- 未完成：飞书/Outlook 真实账号读取验收、企业身份、写入审批、企业级凭据服务及文件与网络隔离。
- 已有日志是诊断证据，不等于受权限保护的企业审计。

## 架构与复用决定

```text
本地客户端（当前 CLI，后续桌面界面）
  → 应用服务：身份、任务、会话、操作草案、确认、记录
  → runtime adapter → 本地 Codex runtime ↔ 已批准的模型 provider
                       → 受控工具入口（优先验证 MCP）
                           → 身份/资源/动作校验
                           → Outlook connector → Microsoft Graph
                           → 飞书 connector → 飞书 OpenAPI
```

- 继续使用 Node.js 与当前 SDK；先采用 SQLite 保存单机业务状态。无需先改 Codex Rust core。
- 原始 runtime 事件单独保存，应用维护稳定的业务 Task / Action 状态，不让产品依赖日志目录命名。
- 模型只选择工具和提供业务参数。登录身份、租户、可用权限、凭据、审批结论由应用服务注入和核验。
- 企业 OAuth token 由 connector 服务保存，模型和通用 shell 不接触；不能把当前聊天助手的工具、skills 或个人登录直接当成产品集成。
- MCP 是接入协议，不自动提供身份、权限或审计。第一轮做实际版本兼容性 spike；SDK 不能满足稳定的暂停/恢复/审批事件要求时，再评估 app-server adapter，不重写客户端及 connector。
- 当前 runtime 的 approvalPolicy=never 仅管 runtime 提权，不是业务写入审批。写入批准在应用服务执行，不能只把“已批准”放进 prompt。
- 保留本地客户端和本地 runtime。多人阶段把身份、政策、connector 凭据与审计集中到企业服务；涉及敏感任务时，可增加企业托管的隔离 worker，按任务选择执行位置。

## 分阶段交付

| 阶段 | 用户能做什么 | 主要实现 | 验收门槛 |
|---|---|---|---|
| M1 通用工作台与基础身份 | 自由提问、查历史、退出后继续任务、查看连接身份 | 拆分 CLI 与应用服务；Task/Thread 映射；SQLite 状态；账号连接模型；错误/取消/超时语义 | 重启能恢复自己的任务；未连接工具明确不可用；turn 完成不冒充业务成功 |
| M2 真实读取 | 用自然语言读 Outlook 邮件、读飞书文档并跨来源总结 | 两个 connector 的 OAuth、只读工具、分页/正文处理、来源与时间；最低授权检查 | 同一 CLI 真实读到一封邮件和一份文档；引用可核对；无权限时明确失败；不借用另一个账号重试 |
| M3 可控写入 | 起草/修改邮件；新建/更新飞书文档；确认后发送邮件 | Action 草案、预览、确认/拒绝、参数绑定、执行与回读、冲突/结果不明处理 | Outlook 草稿和飞书修改真实可见；修改后的内容重新确认；拒绝零写入；重复提交不重复发送 |
| M4 多用户治理 | 不同员工使用各自身份；管理员配置接入和政策 | SSO/成员生命周期；RBAC+资源规则；用户/租户数据隔离；任务并发控制；执行 sandbox；凭据服务；审计与数据保留 | 至少两个真实授权账号验证边界；模拟角色用于补充测试；历史/搜索/工具返回均不越权；停用成员后撤销访问 |
| M5 本地 App 与小团队试用 | 打开桌面入口处理任务、审阅修改、管理连接与历史 | 复用应用服务增加桌面界面；安装/更新/诊断；试用与 eval；管理服务部署说明 | 新机器按说明运行；完整业务链通过；失败路径能解释和恢复；有真实试用反馈和可复现结果 |

M1 → M2 → M3 是第一轮单用户产品；M4 → M5 是企业试用版本。核心 eval 从每阶段开始写，不等最后补。工期在账号授权和 M2 spike 后重估，不沿用旧计划 5–7 天承诺。

## Outlook / Microsoft 365

用户已选定 Outlook / Microsoft 365；本轮不接飞书邮箱。

- 使用 Microsoft Graph v1.0，优先 delegated access，以登录用户身份访问自己的邮箱。个人 Outlook 与组织 Microsoft 365 的应用注册/租户设置在接入前确认。
- 本地客户端优先 MSAL + 系统浏览器登录；具体授权 flow 按应用类型验证，不在桌面分发 client secret。
- 读取阶段申请身份和 Mail.Read 等必要 scope；草稿阶段增加 Mail.ReadWrite；发送权限 Mail.Send 分开引入。具体 scope、用户 consent 与租户审批由接入实测核实。
- 第一组工具：搜索/列出邮件、读正文、读取同 conversation 的相关邮件；之后添加新邮件草稿、回复草稿、编辑草稿和发送已审阅草稿。
- 第一版先覆盖自己的云邮箱、文本/HTML 正文；共享邮箱、复杂附件、大批量历史同步、邮件规则放到后续。
- 邮件内容属于任务数据，不能授权额外操作；发件人显示名不能决定平台身份。
- 草稿、发送请求已接受、已在 Sent Items 核对、确认送达是不同状态。Graph 返回 202 不等于已送达。网络超时先核查，不能盲目重发。

参考：[Outlook mail API](https://learn.microsoft.com/en-us/graph/api/resources/mail-api-overview?view=graph-rest-1.0)、[delegated access 与 MSAL](https://learn.microsoft.com/en-us/graph/auth-v2-user)、[Graph permissions](https://learn.microsoft.com/en-us/graph/permissions-reference)、[sendMail 结果语义](https://learn.microsoft.com/en-us/graph/api/user-sendmail?view=graph-rest-1.0)。

## 飞书文档

- 用户独立授权并绑定到应用账号；不能仅凭相同邮箱字符串关联 Microsoft 和飞书身份。
- 先支持用户给出 Docx / Wiki 链接，解析真实文档对象后读取正文，保留来源、更新时间或版本；再增加授权范围内的搜索。
- 写入先覆盖新建文档、追加章节、指定段落修改。显示目标及变更 diff，按批准版本执行并回读；不默认覆盖整份文档。
- 对不支持原子版本条件的 API，读前检查与回读不能保证消除并发竞争；检测到冲突时停止并重新生成提案，明确该限制。
- 表格、Base、图片/OCR 和附件作为后续能力，遇到暂不支持的嵌入对象明确说明，不宣称已读取。
- 个人 spike 可参考现有 lark-cli 和 skills；产品 connector 的参数、身份、结果结构必须由代码控制。只有通过独立凭据与权限验证后才可复用 CLI；多人服务优先官方 OpenAPI，禁止共用个人 CLI 登录态。

飞书官方区分应用权限与用户授权：[接入治理说明](https://www.feishu.cn/content/article/7615520954977881029)。本项目按用户授权与源系统资源权限共同限制访问；精确 Docx/Wiki API、scope、版本检查能力在 M2/M3 核实。

## 身份、权限、企业工具、任务记录

| 模块 | M1–M3 最小版 | M4–M5 企业版 |
|---|---|---|
| 身份 | 当前本地 owner + 经授权绑定的 Outlook/飞书账号；每项任务记录 actor | 企业 SSO、成员/租户、停用与注销；不能让用户在 prompt 中指定管理员身份 |
| 权限 | 读取、写草稿、更新文档、发送分别判定；源系统权限与应用策略取交集 | employee / approver / admin 加资源规则；管理员管理接入不自动获得业务正文；权限变更同步到历史和缓存 |
| 企业工具 | 每个工具固定参数 schema、操作类别、超时、标准回执；先 Outlook 与飞书 | connector 健康检查、版本、限流、企业工具目录；新增工具不重写自然语言入口 |
| 任务记录 | 原始指令、执行身份、来源、工具调用、模型版本/用量、结果、错误 | 按身份检索、保留与删除、审计导出、敏感数据控制；事件和正文不对所有管理员开放 |
| 写入控制 | 固定操作草案和确认记录；执行前重验权限/目标/内容 | 审批人角色、操作预算/批量限制；过期或变化后的批准失效 |
| 执行隔离 | 单用户开发环境明确标记；开始验证凭据、配置和网络边界 | 独立系统用户/容器/worker 等 OS 边界；任务 workspace 只挂载允许内容；凭据服务在边界外 |

写入时保存 proposal_id、actor、目标、操作类型、内容摘要/hash、基线版本、批准者及时间、执行状态和远端回执。应用只从已保存的批准草案取参数，不接受模型替换内容后沿用旧批准。

Task 最小状态：queued → running → awaiting_confirmation → running → succeeded / failed / cancelled / interrupted。外部动作另有 draft / approved / executing / verified / outcome_unknown；不能用同一个“完成”遮盖发送结果不明。

BUILD-003 增加 `awaiting_review`：普通模型 turn 结束后等待用户验收，`/done` 才记录 `succeeded`。它不同于 M3 的外部写入 `awaiting_confirmation`，不会批准任何外部动作。超时记录为 Task failed、turn error_code=timeout；每次继续都会保留上一轮结果。

取消不能撤销已执行的外部写入；重启不自动重发待确认或结果不明的动作。幂等键约束本应用重复执行，但不能宣称所有 provider 都提供 exactly-once。

企业权限的关键前提：runtime 的 shell、直接网络、可读目录不能绕过工具入口获取 OAuth token 或直接写业务系统。必须以实际访问测试证明；改 HOME、prompt 禁止、隐藏工具按钮都不足以证明。

## Eval 与企业试用门槛

每阶段同时留下真实成功和失败证据，覆盖：

- 自然语言变化仍能选择正确工具，读取与写入内容符合用户意图。
- 邮件/文档来源和时间可核对；冲突、缺失及不支持的内容明确说明。
- 未授权账号/资源、失效 token、撤销权限、历史访问不会泄露资料。
- 外部邮件/文档中的指令不能代替用户授权或绕过工具策略。
- 拒绝、重复确认、批准后内容变化、并发编辑、429、超时、断网、重启不会导致未经授权或重复写入。
- 模型调用、工具执行与最终业务结果分别记录；统计任务完成率、写入正确率、人工修改量、耗时、用量。

生产部署还需要企业认可的模型/data policy、跨 provider 数据外发范围、凭据存储、备份恢复、审计保留、可观测性与运维责任。小团队试用通过后再按目标企业环境完成这些要求；不把模拟人数当真实使用或容量证据。

## 下一批具体工作

1. **BUILD-003：通用任务服务。已完成。** 从现有 CLI 抽出 Task/Session 服务，加入 SQLite、历史列表/继续任务、清晰业务状态；保留当前自然语言输入。测试与真实恢复证据见 [BUILD-003 报告](experiments/003-task-service.md)。
2. **BUILD-004：连接身份与工具 spike。已完成。** Microsoft/飞书 OAuth 配置、独立身份绑定、只读 MCP allowlist 和真实 runtime tool-call 证据见 [BUILD-004 报告](experiments/004-connector-identity-spike.md)。
3. **BUILD-005：飞书真实只读。代码就绪，待授权验收。** 在自己的 CLI 输入一条文档链接，读到授权正文并引用；权限失败能被清楚报告。
4. **BUILD-006：Outlook 真实只读。代码就绪，待授权验收。** 在同一 CLI 自然语言搜索并读邮件；验证不涉及发信。
5. **BUILD-007：第一条跨来源任务。代码路径就绪，待 005/006 后验收。** 汇总邮件与飞书材料，给出来源和待确认事项；之后进入 M3 草稿与真实写入。

路线图最初一轮只产出计划。后续 BUILD-003 已实际实现并调用 Kimi 验收；BUILD-004 已实际完成受控 MCP tool-call。当前仍未登录业务系统、读取邮件/文档正文、创建草稿或发信；正式接入时由用户完成必要的账户授权。

本次断点推进到 BUILD-004。下一轮从 BUILD-005 的真实授权开始：在本机配置 Outlook public client ID/tenant 与飞书 App ID/App Secret/redirect URI，由用户完成两个账号授权并提供测试文档；随后连续验收 005、006、007。无凭据 MCP 成功与离线 connector 测试不计作 005–007 的真实读取验收。
