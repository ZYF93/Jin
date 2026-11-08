# Jin — 面向架构的 Coding Agent：总计划

> 状态：M0–M12 主体完成，Jin 已用自身管理架构。剩余：macOS/Windows 冒烟、自动更新 feed、M7 通用 shell / patch / token 流式输出。
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
- [x] 架构图默认只显示 L0；点击 L0 区块展开对应 L1，facet 只出现在 L1 inspector。
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

- [x] 原生菜单：Project / Recent / Open / New / Settings / Quit
- [x] 主进程 / preload / renderer typed IPC
- [x] 活动栏 + 三栏布局 + 响应式
- [x] Tailwind v4 + 设计 token + 液态玻璃层
- [x] 打包 Maple Mono NL NF CN
- [x] 设置面板骨架
- [x] 文件树 + 只读查看器 + 外部编辑器角标
- [x] 架构面板 / 聊天面板骨架

### M3 — 架构图

- [x] React Flow 无限画布
- [x] L0 默认视图 + 系统/分层/领域/模块真实嵌套为区块
- [x] 点击 L0 区块只展开其直接 L1；展开时区域增长、兄弟重排，视口保持当前缩放
- [x] L1 事实（方法/字段/属性/其他）只进入 inspector，不画成独立节点
- [x] 画布始终显示所选版本/提案的 diff；历史版本内联切换 diff，无 “View snapshot” 弹窗
- [x] diff 颜色 + facet→L1→L0 传染
- [x] 右侧固定 inspector（文件/事实分组/版本意图/关系）
- [x] 自定义根区块 fit（不依赖 React Flow 测量队列），工具栏“适应画布”可用
- [x] 聚焦模式 / 直接关系边（聚焦按钮只保留所选节点及其直接邻接边，退出聚焦恢复全图并 refit）
- [x] 视口裁剪与性能（`onlyRenderVisibleElements`；facet 不进入画布，大图按 L0 区块收起）
- [x] fixture 数据（内置 demo 架构，无需打开项目即可查看图 / 关系 / inspector）

### M4 — Intent / Version / 审批

- [x] 意图列表时间线 + 抽屉详情
- [x] 版本状态与 touch 标黄
- [x] 审批页：Intent + 架构图 diff + 风险提示
- [x] 一次批准 / 拒绝（“要求修改”由拒绝 + 备注表达，没有独立状态）
- [x] 批准签名 + 写入 WAL
- [x] 历史版本回放（从 WAL 祖先闭包重建 base/target 快照，只读图 diff）
- [x] 团队 merge 冲突 UI（冲突列表 + 详情；merge intent 流程见 M9）

### M5 — LSP 多语言扫描

- [x] LSP adapter 接口与 capability 模型
- [x] 检测用户环境；缺失时提示安装
- [x] TS/React adapter
- [x] Vue / Python adapter
- [x] Java / Kotlin / Go adapter
- [x] 文件监听与增量扫描（source watcher + mtime/size manifest）
- [x] LSP facts → SQLite
- [x] LLM semantic pass：模块/领域/分层/责任/L1 kind/intent
- [x] LLM 位置与 LSP facts 对账
- [x] 初始 import version + 批准
- [x] scan_manifest + 缓存

### M6 — RAG 与复用

- [x] Intent card / node card
- [x] FTS5 中文策略
- [x] 向量 BLOB + 暴力余弦
- [x] 图扩展检索
- [x] ReusePlan 生成
- [x] Reuse guard 校验
- [x] Agent 检索工具
- [x] 复用评估 fixture

### M7 — Agent 运行时

- [x] `AgentRuntime` 端口
- [x] Eko adapter（pin 4.x）
- [x] Intent / Architect / Coder / Verifier 四个 agent
- [x] 自研 tools：architecture / code / LSP / test
- [x] patch / shell 工具（patch-first 写入；shell 受项目根目录、默认 15s / 上限 30s、32KB 输出上限、进程组终止与 `.jin/cache/shell-audit.jsonl` 审计约束）
- [x] MCP manager（stdio / SSE / HTTP / remote）
- [x] Skill manager
- [x] 权限与审计（MCP tools/list 与 tools/call、shell 全量审计；shell 拒绝绝对路径、父目录穿越和破坏性命令）
- [x] 流式事件 → 聊天（规划与实现均有 token 级 `stream` 事件和聊天预览）
- [x] 会话持久化

### M8 — 代码实现与核验

- [x] approved target 上下文构建
- [x] ReusePlan 先于写代码
- [x] patch 化文件修改（统一 diff 解析 / 应用；失败保留明确 warning 并跳过该文件）
- [x] test / lint / typecheck runner
- [x] 架构核验：LSP 重扫 + drift + conformance
- [x] Implementation record 写入 WAL
- [x] Amendment 流程（实现后 drift 未通过时，从历史版本发起架构修正提案；只改架构、不跑代码）

### M9 — 团队协作

- [x] Git merge driver
- [x] `.gitattributes` 安装
- [x] 身份与签名
- [x] 一次批准策略
- [x] 合并冲突 → merge intent（三分支按字段合并，保留双方不重叠改动；冲突字段保留当前值并列为风险）
- [x] pull / replay UX（外部 WAL 变更落盘后自动重放并摘要；每个历史版本可回放只读图 diff）
- [x] 审计与篡改检测
- [x] 两分支版本模拟测试

### M10 — UI 打磨

- [x] 液态玻璃 token 与降级
- [x] Maple Mono 全量加载
- [x] 动效 / reduced motion
- [x] 窄窗口：先收意图列表，聊天常驻
- [x] 设置：Provider / 模型 / 外观 / 工具
- [x] 最近项目 / 文件夹丢失处理
- [x] 命令面板（Cmd/Ctrl+K；项目、导航、审阅、展开/收起、设置、语言切换）
- [x] 中文 / English 全界面切换（渲染层、原生菜单、会话消息、风险、核验证据、合并驱动说明）

### M11 — 打包与发布

- [x] electron-builder 配置
- [x] SQLite 原生模块 rebuild（使用 Electron 内置 `node:sqlite`，无需 rebuild）
- [x] 字体许可证
- [x] Linux `dir` 打包冒烟（桥接、版本、packaged 标记）
- [ ] macOS / Windows 冒烟（本机无法运行，已由 `.github/workflows/package-smoke.yml` matrix 覆盖）
- [x] 自动更新（启动静默检查 + 手动下载 / 安装；generic feed、设置覆盖与 `JIN_UPDATE_FEED_URL`；开发环境无 feed 时禁用）

### M12 — 评估与吃自己的狗粮

- [x] 多语言 fixture 仓库
- [x] 黄金 WAL / diff 测试
- [x] 指标：审批时长、drift、复用率、成本
- [x] 用 Jin 管理 Jin 自己的架构

### M13 — 对话分流与 Git 面板（2026-11-05 追加）

- [x] `chat` / `plan` 单次分类；纯聊天跳过 Intent / Proposal / WAL，并携带最近对话历史
- [x] 取消规划不生成 fallback 提案
- [x] 无默认 Provider；未配置时禁用聊天输入并引导设置
- [x] 远端模型目录 + 动态 reasoning effort + context window 自动填充
- [x] Git 面板：status、stage / unstage、commit、push、pull、fetch、log、commit patch
- [x] Git 操作安全：`execFile` 参数数组、路径校验、push / pull / fetch 网络超时、pull `--ff-only`
- [x] 中英文 Git / Provider / 纯聊天文案
- [x] 自动更新 UI（检查 / 下载 / 安装 / feed 设置）

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
| 性能 | 递归区块布局 + 只渲染可见 L0/L1（facet 不进入画布）+ SQLite 索引 |

## 8. Work Log

- 2026-10-26：锁定产品方向；确定 `.jin/`、单文件 Merkle WAL、团队异步 Git、LSP+LLM 扫描、只读文件面板、原生菜单 + 内容区玻璃。开始 M0。
- 2026-10-26：M0 完成。落地 `.jin/` 脚手架、`jin init`、配置读写、ULID/HLC/canonical hash、WAL 读写校验、approved-only fold、touch/intent 传播、两分支合并与 stale-write 冲突检测；WAL v1 规范见 `docs/wal.md`；`pnpm typecheck` 通过，`pnpm test --run` 5 个文件 19 个测试全绿。下一步 M1 SQLite 快照。
- 2026-10-26：M1 完成。采用 Electron 44 内置 `node:sqlite`（Node 24，FTS5 已验证），落地 `.jin/cache/index.db` schema、WAL→SQLite 全量 materialize、append/pull 后 refresh、node FTS5、应用级最近项目/设置 DB；`pnpm typecheck`、`pnpm lint` 通过，`pnpm test --run` 6 个文件 21 个测试全绿。下一步 M2 Electron 壳 + 文件面板。
- 2026-10-27：M2–M4 完成。Electron 壳、typed IPC、原生菜单、响应式三栏、Tailwind v4 玻璃层、Maple Mono、只读文件面板、React Flow L0/L1/facet 图、diff 颜色传染、固定 inspector、Intent 时间线与一次审批/拒绝、WAL decision 记录。
- 2026-10-28：M5–M8 完成主体。LSP 检测/多语言结构扫描/LSP facts SQLite/文件监听、LLM semantic pass 与事实对账；BM25 + 特征哈希向量 + FTS5 + 图扩展 RAG、ReusePlan/guard；Skill/MCP（stdio/HTTP/SSE/remote）与审计、Eko 4.1.3 可选 runtime + 自定义 coder；批准目标实现、项目检查、重扫 conformance、Implementation 记录。Eko 成功与回退两条 E2E 均已跑通。
- 2026-10-28：M9–M12 主体。WAL merge driver + `.gitattributes`、身份/单次批准、冲突列表 UI；主题/字体/动效/响应式/settings/recents；electron-builder Linux `dir` 包与打包版 merge driver；黄金 WAL/snapshot、多语言扫描、import 测试。
- 2026-10-29：完成增量扫描 manifest：按 `mtimeMs` + `size` 复用结构解析结果，LSP facts 每次扫描重新合并；manifest 持久化到 `.jin/cache/scan-manifest.json`，损坏缓存自动冷扫描；新增 manifest 缓存/失效/round-trip 测试。同步更新本计划勾选状态与 Work Log，明确未完成项。`pnpm typecheck`、`pnpm lint` 通过，`pnpm test --run` 16 个文件 57 个测试全绿。
- 2026-10-29：重建 Linux `dir` 包并冒烟：asar 内主进程与 Eko 动态 chunk 均可加载；打开项目、扫描、写入 scan manifest、审批、provider 失败回退、Eko 经 mock SSE provider 暂存并写入文件均跑通。Eko 写入未批准的 `src/eko-packaged.ts` 被 conformance 标记，符合“代码不得静默偏离已批准架构”的预期。
- 2026-10-30：完成历史版本回放。新增 `replayVersion` WAL 重建器：用 intent 记录的父链祖先闭包重建 base 快照，再按 ops/intent/touches 重建审阅时 target；拒绝版本仍显示当时提案但永不应用。回放校验 base/target/diff 哈希并输出 warning。IPC、store、Intent 历史行“View snapshot”、只读图 diff 弹窗全部接通。新增基于黄金 WAL 的 4 个回放测试；`pnpm typecheck`、`pnpm lint` 通过，`pnpm test --run` 17 个文件 61 个测试全绿。
- 2026-10-30：回放 UI 冒烟完成（开发版 + 黄金 WAL 三版本）：v1 新增 4 节点、v2 touch-only 空 diff、v3 拒绝提案显示重命名但 live 仍为 Counter；篡改批准 targetHash 后弹窗显示 2 条 hash warning，恢复后消失。回放使用独立 expanded/selected 状态，展开、折叠、选中均不会改动主图；拒绝决定若绑定未变 base，显示说明而非误报“哈希匹配”。回放测试增至 6 个（approved target/diff 篡改告警、rejected 例外），全套 63 个测试通过。
- 2026-10-30：完成 Amendment 流程并冒烟：只有“已实现且最近一次实现 drift 检查失败”的版本才提供 “Amend architecture”；`ProjectSession.amendArchitecture` 重扫后把 scan diff 生成为架构专属提案（Intent mode=`architecture`），审批页显示 “Approve architecture”，批准只写 WAL、不启动实现、不产生 implementation 记录。smoke 中 v2 drift → v4 修正 7 个节点，agent 保持 idle，消息明确“无需运行代码”。同时修复 `snapshot.implementations` 以 WAL 记录 ID 为键、conformance 结果新增 `kind: "op" | "drift"`、历史行展示失败检查证据；`intent.mode` 持久化后重启仍会隐藏架构版本的 “Implement version”。`pnpm typecheck`、`pnpm lint` 通过，`pnpm test --run` 19 个文件 67 个测试全绿。
- 2026-10-30：完成 merge intent 与 pull/replay UX。Git 合并写入的冲突版本带 `versionId`；`ProjectSession.mergeIntent` 用各分支自己的 base/target 做字段级三方合并，双方改同一字段时保留当前值并列为风险，审批只改架构、`intent.resolves` 隐藏已被调和的冲突。外部 WAL 写入由 watcher/refresh 重放并在聊天中摘要新版本，本进程写入用 `localWrites` 排除回声。新增 6 个 merge planner 测试；smoke 中 v4 改名 Tally、v5 改职责产生 stale-write，v6 merge intent 合成 “Tally + Tracks clicks per session.”，v7 外部追加由 watcher 拉取。`pnpm typecheck`、`pnpm lint` 通过，`pnpm test --run` 20 个文件 73 个测试全绿。
- 2026-10-31：完成交付指标。新增 `metrics` 状态：审批时长（intent→首次批准的中位数/均值）、drift 率（每个版本最近一次 implementation 的 drift conformance）、复用率（reuse guard pass/fail/skip）与 provider token/成本；UsageLedger 持久化到 `.jin/cache/usage.json`，OpenAI/Ollama 非流式与 Eko finish 事件均采集 token，成本按 Settings 中每个模型的可选 USD/1M token 价格在调用时计价。Project health 增加 Delivery metrics 卡片。smoke 中日历 fixture 显示 10ms 审批中位数、50% drift、50% reuse、9000 tokens / $0.0123；同时修复 `snapshot.decisions` 以 WAL 记录 ID 为键，避免指标/回放按 `VersionState.decisions` 查不到决定。`pnpm typecheck`、`pnpm lint` 通过，`pnpm test --run` 23 个文件 81 个测试全绿。
- 2026-11-01：完成“用 Jin 管理 Jin 自己”。以 `/home/joshua/Progs/Jin` 打开项目，扫描 97 个文件、2229 个符号，生成 2013 个节点 / 2482 条边的初始架构；审阅页正确显示 Intent、L0/L1 图 diff、2 条风险与 “Approve architecture”，批准后 v1 为 architecture-only：status=approved、current，0 条 implementation，agent 保持 idle。WAL 写入 4495 条 op + 1 条 intent + 1 条 decision；重启后重新加载 2013 节点，重扫提示 “Architecture is in sync with source facts”。狗粮同时暴露并修复两个问题：审批时逐条 `appendRecord` 会对 4495 条记录执行 4495 次 fsync，主进程长时间无响应——新增 `appendRecords` 批量单次 fsync，并在写入前校验整批记录；新提案超过 120 个受影响节点时默认收起到 L0（回放同理），React Flow 改为 `onInit` 后 fit、开启 `onlyRenderVisibleElements`。已知剩余打磨：50 个 L0 节点仍会被 fit 成一条很窄的横向条带，需要换行布局或语义缩放。另用 302 个文件 / 3309 节点的临时项目验证批量写入：7217 条 op 的审批（含 WAL 写入、fold、SQLite 物化与状态刷新）端到端 1.0 秒，重扫 354ms 且提示架构与源码一致。`pnpm typecheck`、`pnpm lint` 通过，`pnpm test --run` 23 个文件 82 个测试全绿。
- 2026-11-03：完成分层审阅画布与中英文收尾。`src/lib/graph.ts` 改为递归区块布局：默认只显示 L0；system/layer/domain/module 按真实 `parentId` 嵌套为实线 header + 虚线 region body；外部依赖保持根级卡片，不撑大 system 区块；只有展开的 L0 才渲染直接 L1；facet 永不进入画布，方法/字段/属性/其他事实在 L1 inspector 分组展示。展开/收起不 remount React Flow，`layoutKey` 保持稳定，区域尺寸由子节点行布局增长，兄弟区块重排，视口保持当前缩放并用 `setCenter` 平移；初始 fit 改为直接根据根区块 bounds 计算 `setViewport`，绕过 React Flow 在该节点模型下不 resolve 的 `fitView` 队列，工具栏“适应画布”恢复。画布默认加载最新已批准版本的 diff；点击意图历史内联切换 base/target diff，无 “View snapshot” 按钮。冒烟用临时项目创建 v1 导入 + v2 新增模块：v2 显示 system 修改黄色、Payments 新增绿色，v1 切回全新增绿色；展开 src 后只出现其 L1，inspector 显示事实分组和版本意图。补齐 Cmd/Ctrl+K 命令面板、中文/English 全界面切换，以及原生菜单、风险提示、核验证据、项目检查说明、复用计划摘要/原因、复用守卫检查名与详情、merge driver 安装/说明和默认身份文案的本地化；无 Provider 时的本地规划器标题、任务与助手消息也按当前语言生成。新增区块嵌套/展开、风险/证据、复用守卫与本地规划器翻译测试；`vp run typecheck`、`vp run lint` 通过，`vp run test --run` 26 个文件 101 个测试全绿，`vp build` 成功。剩余限制：macOS/Windows 冒烟、自动更新 feed、M7 通用 shell / patch 化写入 / token 级流式输出；所有改动未提交。
- 2026-11-05：完成纯聊天分流、无默认 Provider、远端模型与 Git 面板。`planWithProvider` 现在一次调用输出 `kind: "chat" | "plan"`；纯聊天携带最近对话直接写入 assistant 消息，不创建 Intent / Proposal / WAL；用户取消规划不再触发本地 fallback 提案。设置默认 Provider 为 `none` + 空 endpoint / model，`isProviderConfigured` 统一判定（API key 可选），未配置时聊天输入禁用并引导设置。设置页与聊天 composer 从 OpenAI-compatible `/models` / `/v1/models` 或 Ollama `/api/tags` 拉取模型，读取 context window 与 reasoning capability，并保留手动输入。新增 Git 服务与面板：status / stage / unstage / commit / push / pull / fetch / log / show，`execFile` 参数数组 + 路径校验 + 网络超时 + pull `--ff-only`；左侧活动栏新增 Git，中英文文案齐备。CDP 验证：假 SSE Provider 纯聊天 157ms 返回且 `proposal=null`，plan 请求 394ms 生成提案，未配置 Provider 返回 `error.providerRequired` 且不追加用户消息，取消后无提案；临时 Git 仓库完成 stage → commit → history patch → push（自动设置 upstream）→ fetch → pull。`vp run typecheck`、`vp run lint`、`vp run test --run` 通过（36 files / 176 tests），`vp run build:app` 成功。限制：macOS / Windows 仍只能靠 GitHub Actions matrix；真实自动更新下载 / 安装需要发布 feed 与签名产物，本地只验证状态机和开发 feed 路径。
