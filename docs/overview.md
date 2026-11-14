# Overview: strengths, limits, and how Jin differs

Jin is a desktop coding agent whose defining choice is **architecture-first**: before any code is written, it produces a reviewable *architecture change proposal* and waits for approval. This document states what that buys you, where it does not, and how that compares to Codex, OpenCode, and Claude Code.

## The core workflow

```
scan codebase → build an architecture ledger (L0 modules / L1 files / facets)
   ↓
you ask for a change → the model proposes an architecture change
   ↓
【human reviews & approves the proposal】   ← the gate
   ↓
implementation is allowed only inside the approved file whitelist
   ↓
auto test / typecheck / lint → failures are fed back for one self-repair pass
   ↓
architecture conformance check + a versioned WAL entry (with a Git checkpoint)
```

Everything after the gate is bounded and verifiable; everything before it is *intent*, which is what you actually need to review.

## What architecture-first buys you

- **You review intent, not code.** The proposal says which L1 modules/symbols are touched, the impact surface, and natural-language acceptance criteria. For a lead or architect, judging "is it right to add `resetAll` and affect a.ts/b.ts" is far faster than reading 800 lines of diff.
- **It cannot drift out of scope.** Each edit must land in an approved path; a helper file the model "thought was handy" is rejected by the tool layer.
- **Context is symbol-narrowed.** Implementation pulls only the relevant LSP symbols (±~40 lines) plus pre-existing diagnostics in the target files, instead of the whole repository. Less token, less accidental "drive-by" edits, and it even fixes known issues along the way.
- **Correctness is auto-checked.** After writing, Jin runs your project's own test / typecheck / lint scripts and feeds failures back for one bounded self-repair pass, then rescans and verifies the approved architecture actually materialized.
- **It is reversible.** Every turn is a WAL version with a Git checkpoint; undo restores the working tree without moving `HEAD`.

## How it compares

| | Core idea | Strong at | Where Jin differs |
| --- | --- | --- | --- |
| **Codex** | Sandboxed execution + approval policy | Security sandboxing, network policy, stable patch application | Codex gates *tool execution*; Jin gates *intent* first, then constrains edits to the approved scope |
| **OpenCode** | Broad providers, full toolset, session management | Feature breadth: glob/grep/todo/webfetch/diagnostics, share/undo/compact | OpenCode gives the model more tools; Jin gives it *fewer, narrower* inputs and an intent gate up front |
| **Claude Code** | Strong model + hooks/subagents | Long-context agentic work, extensibility | Same "write first" model; Jin adds the architecture gate and a built-in verify+repair loop |
| **Jin** | **Architecture gate first** | Reviewable change, bounded edits, self-repair, versioned undo | Acceptance moved up to the intent layer |

The short version: Codex/OpenCode/Claude Code answer *"can it do the work?"*; Jin answers *"can I trust it on real production code?"* by moving acceptance before the work.

## Where Jin does not fit

- **One-off scripts, demos, quick prototypes.** The ledger + proposal overhead is not worth it; use a direct coding agent instead.
- **If you refuse to review a proposal**, the core value disappears — the gate is the point.
- **Very messy legacy monoliths.** The architecture ledger is only as good as the scan; if L0/L1 boundaries come out wrong, review the scan first.
- **You must be willing to run a local LSP** for the languages you care about. Without an LSP server, symbol-level context and diagnostics are reduced (scanning still works).

## Design values, briefly

- **Determinism where it counts.** The ledger, scope whitelist, and conformance check make "did it do what was approved?" answerable, not vibes.
- **The model is a bounded tool, not an open actor.** It can read, stage edits within scope, and run checks — not rewrite the world.
- **Trust the loop, not a single shot.** Writing is just one step; checks + repair + conformance are what make a change trustworthy.

For setup and the first approved change, see [Getting started](getting-started.md). For the ledger file format, see [WAL](wal.md). For model/provider configuration, see [Providers & models](providers.md).
