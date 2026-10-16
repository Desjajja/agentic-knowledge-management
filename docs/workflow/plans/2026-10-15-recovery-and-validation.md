# AKM 模型恢复与扩展验证实施计划

**Goal:** 验证真实资料摄取、对话总结与检索闭环，增加有界重试和模型回退，修复无关检索与重复证据。

**Architecture:** 使用 pi 的单次模型流边界恢复失败请求；保留会话中已有工具结果。AKM 统一拥有恢复策略，关闭 SDK 内置两层重试。测试使用 artifacts 下独立 AKM root，不切换生产活跃 Vault。

## Global Constraints

- 主模型 DeepSeek-V3-FRIDAY；依次回退 LongCat-Flash-Chat、MiniMax-M2.7，共用现有网关。
- 同网关模型切换不能解决网关整体中断；认证、共享配额错误立即失败。
- 不持久化 API key；不修改生产知识库或发布全局 skill；不引入长期模型 memory。
- 报告区分本地故障注入、真实 API、直接 tool 测试和自主触发测试，记录未完成项。

### Task 1: 有界模型恢复

**Files:** src/pi.js、src/model-recovery.js、bin/akm.js、tests/model-recovery.test.js
**Consumes:** 项目级模型配置、pi streamFn 边界。
**Produces:** 有序 fallback 配置，单次请求恢复，attempt/model/reason/usage/latency 记录。
**Steps:** 关闭 SDK 重试；每模型至多一次同模型重试；总期限和每次请求期限；只让成功的流进入工具调度。
**Acceptance:** 503、401、429、流中断、工具之后失败、全部失败、超时测试；已有测试保持通过。

### Task 2: 检索质量与工具效率

**Files:** src/retrieve.js、src/pi-tools.js、tests、benchmarks
**Consumes:** 现有基准与历史误召回样本。
**Produces:** 减少单汉字/停用词误召回，合并同页证据与重叠段落。
**Acceptance:** 现有 benchmark 不退化；新增中文负例通过；聚合工具同页只出现一次。

### Task 3: 独立真实测试语料与工作流

**Files:** scripts/validate-recovery-live.js、artifacts/recovery-validation-2026-10-15/
**Consumes:** 可用真实 API、公开文档、独立 test-vault。
**Produces:** 兼容性探测、审阅后的摄取与对话归档、更新、检索、trace 和标注问题集。
**Steps:** 模型兼容探测通过后再摄取；逐步检查结果，不把错误提案直接当成金标准；开发集与保留集分开；记录 token 与时延。
**Acceptance:** 运行实际模型和 pi 工具链；知识页及原文可检查；生产 Vault 前后摘要相同。

### Task 4: 评估与交付

**Files:** artifacts/recovery-validation-2026-10-15/report.md、相关使用说明与 bundled runtime
**Consumes:** 全部测试的真实输出。
**Produces:** 通过/失败/未覆盖清单、质量与成本数据、后续优化建议。
**Acceptance:** 报告不将强制工具调用算作自主触发，不把单次成功算成稳定性证明。全局发布留待验证后的交付决定。

## Progress

- [x] 检查当前实现和历史实验。
- [x] 实现并验证模型恢复。
- [x] 修复检索与去重并跑回归。
- [x] 实际 API 与隔离 Vault 验证。
- [x] 评估报告与同步交付源码。
