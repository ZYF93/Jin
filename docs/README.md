# Jin 文档

| 文档 | 中文 | 内容 |
| --- | --- | --- |
| [Overview](overview.md) | [概览](overview.zh-CN.md) | Jin 的优势与局限、与 Codex/OpenCode/Claude Code 的差异 |
| [Getting started](getting-started.md) | [快速上手](getting-started.zh-CN.md) | 首次运行、配置 Provider、完成第一个被批准的变更 |
| [Providers & models](providers.md) | [Provider 与模型](providers.zh-CN.md) | 支持的协议、2026 模型预设、自定义请求头、搜索端点 |
| [WAL format](wal.md) | [WAL 格式](wal.zh-CN.md) | `.jin/wal.jsonl` 架构账本、记录、版本与 Git 合并驱动 |

核心设计一句话：**先审架构，再写代码**——你审的是意图和影响面，正确性交给自动检查 + 失败自修 + 架构一致性校验兜底。
