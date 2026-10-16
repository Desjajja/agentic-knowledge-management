# AKM 四阶段优化进度

更新：2026-10-13。四阶段实现及恢复后的实验执行已完成；质量与性能验收未通过。
设计：docs/akm-next-iteration-design.md；结果：docs/workflow-v2-validation.md。
检索由宿主 agent 判断触发；自动发现默认 Vault；正式写入仍需确认。

- [x] 1. 全轮成本账本、CLI 累计日志与旧评分复核
- [x] 2. 证据聚合、章节批读、恢复与预算/hash/引用门禁
- [x] 3. 来源定位/预检/顺序幂等、分块协调、保真检查、提案合并与同批关系
- [x] 4. 外部 CLI/skill、默认发现、跨 cwd 与迁移、独立评审和报告
- [x] 真实审核式提取/更新/召回闭环：3 道召回全正确
- [x] 冻结双语 32 题、A/B/C 30 槽及真实 2 块＋协调实验执行
- [ ] 质量门槛：英文 11 正确/4 部分/1 失败；中文 10 正确/6 部分/0 失败，均 26/32
- [ ] 性能门槛：完整配对 C 输入比 A 增加 47.8%，时延下降 13.2%，未达目标

44 项回归测试通过；40 题合成排序无退步。顺序重复上传零额外模型调用；同源并发 single-flight 尚未实现。真实长文首次段落 ID 混淆被拒绝，提示澄清后完成，仍有限定泛化、metadata 膨胀与跨来源保真误报。实验原失败、所有 trace 和已知费用保留，无法取得的 usage 不填零。

下一轮重点：独立修正版知识库、增量补证、原术语本地索引、metadata 精简和按主张范围保真。当前配置不能宣称节省 token 或质量不退步。

当前分支 codex/akm-workflow-v2；仓库无初始提交，无 commit/PR。变更前源码快照 /tmp/akm-workflow-v2-before/。
# 下一轮优化（2026-10-15）

## 已落地

- 测试生命周期统一通过 `scripts/test-vault-session.js` 管理：开始时记录当前 active Vault，显式切换到 `test`，结束时在 `finally` 中恢复；模型超时、provider fallback 失败和断言失败都会走恢复路径。使用 `sourcePath` 临时导入测试 Vault 时，`config.json` 也会恢复。
- `scripts/validate-recovery-live.js` 在每次 live 验证前后执行 active Vault 校验。验证使用独立 artifacts root，不会修改生产 `~/.akm/vaults/default`。
- evidence 聚合增加多词查询的最低匹配门，减少只命中一个常见词的噪声候选；底层 `rank()` 保持原有召回行为，避免 paraphrase benchmark 回退。
- 来源保真检查扩展了“小于/小于等于/非递增”比较词的混淆检测。
- 提案 prompt 已统一使用 domain 语义，允许跨 domain related（仅限上下文中出现的精确路径），并要求模型保留数字、单位、日期、比较符、作者和限定条件；兼容旧模型返回的 `project` 字段。
- 新增真实语料构建和验证：`scripts/build-real-corpus.py`、`scripts/validate-real-corpus.js`。独立 test vault 当前包含 168 个页面、127 个查询，来源为公开 etcd Raft 说明及 RFC 9000/9110/9293。
- 真实语料阈值实验显示，全局 `minMatched=2` 会把 recall 从 0.9685 降到 0.8819，因此 evidence 采用自适应策略：短查询保留单词召回，长自然语言查询才要求多词命中。

## 验证结果

- `npm test`：62/62 通过。
- `npm run benchmark`：零容差回归门通过。
- 当前生产 active Vault 已核对为 `default`。
- `node scripts/validate-real-corpus.js`：测试期间 active vault 为 `test`，结束后恢复为 `test-vault`；生产 active vault 未改变。

## 后续

下一步再处理主张级数字、时间和作者归属校验，并用独立负例集调 evidence 阈值；不能用现有 holdout 反复调参。
