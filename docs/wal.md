# Jin WAL v1

> The WAL is Jin's source of truth for architecture history. SQLite is a
> disposable local materialization of it.

## 1. File

- Path: `.jin/wal.jsonl`
- One JSON object per line, UTF-8, `\n` terminated.
- Append-only during normal work. Only the Git merge driver may rewrite the
  whole file.
- There is no per-version file and no per-user file. Concurrent branches append
  records; a merge unions them.
- The line order is append order. Semantic order comes from `parents` + HLC.

## 2. Identity

| Id | Shape | Notes |
| --- | --- | --- |
| Record id | ULID | Content-addressed in combination with `hash`. |
| Version id | ULID | One turn / one approval unit. |
| Intent id | ULID | One per version in v1. |
| Node/edge id | ULID | Stable across file moves and renames. |
| UI ordinal | integer | Derived at fold time; never used as the real id. |

ULIDs are 26-character Crockford base32. They are sortable by creation time,
but ordering inside the WAL still uses the HLC.

## 3. Record envelope

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

- `t`: `intent | op | touch | decision | implementation`.
- `actor.kind`: `user | agent | system`.
- `hlc`: 12 hex wall ms, 4 hex counter, actor id. Example:
  `0000019a2b3c4d:0001:user:joshua`.
- `parents`: causal parent record ids. They are **not** Git parents.
- `hash`: `sha256(canonical(record without hash))`; `parents` are sorted before
  hashing, keys are sorted recursively, arrays keep order.

## 4. Payloads

### 4.1 `intent`

One per version. Contains the goal, task list, and node intents.

```json
{
  "id": "01J...",
  "versionId": "01J...",
  "title": "Add chat streaming",
  "goal": "Users can see tokens as they arrive",
  "tasks": [],
  "nodeIntents": [
    {
      "nodeId": "01J...",
      "facetId": "01J...",
      "statement": "Own stream lifecycle",
      "invariants": ["Only one active stream per conversation"],
      "acceptance": ["Cancel closes the stream"]
    }
  ],
  "author": { "id": "user:joshua", "kind": "user", "name": "Joshua" },
  "createdAt": "2026-10-26T12:00:00.000Z"
}
```

`facetId` is optional. A facet is a method/field/property node under an L1 node.

### 4.2 `op`

Structural changes only.

- `node.add`: `{ op, node }`; node must not exist.
- `node.update`: `{ op, id, patch, beforeHash }`; `beforeHash` is the semantic
  node hash before the change.
- `node.remove`: `{ op, id, beforeHash }`; removing a node also removes edges
  touching it, but does **not** implicitly remove children. Orphans are a
  validation error and must be handled explicitly.
- `edge.add`: `{ op, edge }`; an identical existing edge is idempotent, a
  different edge with the same id is a conflict.
- `edge.remove`: `{ op, id, beforeHash }`.

`beforeHash` excludes `introducedIn`, `updatedIn`, and `lastTouchedIn`. A
touch-only code change must not invalidate a pending structural op.

### 4.3 `touch`

A code-only change. It does not add/remove/update structural nodes.

```json
{
  "id": "01J...",
  "versionId": "01J...",
  "intentId": "01J...",
  "nodeId": "01J...",
  "facetId": "01J...",
  "reason": "Adjusted retry delay",
  "codeRefs": ["src/chat/stream.ts"],
  "tests": ["src/chat/stream.test.ts"],
  "actor": { "id": "user:joshua", "kind": "user", "name": "Joshua" },
  "createdAt": "2026-10-26T12:00:00.000Z"
}
```

Touches set `lastTouchedIn` on the facet and its L1 parent. The UI uses this to
mark yellow without inventing a structural node.

### 4.4 `decision`

One decision per version in the normal flow.

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

- `diffHash` binds the approval to the reviewed change set: intent (title, goal,
  tasks, node intents), ordered op payloads, and ordered touch payloads. It is
  what the fold validates.
- `baseHash` and `targetHash` are audit metadata: what the reviewer saw before
  and after the change. A merge can change the global snapshot while the change
  set is still disjoint and valid; changed base/target therefore produce a
  warning, not automatically a failure.
- A rejected decision is kept forever but never applied to the current snapshot.

### 4.5 `implementation`

Written after code exists.

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

`verified` requires at least one conformance result and all checks/conformance
results to pass. Otherwise the version is `implemented`.

## 5. Fold

The current snapshot is produced by:

1. Validate every record and hash.
2. Deduplicate identical record ids; report conflicting duplicates.
3. Check that every parent exists; reject missing parents.
4. Topologically order by `parents`, breaking ties by HLC then id.
5. Group records by version. A record without an intent is a conflict.
6. Derive status:
   - no decision → `draft`
   - rejected decision → `rejected`
   - approved decision → `approved`
   - implementation with passing checks/conformance → `verified`
   - implementation otherwise → `implemented`
7. Apply only `approved | implemented | verified` versions, in intent creation
   order. Each version is applied to a clone and committed only if all ops and
   touches apply cleanly.
8. Validate `decision.diffHash` against the version's change set.
9. Assign the UI ordinal over all versions in intent creation order.
10. Leave draft/rejected/conflicted versions in history without applying their
    structural effects.

## 6. Conflicts

| Conflict | Cause | Result |
| --- | --- | --- |
| `duplicate-id` | same record id, different hash | fatal merge error |
| `missing-parent` | parent not present in the union | fatal merge error |
| `cycle` | parent graph has a cycle | fatal merge error |
| `missing-intent` | op/touch/decision without intent | record ignored |
| `missing-node` | op targets a missing node | version `conflicted` |
| `missing-edge` | edge removal targets a missing edge | version `conflicted` |
| `stale-write` | `beforeHash` no longer matches | version `conflicted` |
| `approval-mismatch` | `diffHash` does not match | version `conflicted` |

`conflicted` versions remain in history. The desktop app turns them into a merge
intent so a human can resolve them; the WAL is not rewritten silently.

## 7. Git merge

The future merge driver is called with Git's `%O %A %B` base/ours/theirs:

1. Parse all three files.
2. Union records by id.
3. Order topologically.
4. Write the deterministic union to `%A`.
5. Exit non-zero only for parse/order corruption. Semantic architecture
   conflicts are returned to the app, which shows a merge intent.

A `.gitattributes` entry will be installed by Jin when the user enables team
mode:

```gitattributes
.jin/wal.jsonl merge=jin-wal
```

## 8. Security / authority

- Agents may create intents, ops, touches, and implementation records.
- Agents must not append decisions or rewrite `.jin/wal.jsonl`.
- The main process writes the decision after the user approves.
- `signature` is reserved for a real signature scheme; `"later"` is a v1
  placeholder in examples, not a valid production value.
- Secrets never go into `.jin/`; MCP credentials stay in the OS keychain.

## 9. Schema evolution

`ArchSnapshot.schemaVersion` is `1`. Future changes must be additive or provide a
migration that can rebuild the snapshot from the old WAL. The WAL itself is not
rewritten by migrations.
