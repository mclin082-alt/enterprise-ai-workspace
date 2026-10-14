# 实验 002：自然语言 CLI 与独立 runtime 配置

> 阶段说明：以下是 2026-09-07 实验 002 的历史快照。文中“退出不自动恢复”描述该阶段；后续恢复能力见 [BUILD-003](003-task-service.md)，当前复核范围见 [验证索引](../VERIFICATION.md)。

日期：2026-09-07。

用户要求：在本地小界面自己输入自然语言任务，例如“修复错误，不可以改 test”，而不是亲手触发脚本内的固定修复 prompt。暂不做 Web UI。

## 实现

- `npm start` 打开 CLI，输入项目路径后输入自然语言；不预设修复内容或失败测试数。
- 用户输入直接提交到 SDK；支持同一 thread 继续对话、`/new`、退出、取消和超时。
- 新的 runtime adapter 为每次启动创建独立 HOME / CODEX_HOME / ZDOTDIR / XDG / 临时目录，禁用 memory 注入与生成；不继承个人 provider 配置和父进程凭据。
- 旧 smoke / repair 实验也使用同一 adapter。

## 已验证

1. `npm test`：3 项通过。包括独立目录和工具环境配置；真实 runtime prompt 保留用户原话及项目 AGENTS.md、不注入 memory canary 或 provider key；CLI 选择目录后可以直接退出，不提交模型任务。
2. 针对真实 `/Users/lll/Desktop/rollout-fixture` 的 `debug prompt-input`：含 Fixture 规则，不含个人 memory 或个人 skills 路径。记录：`.runtime/session-r9DQmD/prompt-input.json`。
3. 实际 Kimi 两轮对话：第一轮回复“收到青竹”，第二轮回复“青竹”；同一 thread 两轮均 `completed`，无工具调用。记录：`.runtime/session-WlAiZq/turn-1/` 与 `turn-2/`。
4. 交付时独立运行真实 Fixture 的 `/opt/homebrew/bin/python3 -B -m unittest -v`：4 个测试、2 个失败；cart.py 已与实验 001 的修复后快照不同，本轮未对其写入或重置。当前可由用户直接发起修复。

## 验证边界

- 本轮没有执行修复、没有重置真实 Fixture。隔离后的实际修复待用户用自然语言亲自发起。
- 工具凭据过滤已检查配置；额外在线工具环境探针因发送本地环境 metadata 被自动审批拒绝，没有执行，不声称完成该项 live 验证。
- 独立用户目录不等于 OS 级读取限制；workspace-write 也不是 test 文件 ACL。
- 项目配置、项目 AGENTS.md 和 runtime 自带的系统 skills 仍可能进入上下文。
- 仍为单用户本地 CLI，无企业并发调度/租户边界；退出不自动恢复会话。
- CLI 显示 runtime 的测试输出，没有旧固定实验的独立测试/哈希验收；`completed` 不等于修复正确。
- kimi-k3 继续使用 runtime fallback model metadata，本轮不更换模型。

私有配置、prompt、日志、runtime 状态均被 Git 忽略。
