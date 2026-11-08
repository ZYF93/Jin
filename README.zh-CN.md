# Jin

[English](README.md)

**面向架构的桌面 Coding Agent。** Jin 会先把开发需求整理成可审阅的架构变更，将批准的决策记录到适合 Git 协作的项目账本，再实现代码，并检查实现是否符合架构。

[![最新版本](https://img.shields.io/github/v/release/ZYF93/Jin)](https://github.com/ZYF93/Jin/releases)
[![构建与发布](https://github.com/ZYF93/Jin/actions/workflows/release.yml/badge.svg)](https://github.com/ZYF93/Jin/actions/workflows/release.yml)

## Jin 能做什么

- 扫描项目并生成架构图：**L0 模块**和 **L1 文件或组件**。语言服务器可补充符号事实和源码跳转信息。
- 根据需求生成 Intent，并描述受影响架构节点在项目中的真实职责。
- 在实施前展示架构变更供用户审阅；只有批准后才开始实现。
- 编写代码前检索已有实现供复用，完成后重新扫描并报告架构偏差。
- 将团队共享的架构历史保存在 `.jin/wal.jsonl`，可通过普通 Git 工作流审阅和合并。
- 支持 OpenAI 兼容接口和 Ollama。可以从 Provider 刷新模型列表，也可以手动输入列表里没有的模型 ID。
- 在桌面应用中管理 Git 分支、暂存变更、提交、查看历史和操作远端。

## 安装

从 [GitHub Releases](https://github.com/ZYF93/Jin/releases) 下载适用于你操作系统的安装包。

| 平台 | Release 文件 |
| --- | --- |
| Windows | `Jin-Windows-<版本>-Setup.exe` |
| macOS | `Jin-Mac-<版本>-Installer.dmg` 或 `.zip` |
| Linux | `Jin-Linux-<版本>.AppImage` 或 `.deb` |

macOS Release 同时提供 DMG 和 ZIP。已打包的应用默认从 GitHub Releases 检查更新；也可以在设置中改用通用更新源。

## 首次使用

1. 启动 Jin，选择**打开项目**或**新建项目**。也可以先打开内置演示项目体验。
2. 在**设置 → Provider** 中选择 OpenAI 兼容接口或 Ollama，填写服务地址和模型。刷新模型列表，或直接输入模型 ID。
3. 打开 Git 仓库。对于尚未初始化的项目，Jin 会创建 `.jin/config.yaml`、`.jin/.gitignore` 和 `.jin/wal.jsonl`，然后扫描源码。
4. 在聊天面板描述要实现的功能。审阅 Intent 和架构差异，批准后开始实施。
5. 检查实现结果和架构校验。需要让团队共享已批准的架构历史时，将 `.jin/wal.jsonl` 与代码一起提交。

### Provider 配置示例

连接 OpenAI 兼容服务时，填写服务商提供的 API 地址和密钥：

```text
Provider：  OpenAI-compatible
服务地址：  https://api.openai.com/v1
模型：      gpt-4.1
API 密钥：  服务商提供的密钥
```

连接本地 Ollama 服务前，先启动 Ollama，然后填写本机服务地址。默认本地配置不需要 API 密钥：

```text
Provider：  Ollama
服务地址：  http://localhost:11434
模型：      qwen3:8b
```

不同服务商提供的地址和模型各不相同。如果 Jin 没有发现模型，可以在模型输入框里填写该服务实际使用的 ID。Jin 会在操作系统支持时使用系统安全存储保护 Provider 凭据。

### 需求示例

与其只说“整理一下项目”，不如清楚说明希望实现的行为和约束：

> 为项目列表添加服务端分页。翻页时保留当前筛选条件，显示加载状态和空状态，并为分页控件补上测试。不要更改项目 API 的响应格式。

Jin 会把需求整理成 Intent 和建议的架构变更。批准前请检查受影响节点、节点职责和风险；如果提案涉及的模块不对，可以先补充需求再批准。

## 项目文件

Jin 将项目级、适合团队共享的数据保存在 `.jin/`，并把本地缓存放进忽略目录：

```text
.jin/
  config.yaml       # 项目名称、扫描目录、忽略规则和界面默认值
  wal.jsonl         # 已批准的架构决策和版本历史
  .gitignore        # 忽略本地缓存
  cache/            # 本地数据库、LSP 数据、向量索引和临时文件
```

`.jin/config.yaml` 示例：

```yaml
version: 1
project:
  name: sample-app
  languages:
    - typescript
    - react
scan:
  roots:
    - src
    - electron
  ignore:
    - node_modules
    - dist
    - .git
    - .jin/cache
approval:
  mode: single
  required: 1
ui:
  theme: dark
  glass: subtle
```

也可以在当前仓库的命令行中初始化项目：

```bash
pnpm run jin:init --name "sample-app" --languages typescript,react
```

初始化命令可以重复运行：缺少项目文件时会创建它们，但不会截断已有 WAL。使用 `--help` 查看所有参数。

## 从源码构建

环境要求：Node.js 24 和 pnpm 12.15.0（仓库配置固定了 pnpm 版本）。

```bash
pnpm install --frozen-lockfile
pnpm dev
```

常用命令：

```bash
pnpm typecheck
pnpm lint
pnpm test --run
pnpm build:app          # 编译渲染进程、Electron 主进程和 preload
pnpm pack:dir           # 为当前平台生成未安装的桌面应用目录
pnpm dist               # 生成当前平台的安装包
```

基于 LSP 的符号发现依赖用户环境中安装的语言服务器。没有语言服务器时，架构扫描仍可运行，但对应语言的符号跳转和诊断会受限。

## 发布

推送语义化版本 tag（例如 `v1.2.3`）即可发布 Windows、macOS 和 Linux 安装包：

```bash
git tag v1.2.3
git push origin v1.2.3
```

发布工作流会校验 tag、运行类型检查/lint/测试，在三个操作系统上构建并冒烟测试应用，最后将安装包和自动更新元数据上传到对应 GitHub Release，并自动生成发布说明。工作流使用仓库提供的 `GITHUB_TOKEN`，不需要个人访问令牌。默认没有配置代码签名和公证凭据。

## 许可证

参见 [LICENSE](LICENSE)。
