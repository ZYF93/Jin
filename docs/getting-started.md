# Getting started

A short path from "install Jin" to "your first approved, implemented, and verified change."

## 1. Install and open a project

Download the installer for your OS from [GitHub Releases](https://github.com/ZYF93/Jin/releases), then open Jin and pick **Open project** (or **New project**). You can explore the built-in demo before pointing at a real repository.

When you open a Git repository for the first time, Jin creates the project files and scans the source tree:

```text
.jin/config.yaml    # project name, scan roots, ignore rules, UI defaults
.jin/wal.jsonl      # approved architecture history (the ledger)
.jin/.gitignore     # keeps local cache out of Git
.jin/cache/         # local DB, LSP data, embeddings, temp files (ignored)
```

You can also bootstrap from the command line (idempotent — it never truncates an existing WAL):

```bash
pnpm run jin:init --name "sample-app" --languages typescript,react
```

## 2. Configure a provider

In **Settings → Provider**, choose a protocol, enter the endpoint and model, and provide a key where required. See [Providers & models](providers.md) for the full list, 2026 model presets, custom request headers, and an optional web-search endpoint.

Minimum examples:

```text
OpenAI-compatible
  Base URL:  https://api.openai.com/v1
  Model:     gpt-4.1
  API key:   your provider key

Ollama (local)
  Base URL:  http://localhost:11434
  Model:     qwen3:8b
```

Credentials are stored in the OS secure store when available. If the model refresh does not find your model, type its exact ID into the model field.

## 3. Understand the architecture

Open the **architecture canvas** (or the intent panel). Jin shows L0 modules, L1 files/components, and facets, plus LSP symbols and diagnostics where a language server is available. This ledger is the "single source of truth" that later bounds every implementation.

> Tip: if you care about symbol-level context and diagnostics for a language, install its LSP server. Scanning still works without one, but symbol facts are reduced for that language.

## 4. Ask for a change and approve it

In the chat, describe the behavior and constraints you want — not an unbounded "clean up the project":

> Add server-side pagination to the project list. Keep the current filters when changing pages, show loading and empty states, and add tests for the page controls. Do not change the project API response format.

Jin turns this into an **intent** and a **proposed architecture change**: the affected modules/symbols, the impact surface, and natural-language acceptance criteria. **Review this proposal — not a diff.** If it points at the wrong part of the architecture, refine the request before approving.

## 5. Implementation runs, then verifies itself

After you approve:

1. Implementation is staged in an isolated workspace, restricted to the approved files.
2. Jin runs your project's **test / typecheck / lint** scripts. If any fail, the failing output is fed back for **one self-repair pass**, then re-run.
3. Jin rescans and checks that the **approved architecture actually materialized** (conformance).
4. A **Git checkpoint** was taken before the edits; the result is recorded as a WAL version.

## 6. Review and commit

Review the implementation result and the architecture check. When you want teammates to share the approved architecture history, commit `.jin/wal.jsonl` alongside the code. The Git merge driver keeps concurrent branches' ledger entries from clobbering each other.

### Undo

Each implementation turn created a checkpoint. If the change was wrong, use **Undo** in the chat to restore the working tree to the pre-implementation state — `HEAD` is not moved, so you can inspect, commit, or discard deliberately.

## What to do next

- [Overview: strengths & limits](overview.md)
- [Providers & models](providers.md)
- [WAL format](wal.md)
