// Integration tests for the published launcher (`dist/cli.js`).
// A stub index.js sits next to a copy of the launcher, so the launcher's real
// re-exec behaviour is observable without booting the TUI.
import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const cliPath = join(root, "dist", "cli.js")

if (!existsSync(cliPath)) {
  throw new Error(`missing ${cliPath} — run \`bun run build\` before the test suite`)
}

const STUB_ENTRY = `console.log(JSON.stringify({
  argv: process.argv.slice(2),
  execArgv: process.execArgv,
  retry: process.env.PORTCTL_FFI_RETRY ?? null,
}))`

function supportsNodeFlag(flag: string): boolean {
  return spawnSync(process.execPath, [flag, "--eval", "0"], { stdio: "ignore" }).status === 0
}

const nodeHasFfi = (() => {
  const probe = spawnSync(process.execPath, ["--input-type=module", "--eval", "import('node:ffi')"], {
    stdio: "ignore",
  })
  return probe.status === 0
})()

const allowFfiSupported = supportsNodeFlag("--allow-ffi")

interface Harness {
  dir: string
  run(opts?: { nodeArgs?: string[]; args?: string[]; env?: NodeJS.ProcessEnv }): {
    status: number | null
    signal: NodeJS.Signals | null
    stdout: string
    stderr: string
    error?: Error
  }
  cleanup(): void
}

function makeHarness(entrySource = STUB_ENTRY): Harness {
  const dir = mkdtempSync(join(tmpdir(), "portctl-launcher-"))
  copyFileSync(cliPath, join(dir, "cli.js"))
  writeFileSync(join(dir, "index.js"), entrySource)
  return {
    dir,
    run({ nodeArgs = [], args = [], env = {} } = {}) {
      const env2: NodeJS.ProcessEnv = { ...process.env }
      delete env2.PORTCTL_FFI_RETRY
      Object.assign(env2, env)
      const result = spawnSync(process.execPath, [...nodeArgs, "cli.js", ...args], {
        cwd: dir,
        env: env2,
        encoding: "utf8",
        timeout: 30_000,
      })
      return {
        status: result.status,
        signal: result.signal,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        error: result.error,
      }
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** Pull the stub's JSON payload out of stdout (warnings may share the stream). */
function payload(stdout: string): { argv: string[]; execArgv: string[]; retry: string | null } {
  const line = stdout
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith("{") && l.endsWith("}"))
  assert.ok(line, `no JSON payload in stdout:\n${stdout}`)
  return JSON.parse(line)
}

test("re-execs with --experimental-ffi when node:ffi is unavailable", (t) => {
  const h = makeHarness()
  t.after(() => h.cleanup())
  const result = h.run({ nodeArgs: ["--no-experimental-ffi"], args: ["--flag", "value"] })
  assert.equal(result.status, 0, result.stderr)
  const data = payload(result.stdout)
  assert.ok(data.execArgv.includes("--experimental-ffi"), `execArgv was ${data.execArgv.join(" ")}`)
  assert.equal(data.retry, "1", "re-exec must set the retry guard")
  assert.deepEqual(data.argv, ["--flag", "value"], "user args must be forwarded unchanged")
  if (allowFfiSupported) {
    assert.ok(data.execArgv.includes("--allow-ffi"), `execArgv was ${data.execArgv.join(" ")}`)
  } else {
    assert.ok(!data.execArgv.includes("--allow-ffi"), "must not pass a flag this Node rejects")
  }
})

test("fails with a readable message instead of looping when the flag doesn't help", (t) => {
  const h = makeHarness()
  t.after(() => h.cleanup())
  const result = h.run({ nodeArgs: ["--no-experimental-ffi"], env: { PORTCTL_FFI_RETRY: "1" } })
  assert.equal(result.error, undefined, "launcher must not hang")
  assert.equal(result.status, 1)
  assert.match(result.stderr, /needs the experimental `node:ffi` module/)
  assert.doesNotMatch(result.stdout, /\{.*\}/, "the entry point must not be loaded")
})

test("does not re-exec when node:ffi already works", { skip: !nodeHasFfi && "this Node build has no node:ffi" }, (t) => {
  const h = makeHarness()
  t.after(() => h.cleanup())
  const result = h.run()
  assert.equal(result.status, 0, result.stderr)
  const data = payload(result.stdout)
  assert.ok(!data.execArgv.includes("--experimental-ffi"), "should run directly, not re-exec")
  assert.equal(data.retry, null)
})

test("propagates signal termination from the re-exec'd child", { skip: process.platform === "win32" }, (t) => {
  const h = makeHarness(`process.kill(process.pid, "SIGTERM")`)
  t.after(() => h.cleanup())
  const result = h.run({ nodeArgs: ["--no-experimental-ffi"] })
  assert.equal(result.signal, "SIGTERM", `expected signal exit, got status ${result.status}`)
})
