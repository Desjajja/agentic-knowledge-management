---
name: akm
description: Use when a local Obsidian-compatible knowledge vault can improve an answer, or when summarizing conversations and ingesting Markdown/TXT documents into a reviewed knowledge base.
---

# AKM 本地知识库 v0.1.2

AKM 使用 Obsidian Markdown 保存知识，使用 pi agent 处理提取和回答。默认根目录是 `~/.akm`；运行时脚本和依赖位于本 skill 的 `runtime/`。

首次使用：

```sh
sh /absolute/path/to/akm/runtime/scripts/install.sh
akm init --name personal
```

已有 Vault 时先运行 `akm vault list --json`，不要重复初始化。安装、目录结构和模型配置见 [references/runtime.md](references/runtime.md)。

AKM 维护一个 workspace 工作状态。普通检索、归档和读取只作用于当前 active Vault；用户不需要提供路径。查看或切换：

```sh
akm status --json
akm vault use NAME_OR_ID
```

普通主题使用 domain，不创建新 Vault：

- 新知识归入已有 domain：使用 `--domain`。
- 没有合适 domain：提案必须同时展示待审核的 domain name 和 description。
- 只有权限、生命周期或同步边界不同，才创建新 Vault。

创建独立 Vault（高级用法）：

```sh
akm vault create --name "分布式系统"
akm retrieve --domain "分布式数据" --query "一致性模型"
```

初始化没有 Vault 时默认创建名为 `default` 的 Vault；也可以提供现有 Obsidian Vault 路径，AKM 会校验后复制并沿用目录名：

```sh
akm init --vault-path /path/to/obsidian-vault
```

## 检索

涉及历史决定、项目背景、既有知识、偏好或领域事实时，自主判断是否需要检索：

```sh
akm retrieve --query "问题" --domain "领域名" --json
```

默认由宿主 agent 根据证据直接回答；不要为同一批证据再调用 `akm --answer`。只有需要 AKM 独立回答时才使用 `--answer`。当前版本是同步 CLI，没有异步 job API。

使用返回的标题、行号、hash 和来源链接作依据。证据不足时说明缺口，不把低相关候选当作事实。可通过 `--input` 传最多两个术语变体。

## 归档

从选定对话提取：

```sh
akm propose --input /tmp/conversation.json --domain "领域名" --json
```

`conversation.json` 格式为 `{conversation_id,messages:[{id,role,content}]}`，只放用户选择的消息。

处理文档：

```sh
akm propose --file /path/to/document.md --domain "领域名" --json
```

当前支持 UTF-8 `.md`/`.txt`，最大约 2 MiB。长文会分块处理，但处理完成不等于事实正确。

提案不会自动写入正式知识。向用户展示 `[1]` 标签、完整正文、project（新建项目标 `[新创建]`）、tag、alias、related 和冲突提示；隐藏 revision、hash、内部路径。用户明确确认后执行：

```sh
akm review PROPOSAL_ID --revision HASH --input /tmp/edits.json --json
akm commit PROPOSAL_ID --revision HASH --items 1,2 --json
```

可用 `merge` 合并同批项目；保留被拒绝或撤回方案。只提交用户确认的 label。更新前读取目标页并保留无关事实；遇到 hash/revision 冲突要重新生成提案。

## 边界

- 内容默认简体中文，保留原技术术语作为 alias。
- `related` 允许指向同一 Vault 内的其他 domain，不凭标题猜路径。
- 用户关注正文、tag、alias、related、domain；不要展示 confidence/status 等内部状态。
- 保留原文比较条件、数字、作者、日期、反驳和限定；`lower`、`smaller`、`non-increasing` 不能擅自等同。
- 证据工具只读；写入必须经用户确认。
- HTTP 200、模型 session completed 或 wiki 引用存在都不代表事实正确。
- 凭据只通过环境变量名配置，不写入 skill、Vault、proposal 或日志。
