// Launcher for the published CLI. `@opentui/core` loads its native Zig core via
// `node:ffi` on Node.js, which is experimental and gated behind the
// `--experimental-ffi` flag (Node.js 26.1+). Under Bun the flag is unneeded.
// When running on Node without the flag, re-exec ourselves with it (once) so
// `portctl` works out of the box after `npm i -g`.
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import {
  RETRY_ENV,
  UNSUPPORTED_RUNTIME_MESSAGE,
  buildReexecArgs,
  shouldReexec,
} from "./src/runtime.ts"

const hasBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined"

async function nodeFfiAvailable(): Promise<boolean> {
  try {
    await import("node:ffi")
    return true
  } catch {
    return false
  }
}

/** Does this Node build recognize the given CLI flag? Probed before using `--allow-ffi`. */
function supportsFlag(flag: string): boolean {
  const probe = spawnSync(process.execPath, [flag, "--eval", "0"], { stdio: "ignore" })
  return probe.status === 0
}

if (!hasBun) {
  const retried = process.env[RETRY_ENV] === "1"
  const ffiAvailable = await nodeFfiAvailable()

  if (
    shouldReexec({
      hasBun,
      ffiAvailable,
      execArgv: process.execArgv,
      retried,
      nodeVersion: process.versions.node,
    })
  ) {
    const result = spawnSync(
      process.execPath,
      buildReexecArgs(process.argv.slice(1), { allowFfi: supportsFlag("--allow-ffi") }),
      { stdio: "inherit", env: { ...process.env, [RETRY_ENV]: "1" } },
    )
    // Propagate signal termination (e.g. Ctrl-C) instead of flattening to exit 1.
    if (result.signal) process.kill(process.pid, result.signal)
    process.exit(result.status ?? 1)
  }

  if (!ffiAvailable) {
    console.error(UNSUPPORTED_RUNTIME_MESSAGE)
    process.exit(1)
  }
}

// Non-static specifier so the bundler leaves this as a runtime import. After
// `bun run build` a compiled `index.js` sits next to us in dist/; when run from
// source (`node cli.ts` or `bun cli.ts`) only `index.ts` exists, so fall back.
const builtEntry = new URL("./index.js", import.meta.url)
const entry = existsSync(fileURLToPath(builtEntry))
  ? builtEntry
  : new URL("./index.ts", import.meta.url)
await import(entry.href)
