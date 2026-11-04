// Smoke tests: the published artifact must boot, render, and shut down cleanly on
// plain Node. These run `dist/cli.js` exactly as `npx @ashhitch/portctl` would.
//
// Input over a pipe is unreliable (OpenTUI's key parser expects a terminal), so
// interactive behaviour is covered by test/app.test.ts via the test renderer.
// Here we only assert the real process boots, paints, and (on Unix) exits 0.
import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { runCli, sendUntilExit, sleep, spawnCli, tail } from "./helpers/cli.ts"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const cliPath = join(root, "dist", "cli.js")

if (!existsSync(cliPath)) {
  throw new Error(`missing ${cliPath} — run \`bun run build\` before the test suite`)
}

const CRASHES = /TextBuffer is destroyed|Argument 4 must be a uint32|UnhandledPromiseRejection/
const CTRL_C = "\u0003"
// Windows consoles deliver Ctrl-C as a console control event rather than a byte
// on stdin, so it can't be simulated over a pipe.
const skipCtrlC = process.platform === "win32" ? "Ctrl-C can't be piped on Windows" : false

test("boots and renders the port list", async () => {
  const cli = spawnCli(cliPath)
  try {
    await cli.waitFor("listening on")
    assert.doesNotMatch(cli.output(), CRASHES)
  } finally {
    await cli.dispose()
  }
})

test("boots when node:ffi starts out unavailable (launcher re-exec path)", async () => {
  // `--no-experimental-ffi` makes node:ffi unavailable, forcing the launcher to
  // re-exec itself with the flag — the path every plain-Node user takes.
  const cli = spawnCli(cliPath, { nodeArgs: ["--no-experimental-ffi"] })
  try {
    await cli.waitFor("listening on")
    assert.doesNotMatch(cli.output(), CRASHES)
  } finally {
    await cli.dispose()
  }
})

test("exits cleanly on Ctrl-C", { skip: skipCtrlC }, async () => {
  const result = await runCli(cliPath, { waitFor: "listening on", input: CTRL_C })
  assert.equal(result.code, 0, tail(result.output))
  assert.doesNotMatch(result.output, CRASHES)
})

test("Ctrl-C while the initial refresh is in flight exits cleanly", { skip: skipCtrlC }, async () => {
  // Regression: an in-flight refresh used to write to a destroyed TextBuffer and
  // crash with "TextBuffer is destroyed" (exit code 1).
  const result = await runCli(cliPath, { waitFor: "Refreshing", input: CTRL_C })
  assert.equal(result.code, 0, tail(result.output))
  assert.doesNotMatch(result.output, CRASHES)
})

test("manual refresh with `r` does not crash", { skip: skipCtrlC }, async () => {
  const cli = spawnCli(cliPath)
  try {
    await cli.waitFor("listening on")
    cli.write("r")
    await sleep(750)
    const exit = await sendUntilExit(cli, CTRL_C)
    assert.equal(exit.code, 0, tail(cli.output()))
    assert.doesNotMatch(cli.output(), CRASHES)
  } finally {
    await cli.dispose()
  }
})
