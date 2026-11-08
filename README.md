# Jin

[简体中文](README.zh-CN.md)

**An architecture-first coding agent for desktop.** Jin turns a coding request into a reviewable architecture change, records approved decisions in a Git-friendly project ledger, then implements the change and checks the result against the architecture.

[![Latest release](https://img.shields.io/github/v/release/ZYF93/Jin)](https://github.com/ZYF93/Jin/releases)
[![Build and release](https://github.com/ZYF93/Jin/actions/workflows/release.yml/badge.svg)](https://github.com/ZYF93/Jin/actions/workflows/release.yml)

## What Jin does

- Scans a project into an architecture map with **L0 modules** and **L1 files or components**. LSP servers add symbol facts and source navigation where available.
- Creates an intent for a request, including the responsibilities of the affected architecture nodes.
- Shows the proposed architecture changes for review. Approval is required before implementation starts.
- Searches existing code for reuse before writing, then rescans and reports architecture drift after implementation.
- Keeps the shared architecture history in `.jin/wal.jsonl`, so it can be reviewed and merged with normal Git workflows.
- Connects to OpenAI-compatible APIs or Ollama. Model lists can be refreshed from the provider, and a custom model ID can be entered if it is not listed.
- Includes Git branch switching, change staging, commits, history, and remote operations in the desktop app.

## Install

Download the installer for your operating system from [GitHub Releases](https://github.com/ZYF93/Jin/releases).

| Platform | Release files |
| --- | --- |
| Windows | `Jin-Windows-<version>-Setup.exe` |
| macOS | `Jin-Mac-<version>-Installer.dmg` or `.zip` |
| Linux | `Jin-Linux-<version>.AppImage` or `.deb` |

The macOS release includes both a disk image and a ZIP archive. Packaged builds check GitHub Releases for updates by default; the Settings panel can override this with a generic update feed.

## First run

1. Open Jin and choose **Open project** or **New project**. You can also explore the built-in demo before opening a repository.
2. In **Settings → Provider**, choose OpenAI-compatible or Ollama, enter the endpoint, and provide a model. Refresh the model list or type a model ID directly.
3. Open a Git repository. Jin creates `.jin/config.yaml`, `.jin/.gitignore`, and `.jin/wal.jsonl` for an uninitialized project, then scans the source tree.
4. Describe a change in the chat. Review the intent and architecture diff; approve it to start implementation.
5. Review the implementation result and architecture check. Commit `.jin/wal.jsonl` with the code when you want teammates to share the approved architecture history.

### Provider examples

For an OpenAI-compatible service, use the API base URL and a key from your provider:

```text
Provider:   OpenAI-compatible
Base URL:   https://api.openai.com/v1
Model:      gpt-4.1
API key:    your provider key
```

For a local Ollama server, start Ollama first and use its local endpoint. No API key is required for a default local setup:

```text
Provider:   Ollama
Base URL:   http://localhost:11434
Model:      qwen3:8b
```

Provider endpoints and available models differ. If refresh cannot discover a model, enter its exact ID in the model field. Jin stores provider credentials using the operating system's secure storage when available.

### Example request

Instead of asking for an unbounded “clean up the project,” describe the behavior and constraints you want:

> Add server-side pagination to the project list. Keep the current filters when changing pages, show loading and empty states, and add tests for the page controls. Do not change the project API response format.

Jin should turn this into an intent and a proposed architecture change. Review the affected nodes, their responsibilities, and any risks before approving. If the proposal points at the wrong part of the architecture, refine the request before approval.

## Project files

Jin keeps project-level, team-shareable data in `.jin/` and local caches in the ignored cache directory:

```text
.jin/
  config.yaml       # project name, scan roots, ignore rules, and UI defaults
  wal.jsonl         # approved architecture decisions and version history
  .gitignore        # excludes local cache data
  cache/            # local database, LSP data, embeddings, and temporary files
```

Example `.jin/config.yaml`:

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

You can initialize the current repository from the command line as well:

```bash
pnpm run jin:init --name "sample-app" --languages typescript,react
```

The initialization command is idempotent. It creates the project files if needed and does not truncate an existing WAL. Use `--help` to see the available options.

## Build from source

Requirements: Node.js 24 and pnpm 12.15.0 (the repository pins the pnpm version).

```bash
pnpm install --frozen-lockfile
pnpm dev
```

Useful project commands:

```bash
pnpm typecheck
pnpm lint
pnpm test --run
pnpm build:app          # compile the renderer and Electron main/preload bundles
pnpm pack:dir           # create an unpacked desktop app for the current platform
pnpm dist               # create the platform installer(s)
```

LSP-based symbol discovery depends on language servers installed on the user's machine. The architecture scan still works without an LSP server, but symbol-level navigation and diagnostics will be limited for that language.

## Releases

Push a semantic version tag such as `v1.2.3` to publish installers for Windows, macOS, and Linux:

```bash
git tag v1.2.3
git push origin v1.2.3
```

The release workflow validates the tag, runs typecheck/lint/tests, builds and smoke-tests the desktop app on all three operating systems, then attaches installers and updater metadata to the matching GitHub Release with generated release notes. The workflow uses the repository's `GITHUB_TOKEN`; no personal access token is required. Code signing and notarization credentials are not configured by default.

## License

See [LICENSE](LICENSE).
