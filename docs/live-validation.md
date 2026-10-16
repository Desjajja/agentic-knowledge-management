# AKM：真实 LLM + Obsidian 最小场景验证

日期：2026-10-12。结果：本次新增／更新／检索问答闭环通过，保留一次更新后问答失败及其修复证据。仅验证两页实际项目知识，不据此声称普遍提取质量或所有 provider 兼容性。

## 真实调用边界

- 使用用户提供的 API，通过 **pi SDK 1.1.0** 调用；不是预填模型输出，也不是本地 mock server。
- 请求模型：`deepseek-v4-flash`。工作区独立配置 `openai-completions`，payload hook 附加 `thinking: {type: "enabled"}`。
- pi 实际以 streaming 请求调用兼容端点。六次 pi 调用均收到 HTTP 200，包含文档提取、对话提取、页面更新和三次问答。
- 开始另做一次非 streaming 连通性探测。该探测 response 的 model 字段是 `deepseek-flash`；pi 统计中的 model 是 SDK 配置标识，不能据此断言服务端实际路由版本。保留 [探测记录](../artifacts/live-validation-2026-10-12/connectivity-probe.json)。
- 凭据通过关闭回显的 stdin 输入，仅存于执行进程内存；workspace 只保存环境变量名。Vault、输入文件与报告均不包含凭据。
- Obsidian **1.13.7** 实际打开专用 Vault；通过原生 UI 检查正文、Properties，并点击 related 跳转到已存在页面。

## 输入与实际结果

**文档模式。** 将已有 `docs/mvp-validation.md` 的“本轮交付／测试与演示”原文节选放入测试 Vault 的 inbox。该记录明确说明早期测试使用本地 SSE 模拟服务、demo 不需要模型。[原文输入](../artifacts/live-validation-2026-10-12/input-document.md) 是真实项目材料，未虚构业务事实。

模型生成两个候选项，操作者选择 `[1]`“AKM MVP 验证记录（2026-10-12）”；内容重复的 `[2]` 未提交。创建项目 AKM、知识页、项目索引、来源和 ledger。模型提案与选择回执分别保存。

**对话模式。** 显式选择用户的两条实际消息：“你怎么跑的，我都没给你LLM api”和“完整跑一遍……真的要结合obsidian和LLM做一次真正场景的最小化验证”。[输入消息](../artifacts/live-validation-2026-10-12/input-conversation.json) 不包含 API 凭据。

模型建议新建“AKM 真实场景最小化验证要求（2026-10-12）”，related 指向前一页。操作者审阅后提交 `[1]`。系统仅保存模型标出的支持消息。

**更新既有页。** 将上面的用户要求和已经发生的 pi 调用记录组成新的来源，显式指定原验证记录作为更新目标。模型收到目标页完整正文和属性，生成 update 提案；旧交付内容和历史离线测试记录保留，新增真实模型验证事实，并关联要求页。

操作者通过 proposal edit 去除重复一级标题、把含空格的标签改为 `pi-SDK`，将历史测试节标为“此前离线验证”，并移出正文中的冗长调用统计表。统计表的 SDK cost 为默认零估值，不能当作真实账单。所有修改记录为新的 manual 来源，原始模型输出保留，之后才提交更新。

实际写入的两页：

- [AKM MVP 验证记录](../artifacts/live-validation-2026-10-12/akm-root/vaults/AKM-live-validation/projects/AKM/AKM%20MVP%20验证记录（2026-10-12）.md)
- [AKM 真实场景最小化验证要求](../artifacts/live-validation-2026-10-12/akm-root/vaults/AKM-live-validation/projects/AKM/AKM%20真实场景最小化验证要求（2026-10-12）.md)

**显式检索问答。** 提问：

> AKM 的验证是否已经使用真实商业模型？用户对 Obsidian 和 LLM 的最小化验证提出了什么要求？

更新后的第一次回答仍主要引用“没有使用真实商业模型”的旧记录。检索命中页正确，但最佳三行摘要漏掉了后面的新事实。回答本身提示后续状态证据不足，这仍不满足本次问题，故记录为失败。

修复问答证据展开后，在相同 Vault、相同问题上再次调用真实模型。最终回答明确区分：此前离线验证没有使用真实商业模型；后来已有 pi 调用外部 LLM 的验证结果，包括请求模型、HTTP 200、文档摄取与对话提取，并引用两页。模型对“商业模型”这个分类保留限定，没有把服务端收费性质当成已知事实。

## 可检查证据

| 内容 | 文件 |
| --- | --- |
| 六次实际 pi 调用的 HTTP 状态、token usage、耗时 | [model-calls.json](../artifacts/live-validation-2026-10-12/model-calls.json) |
| 文档原始提案与选择提交 | [01-document-proposal.json](../artifacts/live-validation-2026-10-12/01-document-proposal.json)、[receipt](../artifacts/live-validation-2026-10-12/01-document-receipt.json) |
| 对话原始提案与提交 | [02-conversation-proposal.json](../artifacts/live-validation-2026-10-12/02-conversation-proposal.json)、[receipt](../artifacts/live-validation-2026-10-12/02-conversation-receipt.json) |
| 更新的模型原稿、操作者修改、最终回执 | [原稿](../artifacts/live-validation-2026-10-12/03-update-model-original.json)、[edits](../artifacts/live-validation-2026-10-12/03-review-edits.json)、[receipt](../artifacts/live-validation-2026-10-12/03-update-receipt.json) |
| 修复前失败回答及其证据 | [04-answer-before-evidence-fix.json](../artifacts/live-validation-2026-10-12/04-answer-before-evidence-fix.json) |
| 同一问题复验后的实际回答及完整证据 | [04-answer.json](../artifacts/live-validation-2026-10-12/04-answer.json) |
| Obsidian 实际显示 Properties | [截图](../artifacts/live-validation-2026-10-12/obsidian-properties-top.png) |
| Obsidian 实际显示更新正文 | [截图](../artifacts/live-validation-2026-10-12/obsidian-properties.png) |
| Obsidian related 点击后的实际目标页 | [读取记录](../artifacts/live-validation-2026-10-12/obsidian-related-ax.txt) |
| ID、旧事实、来源、回答证据 hash 与迁移检查 | [checks.json](../artifacts/live-validation-2026-10-12/checks.json) |

`failure.json` 是操作者主动暂停更新提交以修改提案时的停止记录，不是 API 失败；后续继续提交并完成验证。没有删除这一记录。

## 本次修复与回归

1. 更新提案改为提供完整旧页和属性，禁止更新未提供完整内容的模型猜测目标。
2. 模型生成期间相关页改变则拒绝提案，防止重新获取快照后覆盖 Obsidian 新编辑。独立审查实测发现未检索目标的绕过路径，已修复并加回归测试。
3. `--page` 明确约束既有页更新；模型不按指定目标返回 update 就拒绝输出。
4. `--answer` 使用展开正文，最多每页 16,000 字符、合计 64,000 字符，并标记截断。plain query 的排名／摘要行为不变。
5. workspace 可选择附加 provider thinking 参数；安全统计不含请求头、凭据或思考正文。

当前 `npm test` **26/26 通过**，其中八项跑实际 pi SDK 对接本地兼容服务。真实外部调用是本页单独记录的人工验证，不混作自动测试。

`npm run benchmark` 40 个固定合成查询通过原始 baseline：Recall@3 0.9640、MRR@3 0.9730、nDCG@3 0.9715；所有排名与 baseline 一致。它衡量页面排名，不衡量问答证据展开或模型回答正确性；本次问题正说明排名正确不等于答案正确，另加了“最佳摘要之外的新决策仍进入回答上下文”的回归测试。

更新页的旧事实逐行检查通过，ID 不变，原始 source 链保留，新增模型提取来源及人工修订来源，共三条。整体复制 AKM 根目录到临时新位置后，从 `/tmp` 调用 CLI，结果路径与页面 hash 均一致。Obsidian UI 检查使用原测试 Vault，未另开迁移副本。

## 仍需人工审阅的限制

- 模型能生成重复知识项、重复标题及含空格标签；本次实际用选择提交和 proposal edit 修订，未声称自动内容校验已完善。
- 知识更新得到完整旧文不保证模型永不漏事实；本次验证了旧事实保留，还需要更多领域文档与真实用户标注样本。
- 问答正文有截断上限；更大库需要多段证据检索与 token 预算。当前对话归档不自动读取外部 Agent 的完整历史。
- 当前只跑同步 CLI／核心接口，没有异步 worker、PDF/OCR 或跨项目模块 export。
- API 真实调用统计的 cost=0 是未配置价格时的 SDK 估值，不是服务端费用证明。

重新运行：先在进程环境中配置 `AKM_LIVE_PROVIDER_KEY`，执行 `npm run validate:live -- <新的输出目录>`，逐阶段审阅并输入 label。已有输出目录可加 `--resume`；恢复读取保存的输入与尚未提交提案。模型调用是真实请求，结果仍需人工审核。
