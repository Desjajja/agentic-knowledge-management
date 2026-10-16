# 模型重试与回退

项目级配置示例（密钥只从环境变量读取）：

```sh
node bin/akm.js model configure --root /path/to/test-akm \
  --base-url https://aigc.sankuai.com/v1/openai/native \
  --model DeepSeek-V3-FRIDAY \
  --fallback-models LongCat-Flash-Chat,MiniMax-M2.7 \
  --api-key-env AKM_API_KEY
```

配置只写入指定 AKM root 的 workspace 与 `.pi/models.json`。现有单模型配置仍可用。JS 的 `configureModel` 另接受 `fallback: string[]`、`recovery`：默认 `sameModelRetries: 1`、`baseDelayMs: 500`、`attemptTimeoutMs: 20000`、`maxAttempts: 6`。`maxAttempts` 是一次 `runPi` 全部逻辑轮次共享的物理请求上限；`maxRequests` 单独限制逻辑模型轮次。一次 `answer` 的查询扩展与最终回答共享 `timeout` 总期限。

| 失败 | 行为 |
| --- | --- |
| 500/502/503/504、网络或流中断 | 同模型重试一次，再按顺序切换 |
| 单次请求超时 | 直接切换，避免用同模型超时耗尽总期限 |
| 429 模型限流 | 尊重 Retry-After 后切换；期限不足则停止 |
| 404 或明确模型/工具不兼容 | 切换 |
| 401/403、明确余额/共享配额不足、普通 400/422 | 停止，不轮番请求 |
| 未识别错误 | 停止并保留脱敏诊断分类 |

三个模型使用同一个网关，不能将其称为独立 API 故障切换。泛化的 429 无法自动判断是否为共享限流；只有明确的配额信息才能提前停止跨模型尝试。

AKM 包装 pi `agent.streamFunction`，每次只恢复当前失败的模型步骤。失败流中的不完整工具调用不会进入调度；成功调用过的工具及结果保留在当前会话。关闭 pi agent 和 provider 两层内置重试，避免次数相乘。输出在单次模型流完成后才交给 pi 调度，当前 CLI 因此不提供逐 token 展示。会话仍使用 `SessionManager.inMemory`，不增加长期 memory。

每次物理尝试记录模型、HTTP 状态、失败分类、恢复动作、等待时间、耗时和可用 usage。失败请求没有返回 usage 时保持 null；已知部分总量不能当作真实完整消费。未知价格不生成费用估计。原始网关错误正文及授权头不进入 telemetry。

文本模型的用户消息以纯字符串发送，避免部分兼容网关拒绝 multipart 数组。只剥离完整的开头 `<think>…</think>` 块，不从任意混合文本中猜测 JSON。普通 400 不会为掩盖配置错误而自动回退；业务 JSON 无效也不会自动重跑整个知识写入工作流。

验证命令：

```sh
npm test
npm run benchmark
python3 scripts/collect-recovery-corpus.py
node scripts/build-recovery-questions.js
# 以下命令从 stdin 读取凭据，不要把凭据写入命令参数或文件。
node scripts/validate-recovery-live.js probe
node scripts/validate-recovery-live.js ingest
# 阅读 artifacts 下原始提案后，本次语料的明确审阅决策脚本：
node scripts/review-test-proposals.js
node scripts/evaluate-recovery-retrieval.js
node scripts/validate-recovery-live.js workflow
node scripts/verify-recovery-workflows.js
node scripts/validate-recovery-live.js answers
node scripts/validate-recovery-live.js tools
node scripts/validate-agent-adapters.js
node scripts/validate-agent-adapters.js directed
```

测试脚本的域、资料和审阅修改针对本次固定公开语料，不是生产资料的自动审阅策略。测试 Vault 在 `artifacts/recovery-validation-2026-10-15/test-akm/vaults/test-vault`，并为并发实验建立独立副本。不要对生产 root 执行这些审阅脚本。
