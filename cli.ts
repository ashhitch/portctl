// Launcher for the published CLI. `@opentui/core` loads its native Zig core via
// `node:ffi` on Node.js, which is experimental and gated behind the
// `--experimental-ffi` flag (Node.js 26.1+). Under Bun the flag is unneeded.
// When running on Node without the flag, re-exec ourselves with it (once) so
// `portctl` works out of the box after `npm i -g`.
import { spawnSync } from "node:child_process"

const hasBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined"

async function nodeFfiAvailable(): Promise<boolean> {
  try {
    await import("node:ffi")
    return true
  } catch {
    return false
  }
}

if (!hasBun) {
  const hasFlag = process.execArgv.includes("--experimental-ffi")
  const retried = process.env.PORTCTL_FFI_RETRY === "1"
  const [major, minor] = process.versions.node.split(".").map(Number)
  // node:ffi landed in Node 26.1; don't re-exec with a flag older Node rejects.
  const ffiEligible = major > 26 || (major === 26 && minor >= 1)

  if (!(await nodeFfiAvailable())) {
    if (ffiEligible && !hasFlag && !retried) {
      const result = spawnSync(
        process.execPath,
        ["--experimental-ffi", "--disable-warning=ExperimentalWarning", ...process.argv.slice(1)],
        { stdio: "inherit", env: { ...process.env, PORTCTL_FFI_RETRY: "1" } },
      )
      process.exit(result.status ?? 1)
    }
    console.error(
      "portctl needs the experimental `node:ffi` module (Node.js 26.1+ with FFI support) or Bun.\n" +
        "This Node.js build does not expose `node:ffi`; install a newer Node.js or Bun and try again.",
    )
    process.exit(1)
  }
}

// Non-static specifier so the bundler leaves this as a runtime import.
await import(new URL("./index.js", import.meta.url).href)
