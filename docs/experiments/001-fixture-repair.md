# 实验 001：真实 Fixture 修复

日期：2026-09-07。状态：通过。

## 目标与路径

验证平台自己的任务入口可以通过官方 Codex SDK 驱动真实 Codex runtime，读取并修改用户桌面的 Fixture，并由平台独立核验结果。

使用 `npm run repair -- /absolute/path/to/rollout-fixture` 发起任务。SDK/runtime：0.153.4；provider：DashScope Responses；模型：kimi-k3；Node.js：24.14.1。模型没有内置元数据，runtime 使用 fallback metadata。

## 实测结果

| 项目 | 结果 |
| --- | --- |
| SDK smoke | 返回 OK，Fixture 无变化 |
| 修复前独立测试 | 4 个测试，2 个 failure，退出码 1 |
| 修复后独立测试 | 4 个测试全部通过，退出码 0 |
| 文件变化 | 仅 cart.py |
| 测试与规则文件 | SHA-256 核对均未变化 |
| 实际执行者 | SDK 启动的 Codex runtime；平台脚本没有实现或直接应用修复 |

## 改动

```diff
--- a/cart.py
+++ b/cart.py
@@ -1,4 +1,4 @@
 def total_price(prices, discount_percent=0):
     """Return the total after applying a percentage discount."""
     subtotal = sum(prices)
-    return round(subtotal * (1 - discount_percent ), 2)
+    return round(subtotal * (1 - discount_percent / 100), 2)

```

## 证据定位

本地完整记录保存在 `runs/2026-09-07T09-16-42.568Z-repair/`，包括 SDK events、thread ID、测试前后输出、哈希与 diff。该目录不进入 Git。本报告是审阅后的精简证据，不含 key、个人 memory 或完整 agent reasoning。

## 限制与下一步

- 本次只验证单个小型 Fixture 的一次成功修复，不证明复杂代码任务成功率或企业需求。
- Fixture 是外部本地目录，尚未作为可分发 benchmark 发布。
- 当前使用本机 Codex 用户配置；观察到 runtime 读取了个人 memory。下一步先实现独立 runtime 配置与上下文边界，再加任务 API/UI。
- `workspace-write` 不是只允许 cart.py 写入的 ACL；本次通过事后哈希验证确认没有越界修改。
- SDK 报告修复累计 input_tokens=146190，其中 cached_input_tokens=110592，output_tokens=940。这些是 provider/runtime 报告值，不是经账单核对的成本。
- Fixture 已修好，再次执行会被失败基线检查拦住；不会自动重置真实文件。
