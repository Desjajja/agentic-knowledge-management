# AKM v0.1.2 runtime

运行时位于 `runtime/`，依赖 Node.js >=22.19 和 npm。首次安装：

```sh
sh runtime/scripts/install.sh
akm init
akm vault list --json
akm status --json
```

已有根目录下创建独立 Vault（仅用于硬隔离）：

```sh
akm vault create --name distributed-systems
akm vault list --json
akm vault use distributed-systems
akm retrieve --domain "分布式数据" --query "一致性模型"
```

`vault create` 复用同一个 pi workspace；常规操作只访问 active Vault，需显式 `vault use` 才切换。每个 Vault 目录都可以单独复制迁移。普通主题使用 `domain`，不必创建新 Vault。

默认根目录是 `~/.akm`。知识库和 pi workspace 都在该根目录内：

```text
~/.akm/
  config.json
  vaults/personal/       # 可整体复制迁移
  workspaces/default/    # pi provider/model 配置
```

配置当前 workspace 的 OpenAI-compatible provider：

```sh
akm model configure --base-url https://example.invalid/v1 --model MODEL_ID --api-key-env PROVIDER_API_KEY --thinking-enabled
```

`akm retrieve` 是同步、确定性的证据检索；`--answer` 才调用 pi。归档命令只创建 proposal，必须先展示 `[1]` 项目、tag、alias、related 和正文，经用户确认后才 `review`/`commit`。

当前 MVP 支持 Markdown/TXT；不包含 PDF/OCR、异步 job、自动聊天捕获、语义向量检索或 Vault 导入导出命令。迁移时复制整个 `~/.akm`；运行时配置与 Vault 一起保存。
