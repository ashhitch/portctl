# portctl

A cross-platform terminal UI for listing TCP listening ports and killing the
processes that own them. Useful for quickly freeing up a port that's stuck
occupied by a runaway or background process.

Built with [`@opentui/core`](https://github.com/sst/opentui). Runs on
[Bun](https://bun.sh) **or** [Node.js](https://nodejs.org) 26.1+ with no other
dependencies.

## Features

- Lists all TCP `LISTEN` sockets with owning PID and process name
- Cross-platform: macOS, Linux, and Windows
- Sortable by port number
- Auto-refresh every 5 seconds, plus manual refresh on demand
- Inline `y/N` confirmation before killing — no accidental terminations
- IPv4, IPv6, and wildcard (`*`) addresses supported
- Alternate-screen TUI that restores your terminal on exit

## Requirements

- [Bun](https://bun.sh) **or** [Node.js](https://nodejs.org) 26.1+. When run
  under Node, the CLI automatically re-launches itself with Node's experimental
  `--experimental-ffi` flag (OpenTUI loads its native core through `node:ffi`).
- Platform-specific CLI tools available on `PATH`:
  - **macOS**: `lsof`
  - **Linux**: `ss` (preferred), falls back to `netstat`, then `lsof`
  - **Windows**: `netstat` and `tasklist`

> Some system-owned ports (e.g. ports < 1024) may not appear or may refuse to
> be killed without elevated privileges. Run with appropriate permissions if
> you need to manage those.

## Install

```bash
# from npm (works with either runtime)
npm install -g @ashhitch/portctl
# or run once without installing
npx @ashhitch/portctl
```

> Node users need Node 26.1+ (for the experimental `node:ffi` module); the CLI
> adds the required flag itself, so no extra setup. Alternatively install
> [Bun](https://bun.sh): `curl -fsSL https://bun.sh/install | bash`

For local development:

```bash
bun install
```

## Run

```bash
# via the installed binary
portctl

# from source
bun index.ts
# or
bun run start
```

## Controls

| Key            | Action                                  |
| -------------- | --------------------------------------- |
| `↑` / `↓`      | Move selection                          |
| `Enter`        | Prompt to kill the selected process     |
| `y` / `n`      | Confirm / cancel the kill prompt        |
| `r`            | Refresh the port list                   |
| `q`            | Quit                                    |
| `Ctrl`+`C`     | Quit                                    |

The list refreshes automatically every 5 seconds. Manual refresh with `r`
preserves your current selection when possible.

## How it works

`src/ports.ts` shells out to the platform's native networking tools via
`node:child_process` (runtime-agnostic — works on both Bun and Node), parses
their output into a common `PortEntry` shape, and exposes two functions:

- `listListeningPorts()` — returns TCP listeners sorted by port
- `killProcess(pid)` — sends `SIGTERM` (then `SIGKILL` on failure) on Unix, or
  runs `taskkill /F /PID` on Windows

`index.ts` renders the TUI using OpenTUI's imperative `Renderable` API. The
layout is a header (title + help), a scrollable `Select` of ports, and a footer
showing port count, last refresh time, and the active confirmation prompt.

## Project layout

```
portctl/
├── index.ts          # TUI: layout, key handling, refresh + kill flow
├── cli.ts            # Launcher: sets Node's --experimental-ffi flag when needed
├── src/
│   └── ports.ts      # Cross-platform port detection and process killing
├── package.json
└── bun.lock
```

## License

MIT
