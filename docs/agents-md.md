# AGENTS.md rules in Jin

Jin reads rule files in two layers and injects them into every LLM step — the semantic scan, the planner, and every implementation worker. This is how project conventions, coding style, and output language reach the generated intents, not just the final code.

## The two layers

| Layer | Location | Owned by | Edited in |
| --- | --- | --- | --- |
| **Project rules** | `<project-root>/AGENTS.md` | The repository (commit it) | Any editor |
| **Global rules** | `<app-userData>/AGENTS.md` | You, per machine | **Settings → Agent rules · AGENTS.md** |

Both layers are read fresh on every call — edit the file and the next scan / plan / implementation picks it up without restarting Jin.

Each layer is capped at 16,000 characters per prompt so a huge rules file cannot blow up every request (longer files are truncated with a marker).

## Where the rules are injected

1. **Semantic scan refinement.** The first scan (and every manual rescan) runs an LLM pass that refines the architecture: file/module responsibilities, kind classification, domain tags, and **facet-level (method/field/property) responsibilities**. Your rules are appended to this pass's system prompt, so "always write in Chinese" produces Chinese responsibilities in the review dialog.
2. **Planning.** The planner receives the rules and must shape tasks, acceptance criteria, and node intents within them.
3. **Implementation.** The system prompt of the implementation agent carries the rules, and each sub-agent additionally receives a prominent "Facet-level intent (must satisfy)" block listing the approved intents for its file scope, with a finish-time self-check.

Facet intents generated at scan time are validated against LSP/structural facts: a member name the model invents that does not exist in the code is dropped, never enters the architecture.

## Example

```markdown
# 项目规则

- 永远使用中文回复（包括架构节点职责、意图描述）。
- 组件放在 src/features/<domain> 下，禁止跨 domain 引用内部实现。
- 数据访问一律通过 repository 层，组件不得直接查询数据库。
- 每个新函数都要有 JSDoc；导出函数必须有单元测试。
- 提交信息使用 Conventional Commits。
```

Put shared personal preferences (language, response style) in the **global** file and repository-specific conventions in the **project** file, so the project file stays useful for teammates.

## What the rules can and cannot do

- ✅ Output language, naming, code style, layering constraints, test expectations, response tone.
- ✅ Domain knowledge the model should respect when writing responsibilities and intents.
- ⛔ They do not widen the file whitelist — scope is enforced by the approved architecture, not by prompts.
- ⛔ They cannot bypass the approval gate: implementation still waits for your review.

See also [Overview](overview.md) for how the gate works, and [Getting started](getting-started.md) for your first approved change.
