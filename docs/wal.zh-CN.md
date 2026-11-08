# Jin WAL v1

[English](wal.md)

> WAL 是 Jin 架构历史的唯一事实来源。SQLite 只是可丢弃、可重建的本地物化视图。

## 1. 文件

- 路径：`.jin/wal.jsonl`
- UTF-8 编码，每行一个 JSON 对象，以 `\n` 结尾。
- 正常工作时只追加。只有 Git 合并驱动可以重写整个文件。
- 不按版本或用户拆分文件。并发分支各自追加记录，合并时对记录取并集。
- 行顺序表示追加顺序。语义顺序由 `parents` 和 HLC 决定。

## 2. 标识

| 标识 | 格式 | 说明 |
| --- | --- | --- |
| 记录 ID | ULID | 与 `hash` 结合用于内容寻址。 |
| 版本 ID | ULID | 对应一轮变更和一次审批。 |
| Intent ID | ULID | v1 中每个版本对应一个 Intent。 |
| 节点/边 ID | ULID | 文件移动或重命名后仍保持稳定。 |
| UI 序号 | 整数 | fold 时派生，只用于界面显示，不是真实 ID。 |

ULID 使用 26 位 Crockford Base32。它们可按创建时间排序，但 WAL 内部顺序仍由 HLC 决定。

## 3. 记录封套

```json
{
  "t": "op",
  "id": "01J...",
  "versionId": "01J...",
  "actor": { "id": "user:joshua", "kind": "user", "name": "Joshua" },
  "hlc": "0000019a2b3c4d:0001:user:joshua",
  "parents": ["01J..."],
  "payload": {},
  "hash": "sha256:..."
}
```

- `t`：`intent | op | touch | decision | implementation`。
- `actor.kind`：`user | agent | system`。
- `hlc`：12 位十六进制墙上时钟毫秒、4 位十六进制计数器和 actor ID。例如：`0000019a2b3c4d:0001:user:joshua`。
- `parents`：因果父记录 ID，不是 Git 父提交。
- `hash`：`sha256(canonical(record without hash))`。计算前会对 `parents` 排序、递归排序对象键；数组顺序保持不变。

## 4. 负载

### 4.1 `intent`

每个版本一条。包含目标、任务列表和节点 Intent。

```json
{
  "id": "01J...",
  "versionId": "01J...",
  "title": "添加聊天流式输出",
  "goal": "用户可以实时看到逐步到达的 token",
  "tasks": [],
  "nodeIntents": [
    {
      "nodeId": "01J...",
      "facetId": "01J...",
      "statement": "负责管理流式传输生命周期",
      "invariants": ["每个会话最多只能有一个活动流"],
      "acceptance": ["取消操作会关闭数据流"]
    }
  ],
  "author": { "id": "user:joshua", "kind": "user", "name": "Joshua" },
  "createdAt": "2026-10-26T12:00:00.000Z"
}
```

`facetId` 可选。facet 是 L1 节点下的方法、字段或属性节点。

### 4.2 `op`

只记录结构变更。

- `node.add`：`{ op, node }`；目标节点必须尚不存在。
- `node.update`：`{ op, id, patch, beforeHash }`；`beforeHash` 是变更前的语义节点哈希。
- `node.remove`：`{ op, id, beforeHash }`；删除节点时也会删除与它相连的边，但不会隐式删除子节点。遗留的孤立节点会导致校验错误，必须显式处理。
- `edge.add`：`{ op, edge }`；已存在的相同边按幂等处理；相同 ID 对应不同内容时属于冲突。
- `edge.remove`：`{ op, id, beforeHash }`。

`beforeHash` 不包含 `introducedIn`、`updatedIn` 和 `lastTouchedIn`。因此，仅代码层面的 touch 变更不会让待处理的结构操作失效。

### 4.3 `touch`

只表示代码变更，不增删或更新结构节点。

```json
{
  "id": "01J...",
  "versionId": "01J...",
  "intentId": "01J...",
  "nodeId": "01J...",
  "facetId": "01J...",
  "reason": "调整重试间隔",
  "codeRefs": ["src/chat/stream.ts"],
  "tests": ["src/chat/stream.test.ts"],
  "actor": { "id": "user:joshua", "kind": "user", "name": "Joshua" },
  "createdAt": "2026-10-26T12:00:00.000Z"
}
```

Touch 会将 facet 及其 L1 父节点的 `lastTouchedIn` 设为当前版本。界面据此标记黄色，而不会虚构结构节点。

### 4.4 `decision`

正常流程中，每个版本对应一项决策。

```json
{
  "id": "01J...",
  "versionId": "01J...",
  "decision": "approved",
  "by": { "id": "user:joshua", "kind": "user", "name": "Joshua" },
  "note": "",
  "baseHash": "sha256:...",
  "targetHash": "sha256:...",
  "diffHash": "sha256:...",
  "signature": "later",
  "createdAt": "2026-10-26T12:00:00.000Z"
}
```

- `diffHash` 将审批绑定到当时审阅的变更集：Intent（标题、目标、任务、节点 Intent）、有序的 op 负载和有序的 touch 负载。fold 会校验它。
- `baseHash` 和 `targetHash` 是审计元数据，记录审阅前后的快照。合并可能改变全局快照，但不相交的变更集仍可能有效；因此 base/target 变化只会产生警告，不会自动判定失败。
- 被拒绝的决策会永久保留，但不会应用到当前快照。

### 4.5 `implementation`

代码生成后写入。

```json
{
  "id": "01J...",
  "versionId": "01J...",
  "gitCommit": "abc123",
  "files": ["src/chat/stream.ts"],
  "checks": [{ "name": "typecheck", "status": "pass", "detail": "" }],
  "conformance": [{ "opId": "01J...", "status": "pass", "evidence": ["LSP symbol"] }],
  "actor": { "id": "agent:coder", "kind": "agent", "name": "Coder" },
  "createdAt": "2026-10-26T12:00:00.000Z"
}
```

只有至少包含一项 conformance 结果，且所有 checks 和 conformance 结果都通过时，版本才是 `verified`。否则状态为 `implemented`。

## 5. Fold（折叠）

当前快照按以下步骤生成：

1. 校验每条记录及其哈希。
2. 对相同记录 ID 去重；报告内容冲突的重复记录。
3. 检查每个父记录是否存在；缺失父记录时拒绝处理。
4. 按 `parents` 拓扑排序；同级时依次使用 HLC 和 ID 决定顺序。
5. 按版本分组。没有 Intent 的记录属于冲突。
6. 推导状态：
   - 没有 decision → `draft`
   - decision 被拒绝 → `rejected`
   - decision 已批准 → `approved`
   - implementation 的 checks/conformance 全部通过 → `verified`
   - 其他 implementation → `implemented`
7. 按 Intent 创建顺序应用 `approved | implemented | verified` 版本。每个版本在快照副本上执行；只有 ops 和 touches 全部成功时才提交该副本。
8. 用版本变更集校验 `decision.diffHash`。
9. 按所有版本的 Intent 创建顺序分配界面序号。
10. 将草稿、已拒绝和冲突版本保留在历史中，但不应用它们的结构变更。

## 6. 冲突

| 冲突 | 原因 | 结果 |
| --- | --- | --- |
| `duplicate-id` | 同一记录 ID 对应不同哈希 | 致命合并错误 |
| `missing-parent` | 合并后的记录集中缺少父记录 | 致命合并错误 |
| `cycle` | 父记录关系形成环 | 致命合并错误 |
| `missing-intent` | op/touch/decision 没有关联 Intent | 忽略该记录 |
| `missing-node` | op 操作的目标节点不存在 | 版本状态为 `conflicted` |
| `missing-edge` | 删除的边不存在 | 版本状态为 `conflicted` |
| `stale-write` | `beforeHash` 已不匹配 | 版本状态为 `conflicted` |
| `approval-mismatch` | `diffHash` 校验失败 | 版本状态为 `conflicted` |

冲突版本会继续保留在历史中。桌面应用会将它们整理成 merge intent，供用户解决；WAL 不会被静默改写。

## 7. Git 合并

Git 使用 `%O %A %B`（base/ours/theirs）调用未来的合并驱动：

1. 解析三个文件。
2. 按记录 ID 对记录取并集。
3. 按拓扑关系排序。
4. 将确定性的并集写入 `%A`。
5. 仅在解析或排序损坏时返回非零退出码。架构语义冲突会交给应用处理，并转换成 merge intent。

用户启用团队模式时，Jin 会安装以下 `.gitattributes` 项：

```gitattributes
.jin/wal.jsonl merge=jin-wal
```

## 8. 安全与权限

- Agent 可以创建 Intent、ops、touches 和 implementation 记录。
- Agent 不得追加 decision，也不得重写 `.jin/wal.jsonl`。
- 用户批准后，由主进程写入 decision。
- `signature` 为真正的签名机制预留。示例中的 `"later"` 仅是 v1 占位值，不是有效的生产值。
- 密钥不得写入 `.jin/`；MCP 凭据保存在操作系统钥匙串中。

## 9. Schema 演进

`ArchSnapshot.schemaVersion` 为 `1`。未来变更必须保持向后兼容地增加字段，或提供可从旧 WAL 重建快照的迁移。迁移不会重写 WAL 本身。
