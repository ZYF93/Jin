# Jin — 面向架构的 Coding Agent：总计划

> 状态：M0 / M1 完成，M2 下一步  
> 原则：先打通最难的地基（WAL / 版本 / 团队合并 / 扫描），再往上做 UI 和 Agent。  
> 每完成一项就把 `[ ]` 改成 `[x]`，并在文件末尾的 Work Log 记一行。

## 0. 产品一句话

Jin 是一个面向架构的桌面 coding agent：用户每轮需求先变成 **Intent**，再变成可审阅的 **L0/L1 架构 diff**；批准后写入团队共享的 **WAL 架构账本**，再由 Agent 实现代码，并通过 LSP 重新扫描核验“代码是否真的符合已批准的架构”。

它不是“又一个聊天写代码工具”，核心资产是：

- Intent → L0/L1 → Code 的可追溯链路；
- 团队共享、可合并的架构账本；
- 批准前的架构 diff；
- 写代码前的复用检索；
- 写完代码后的架构一致性核验。

## 1. 已锁定的决策

- [x] 独立产品，不复用 `opencode-jin` 的代码。
- [x] 团队优先，异步 Git 协作；不做实时协同。
- [x] 多语言目标：TS/React、Vue、Python、Java、Kotlin、Go；先跑通 TS/React。
- [x] Eko 只负责它擅长的编排/工具/HITL；不足部分自研或用其他库补。
- [x] Tailwind CSS v4。
- [x] Electron + React + TypeScript + Vite+。
- [x] 架构目录是 `.jin/`；SQLite 和临时缓存放 `.jin/cache/`；`.jin/.gitignore` 忽略 `cache/`。
- [x] WAL 是单文件 `.jin/wal.jsonl`，操作级记录，支持多人合并；版本主键用 ULID，UI 显示序号。
- [x] 每轮需求都有 Intent 和 Version；小改动用 L1 facet 的 `touch` 标黄。
- [x] 架构 diff 颜色：新增绿、删除红、修改黄；facet → L1 → L0 颜色向上传染。
- [x] 架构图用无限画布；只提供“全部展开/全部收起”，不提供“只看 L0”开关。
- [x] 审批只需要一次批准；批准页展示 Intent + 架构图 diff + 风险提示，不展示代码 diff。
- [x] 写代码前必须通过意图 RAG 召回已有代码并给出 ReusePlan。
- [x] 写完代码必须做架构核验（LSP 重扫 + drift + conformance），不能只看 lint。
- [x] LSP 依赖用户环境；缺语言服务器时提示用户自行安装。
- [x] Agent 工具平台包含 Skill 和 MCP；MCP 支持远程；首次启用不强制审批，但要审计。
- [x] 文件面板只读：文件树 + 查看文件；右上角提供“用默认编辑器打开”的角标。
- [x] 外层窗口用 Electron 默认边框/原生菜单；内容区适度液态玻璃。
- [x] 字体 Maple Mono NL NF CN 打包进安装包。
- [x] 窗口变窄时优先收起意图列表，聊天始终保留。

## 2. 核心概念

```text
Turn
  └─ Intent（Goal / Tasks / NodeIntents）
       └─ Version（本轮架构变更；可以是 structural / touch-only / intent-only）
            ├─ Ops（L0/L1 节点与边）
            ├─ Touches（只改代码时，标记 L1 facet）
            └─ Decision（用户一次批准 / 拒绝）
                 └─ Implementation（git commit / checks / conformance）
```

### 2.1 三层

- **Intent**：为什么做、任务拆解、每个节点/方法的意图。
- **L0**：系统、领域、模块、分层、外部依赖、约束。
- **L1**：组件、hook、实体、服务、仓储、路由、store、类型、函数等；方法/属性是 L1 节点下的 facet。

### 2.2 不变量

- 节点 ID 稳定；文件路径和符号只是属性。
- `declared`（人/Agent 批准）和 `observed`（LSP 扫描）分开存。
- 只有批准后的 Version 才改变当前架构快照。
- Agent 不能写 `.jin/wal.jsonl`，不能批准；批准由主进程完成。
- 代码偏离已批准架构时，修代码或开 amendment；不允许静默改架构。
- WAL 是团队共享的 source of truth；SQLite 是可重建的本地物化视图。

## 3. 技术栈

| 层 | 选择 |
| --- | --- |
| 桌面 | Electron 44 + electron-builder |
| UI | React 18 + Tailwind CSS v4 + 自研组件 |
| 图 | React Flow（无限画布）+ ELK 布局 |
| 文件查看 | 文件树 + Shiki 只读高亮 |
| 状态 | Zustand（渲染进程） |
| 数据库 | SQLite via `node:sqlite`（Electron 44 / Node 24；FTS5 已验证可用，避免原生模块 rebuild） |
| 扫描 | LSP adapter + LLM semantic pass |
| Agent | Eko 4.x（adapter 隔离）+ 自研 coding tools |
| RAG | SQLite FTS5 + 向量 BLOB（v1 暴力余弦） |
| 校验 | TypeScript/Vitest/Oxlint + 各语言 LSP/测试命令 |
| 打包 | Vite+ / electron-builder |

## 4. 目录约定

```text
.jin/
  config.yaml          # 项目配置（提交）
  wal.jsonl            # 架构账本（提交）
  mcp.json             # MCP 配置（可选，提交；密钥不写入）
  skills/              # 项目级 skills（可选，提交）
  .gitignore           # cache/
  cache/               # 全部本地缓存（不提交）
    index.db
    lsp/
    embeddings/
    toolchains/
    tmp/
```

应用级数据（最近项目、全局设置、密钥索引）放 Electron `userData`，不放进项目。

## 5. 里程碑

### M0 — 地基：`.jin/`、WAL、版本核心

- [x] 清理旧的 `arch/` / `jin.yaml` 占位
- [x] 创建 `.jin/` 脚手架 + `.jin/.gitignore`
- [x] 配置读写：`.jin/config.yaml`
- [x] 项目初始化 / 根目录检测
- [x] WAL 记录类型与 schema
- [x] ULID、HLC、canonical JSON、SHA-256
- [x] WAL 读取 / 追加 / 校验
- [x] WAL fold：Intent / Version / Op / Touch / Decision
- [x] 只应用已批准 Version；拒绝版本只进历史
- [x] 两分支 WAL 合并 + 语义冲突检测
- [x] 单元测试：roundtrip、fold、merge、conflict、touch
- [x] `jin init` CLI
- [x] WAL 格式文档（`docs/wal.md`）

**M0 完成标准**：`vp test` 全绿；两个模拟分支可以合并不同节点的改动；同一 facet 并发修改能报冲突；`.jin/` 可被重新初始化。

### M1 — SQLite 快照与缓存

- [x] schema / migration
- [x] `.jin/cache/index.db`
- [x] WAL → SQLite 全量 rebuild
- [x] append/pull 后 refresh（v1 整快照事务；record-level 增量留给 M5 file watcher）
- [x] FTS5 基础表
- [x] 应用级 DB：最近项目 / 设置
- [x] 数据库测试

### M2 — Electron 壳与文件面板

- [ ] 原生菜单：Project / Recent / Open / New / Settings / Quit
- [ ] 主进程 / preload / renderer typed IPC
- [ ] 活动栏 + 三栏布局 + 响应式
- [ ] Tailwind v4 + 设计 token + 液态玻璃层
- [ ] 打包 Maple Mono NL NF CN
- [ ] 设置面板骨架
- [ ] 文件树 + 只读查看器 + 外部编辑器角标
- [ ] 架构面板 / 聊天面板骨架

### M3 — 架构图

- [ ] React Flow 无限画布
- [ ] L0 布局 + 全部展开/收起
- [ ] L1 内联展示
- [ ] diff 颜色 + facet→L1→L0 传染
- [ ] 右上固定 inspector（文件/方法/属性/意图/关系）
- [ ] 聚焦模式 / 直接关系边
- [ ] 视口裁剪与性能
- [ ] fixture 数据

### M4 — Intent / Version / 审批

- [ ] 意图列表时间线 + 抽屉详情
- [ ] 版本状态与 touch 标黄
- [ ] 审批页：Intent + 架构图 diff + 风险提示
- [ ] 一次批准 / 拒绝 / 要求修改
- [ ] 批准签名 + 写入 WAL
- [ ] 历史版本回放
- [ ] 团队 merge 冲突 UI

### M5 — LSP 多语言扫描

- [ ] LSP adapter 接口与 capability 模型
- [ ] 检测用户环境；缺失时提示安装
- [ ] TS/React adapter
- [ ] Vue / Python adapter
- [ ] Java / Kotlin / Go adapter
- [ ] 文件监听与增量扫描
- [ ] LSP facts → SQLite
- [ ] LLM semantic pass：模块/领域/分层/责任/L1 kind/intent
- [ ] LLM 位置与 LSP facts 对账
- [ ] 初始 import version + 批准
- [ ] scan_manifest + 缓存

### M6 — RAG 与复用

- [ ] Intent card / node card
- [ ] FTS5 中文策略
- [ ] 向量 BLOB + 暴力余弦
- [ ] 图扩展检索
- [ ] ReusePlan 生成
- [ ] Reuse guard 校验
- [ ] Agent 检索工具
- [ ] 复用评估 fixture

### M7 — Agent 运行时

- [ ] `AgentRuntime` 端口
- [ ] Eko adapter（pin 4.x）
- [ ] Intent / Architect / Coder / Verifier 四个 agent
- [ ] 自研 tools：arch / code / LSP / git / test / patch / shell
- [ ] MCP manager（stdio / SSE / HTTP / remote）
- [ ] Skill manager
- [ ] 权限与审计
- [ ] 流式事件 → 聊天
- [ ] 会话持久化

### M8 — 代码实现与核验

- [ ] approved target 上下文构建
- [ ] ReusePlan 先于写代码
- [ ] patch 化文件修改
- [ ] test / lint / typecheck runner
- [ ] 架构核验：LSP 重扫 + drift + conformance
- [ ] Implementation record 写入 WAL
- [ ] Amendment 流程

### M9 — 团队协作

- [ ] Git merge driver
- [ ] `.gitattributes` 安装
- [ ] 身份与签名
- [ ] 一次批准策略
- [ ] 合并冲突 → merge intent
- [ ] pull / replay UX
- [ ] 审计与篡改检测
- [ ] 两分支版本模拟测试

### M10 — UI 打磨

- [ ] 液态玻璃 token 与降级
- [ ] Maple Mono 全量加载
- [ ] 动效 / reduced motion
- [ ] 窄窗口：先收意图列表，聊天常驻
- [ ] 设置：Provider / 模型 / 外观 / 工具
- [ ] 最近项目 / 文件夹丢失处理
- [ ] 命令面板（可选）

### M11 — 打包与发布

- [ ] electron-builder 配置
- [ ] SQLite 原生模块 rebuild
- [ ] 字体许可证
- [ ] Linux / macOS / Windows 冒烟
- [ ] 自动更新（可选）

### M12 — 评估与吃自己的狗粮

- [ ] 多语言 fixture 仓库
- [ ] 黄金 WAL / diff 测试
- [ ] 指标：审批时长、drift、复用率、成本
- [ ] 用 Jin 管理 Jin 自己的架构

## 6. WAL 格式（M0 目标）

`.jin/wal.jsonl` 一行一条记录；行顺序只是 append 顺序，语义顺序由 `parents` + HLC 决定。

```json
{"t":"intent","id":"01J...","versionId":"01J...","actor":{"id":"user:joshua","kind":"user","name":"Joshua"},"hlc":"...","parents":[],"payload":{"title":"...","goal":"...","tasks":[],"nodeIntents":[]},"hash":"sha256:..."}
{"t":"op","id":"01J...","versionId":"01J...","actor":{...},"hlc":"...","parents":["01J..."],"payload":{"op":"node.add","node":{...}},"hash":"sha256:..."}
{"t":"touch","id":"01J...","versionId":"01J...","actor":{...},"hlc":"...","parents":["01J..."],"payload":{"nodeId":"cmp-x","facetId":"fn-y","reason":"...","codeRefs":[],"tests":[]},"hash":"sha256:..."}
{"t":"decision","id":"01J...","versionId":"01J...","actor":{"id":"user:joshua","kind":"user","name":"Joshua"},"hlc":"...","parents":["01J..."],"payload":{"decision":"approved","baseHash":"...","targetHash":"...","diffHash":"...","signature":"...","note":""},"hash":"sha256:..."}
```

规则：

- 每条记录内容寻址；`hash = sha256(canonical(record without hash))`。
- `parents` 是因果父记录，不是 Git 父提交；合并时取并集。
- `node.update` / `node.remove` / `edge.remove` 带 `beforeHash`，用于检测并发写冲突；`beforeHash` 不包含时间戳/touch 标记。
- 批准绑定 `diffHash`（Intent + Ops + Touches 的 reviewed change set）；`baseHash` / `targetHash` 是审计信息。这样两个互不相交的并发批准可以安全合并，只有真正冲突的 write 才变成 `conflicted`。
- 拒绝也写 decision，但不 apply 到快照。

## 7. 风险与对策

| 风险 | 对策 |
| --- | --- |
| 审批地狱 | 每轮只一次批准；touch-only 版本 diff 很小；支持全部展开/收起 |
| Intent 腐烂 | 只给关键节点写 NodeIntent；track `lastTouchedIn`；UI 标记 stale |
| 团队 Git 合并 | 单文件 Merkle DAG + merge driver + 语义冲突 UI |
| LSP 多语言环境 | 检测用户环境；缺失提示安装；不让应用背全部 runtime |
| Agent 乱写代码 | Agent 只写提案；代码 patch 化；Verifier 独立只读 |
| 范围爆炸 | 严格按 M0 → M12；先核心闭环，再视觉打磨 |
| Eko API 漂移 | `AgentRuntime` 适配层 + pin 版本 |
| 性能 | 无限画布 + 视口裁剪 + 全部展开/收起 + SQLite 索引 |

## 8. Work Log

- 2026-10-26：锁定产品方向；确定 `.jin/`、单文件 Merkle WAL、团队异步 Git、LSP+LLM 扫描、只读文件面板、原生菜单 + 内容区玻璃。开始 M0。
- 2026-10-26：M0 完成。落地 `.jin/` 脚手架、`jin init`、配置读写、ULID/HLC/canonical hash、WAL 读写校验、approved-only fold、touch/intent 传播、两分支合并与 stale-write 冲突检测；WAL v1 规范见 `docs/wal.md`；`pnpm typecheck` 通过，`pnpm test --run` 5 个文件 19 个测试全绿。下一步 M1 SQLite 快照。
- 2026-10-26：M1 完成。采用 Electron 44 内置 `node:sqlite`（Node 24，FTS5 已验证），落地 `.jin/cache/index.db` schema、WAL→SQLite 全量 materialize、append/pull 后 refresh、node FTS5、应用级最近项目/设置 DB；`pnpm typecheck`、`pnpm lint` 通过，`pnpm test --run` 6 个文件 21 个测试全绿。下一步 M2 Electron 壳 + 文件面板。
