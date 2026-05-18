# Launch Bay

A local-first Electron cockpit for managing projects, dev servers, terminals, and AI coding agents.

Launch Bay talks to [Hermes Agent](https://github.com/cocktailpeanut/hermes-agent) over the native [Agent Client Protocol (ACP)](https://agentclientprotocol.com/) — the same protocol used by Zed and other editors. Each chat session is isolated, streams in real time, surfaces tool calls and diffs as they happen, and persists across restarts.

> Status: early, opinionated, single-developer project. Open-sourced as-is.

## What it does

- **Workspaces & servers**: register local project folders and the commands that run their dev servers; Start/Stop streams logs into an embedded panel.
- **Hermes chat per project**: scoped conversation per workspace, with streaming text, inline tool-call cards, file diffs from `write_file`/`patch`, and the agent's plan when it produces one.
- **Attachments**: paste an image, drag a file in, or `@mention` a project file to ship it as an ACP `ImageContentBlock` / `EmbeddedResourceContentBlock`.
- **Slash commands + skills**: `/` lists the agent's advertised commands and your installed Hermes skills, with arrow-key autocomplete.
- **Manual approval mode**: optional gate for tool calls — shows the kind, arguments, locations and any diff before you allow it.
- **Past sessions**: resume any past ACP session that lives in the Hermes SQLite store, filtered by current `cwd`.
- **Embedded terminals**: drop a `node-pty` terminal under each project, scoped to its working directory.
- **Branch manager**: GitLens-style fetch / switch / merge from inside the cockpit.

## Requirements

- macOS, Linux, or Windows. Shell detection auto-selects zsh/bash on Unix or PowerShell 7/cmd.exe on Windows (see `electron/platform.ts`).
- [pnpm](https://pnpm.io/) for installing dependencies.
- [Hermes Agent](https://github.com/cocktailpeanut/hermes-agent) installed and reachable on your `PATH`. The app resolves the binary through your login shell so any `pnpm`/`asdf`/`brew`/`scoop` install works.
- Git (for the branch manager and the `@`-mention picker that uses `git ls-files`).

### Platform notes

- **macOS** and **Linux**: zero extra config; the app picks `$SHELL`, then zsh/bash/sh in that order.
- **Windows**: PowerShell 7 is preferred when installed at `Program Files\PowerShell\7\pwsh.exe`; otherwise the app falls back to `cmd.exe`. `node-pty` requires Visual Studio Build Tools to install — prebuilt binaries cover most cases but if `pnpm install` fails on the native build, install [windows-build-tools](https://github.com/nodejs/node-gyp/blob/main/docs/Updating-npm-bundled-node-gyp.md) first.

## Setup

```bash
pnpm install
pnpm dev
```

`pnpm dev` rebuilds the Electron main/preload bundle, starts Vite, and opens the desktop window. The browser preview at `http://127.0.0.1:5173` renders the UI but cannot run local processes — use the Electron window.

To create a double-clickable macOS app without the Vite dev server:

```bash
pnpm package:mac
open "release/mac-arm64/Launch Bay.app"
```

On Intel Macs the app path is `release/mac/Launch Bay.app`. You can drag the generated app to `/Applications` if you want to launch it from Spotlight/Finder.

On first launch the sidebar is empty. Use **+ Open folder** to register a local project, then add servers and Hermes sessions from there.

## Validation

```bash
pnpm test         # vitest (renderer + electron-side)
pnpm typecheck    # tsc for both projects
pnpm build        # production renderer + electron bundle
```

## Project layout

```
electron/                    # Electron main + preload (TypeScript)
  hermes/                    # ACP client, session manager, persistence
  config/                    # local config store + directory inspection
  runtime/                   # project runtime + node-pty terminal
src/                         # React renderer (Vite)
  components/                # composer, sidebar, modals
```

The Electron main process owns the lifecycle of:

- `HermesAcpProcess` (one `hermes acp` subprocess, JSON-RPC over stdio, multiplexes N sessions),
- `HermesInstanceManager` (one ACP session per chat instance, persisted to `userData/hermes-sessions.json`),
- `ProjectRuntimeManager` (`spawn`s dev-server processes per workspace),
- `TerminalManager` (`node-pty` per embedded terminal),
- `LocalConfigStore` (workspaces + servers persisted to `userData/launch-bay.json`).

The renderer is sandboxed (`contextIsolation: true`, `nodeIntegration: false`) and talks to the main process exclusively through the typed bridge declared in `electron/preload.cjs` and `src/types.ts`.

## How the Hermes bridge works

Launch Bay does not call the Hermes HTTP gateway. Instead, it spawns `hermes acp` once per app run and speaks JSON-RPC over stdio:

1. On startup the main process resolves the `hermes` binary via the user's login shell so packaged builds find it.
2. On each new chat instance: `session/new` (or `session/load` for restored sessions) with the project `cwd`.
3. User messages → `session/prompt` with `TextContentBlock`/`ImageContentBlock`/`EmbeddedResourceContentBlock`.
4. The agent streams responses as `session/update` notifications (`agent_message_chunk`, `tool_call`, `tool_call_update`, `plan`, `usage_update`, `available_commands_update`).
5. Tool approvals come in as `session/request_permission` requests; in auto mode the bridge picks an `allow_once` option, in manual mode it surfaces a modal to the user.

When the Python process exits unexpectedly the bridge retries up to three times in a 60-second window, then re-attaches each known `sessionId` via `session/load` so the conversation continues.

## License

MIT. See [LICENSE](./LICENSE).

## Contributing

Issues and PRs welcome. There are some legacy renderer tests that need to be ported to the current sidebar/composer layout — that is a good entry point. Most of the active surface area is `electron/hermes/*` and `src/components/HermesChatView.tsx`.
