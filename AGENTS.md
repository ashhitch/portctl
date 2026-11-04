# AGENTS.md

## Commands

```bash
bun install            # deps (Bun is the package manager)
bun run build          # bundles index.ts -> dist/index.js and cli.ts -> dist/cli.js
npm test               # build + node --test test/   (the suite runs on plain Node)
npm run test:node      # tests only — requires dist/ to exist
npm run typecheck      # tsc --noEmit
```

`dist/` is gitignored, so the test suite always needs a build first (`npm test`
does it for you).

## Layout

- `index.ts` — entry; creates the renderer and calls `mount()`.
- `src/app.ts` — all TUI state, layout, key handling, refresh/kill flow. Exported
  as `mount(renderer, deps)` so it can be driven by `@opentui/core/testing`.
- `src/ports.ts` — platform backends (lsof / ss / netstat / tasklist) and
  `killProcess`. Parsers are exported and `listListeningPorts`/`killProcess`
  accept injected `run`/`kill`/`runProcess` for tests.
- `src/runtime.ts` — launcher decisions (FFI eligibility, re-exec args).
- `cli.ts` — published `bin`; re-execs Node with `--experimental-ffi` when needed.

## Conventions & gotchas

- **Internal imports use explicit `.ts` extensions** (`./src/app.ts`). Node runs
  the sources directly via type stripping, and extensionless imports do not
  resolve under Node ESM. `tsconfig` has `allowImportingTsExtensions`.
- **Tests must pass under `node --test`, not just Bun.** Run them with plain
  `node`; Bun tolerates things Node does not.
- **Never use fractional layout values.** `itemSpacing: 0.5` on a
  `SelectRenderable` renders fine under Bun but throws
  `Argument 4 must be a uint32` from `node:ffi` on Node once the list has 2+
  rows.
- **Guard every render after `await`** with `renderer.isDestroyed`
  (`src/app.ts`). In-flight refreshes/kills resolve after `q`/Ctrl-C and writing
  to a destroyed renderable throws `TextBuffer is destroyed`.
- **Prefer headless TUI tests** (`createTestRenderer` + `mockInput` from
  `@opentui/core/testing`). Driving the real binary over a pipe is unreliable:
  OpenTUI's key parser expects a terminal, so keystrokes get dropped. The pipe
  tests in `test/boot.test.ts` only assert boot/render/exit.
- When a test spawns `dist/cli.js` with `--no-experimental-ffi`, the launcher
  re-execs a grandchild; kill the whole process group (see `killTree` in
  `test/helpers/cli.ts`) or the test runner hangs on the orphan.
- CI (`.github/workflows/test.yml`) builds with Bun but runs tests on Node 26
  across macOS/Linux/Windows. `engines.node` (`>=26.1.0`) is asserted against
  `isFfiEligible()` in `test/build.test.ts`.
