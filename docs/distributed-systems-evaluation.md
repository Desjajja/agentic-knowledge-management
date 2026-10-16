# AKM 分布式系统真实检索评测（2026-10-12）

这次评测用 6 篇公开原文建立了一个独立 Obsidian Vault，并通过 pi agent + `deepseek-v4-flash` 完成文档提取、提案审核、归档、检索和回答。资料包括 Kleppmann 的 CAP 与分布式锁文章，以及 Jepsen 的 Linearizability、Serializability、Snapshot Isolation、Strong Serializability 页面。

## 执行结果

- 6 篇来源，13 个知识页，16 个固定问题。
- 16 次检索和 14 次实际问答；q03、q07、q14、q16 因检索为空，系统直接返回无证据。
- 所有实际 HTTP 请求均为 200；这只代表请求成功，不代表内容正确。
- 首篇提取曾因模型生成的标题含 `:` 被安全文件名校验拒绝。原始请求、完整回复和失败保存在 `artifacts/distributed-systems-2026-10-12/trace/`；随后只做文件名/标签格式修复，正文未改写。
- s2 也生成了含 `:` 的标题，验证了这是系统提示和模型输出约束的真实缺口，而非偶发事件。

## 人工结果

人工评分写入 [`manual-evaluation.json`](../artifacts/distributed-systems-2026-10-12/manual-evaluation.json)。回答采用 0/1/2：错误或无法回答、部分正确、正确或安全拒答。

- 回答正确或安全拒答：13/16（81.25%）；平均分 0.844（按 0/1/2 归一化）。
- q01、q02、q04–q06、q08–q11、q14、q16 基本达到预期。
- q12 部分正确：能说明 quorum 在分区少数侧不可用，但 top-3 没有直接召回 Linearizability 页面，线性一致性部分依赖间接证据。
- q03、q07 暴露中文查询的词法检索缺口：英文资料已归档，但纯中文释义没有召回结果。
- q13、q15 的检索有误召回，但回答层正确识别证据不足，拒绝编造生产 benchmark 或 PostgreSQL 18.1 当前集群保证。这说明回答层的证据约束有效，但检索层的负查询仍会返回相近页面。

## 归档质量观察

1. 内容保真度总体良好：fencing token、resource-side validation、SI write skew、serializability 与 strict serializability 的 real-time 区别均能在页面和回答中找到原文依据。
2. 提取粒度偏碎。s1 产生 6 页，s2 产生 4 页；多个页面内容相互重叠，增加检索噪声。
3. `related` 在首篇和分布式锁文章中几乎为空；Jepsen 页面开始生成已有页面的 related 链接。这表明模型能使用上下文，但跨文档关系需要更明确的提案规则或后处理。
4. 页面正文会保留自己的 H1，渲染后可能出现重复标题；这是可修复的展示问题，不影响当前事实检索。
5. 目前没有向量/语义翻译层。跨语言查询失败是已知基线结果，不能被合成数据集上的中文指标掩盖。

## Trace 重点

- `trace/ingest-s*-request.json`：提取时发送给 pi 的上下文、已有页面和来源文档。
- `trace/ingest-s*-response.json`：模型原始 JSON；包括被安全校验拒绝的原始标题。
- `trace/answer-q*-request.json`：回答时实际检索证据和完整页面正文。
- `queries/q*-retrieval.json` 与 `queries/q*-answer.json`：可复核的检索排序、哈希、引用和最终回答。
- `corpus-snapshot.json`：回答前冻结的知识库快照。

## 结论和下一步

这个基线已经证明 MVP 能完成“公开文档 → 提案 → Obsidian 页面 → 明确检索 → 有证据回答”的真实闭环。当前最值得优化的不是盲目调 BM25，而是：

- 在提取 schema/prompt 中明确安全标题和 Obsidian tag 规则；
- 增加跨语言检索（查询翻译、别名/术语表或 embedding），并单独重跑 q03/q07；
- 限制过度拆页，或在提案阶段显示“合并候选”；
- 把 related 生成变成基于已存在页面的显式步骤；
- 对负查询增加“相似但不相关”阈值，降低 q13/q15 这类误召回。

本评测没有用新规则覆盖基线结果；原始失败、模型 trace 和错误回答均保留。
