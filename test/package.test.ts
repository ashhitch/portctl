// Verifies what actually ships to npm: `npm pack --dry-run` must contain the
// built CLI (executable), and nothing else that shouldn't be published.
import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")

interface PackFile {
  path: string
  size: number
  mode: number
}

function packFiles(): PackFile[] {
  const result = spawnSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: root,
    encoding: "utf8",
    // npm is npm.cmd on Windows, which needs a shell to be executable.
    shell: process.platform === "win32",
  })
  assert.equal(result.status, 0, `npm pack failed:\n${result.stderr}`)
  const [manifest] = JSON.parse(result.stdout)
  return manifest.files as PackFile[]
}

const files = packFiles()
const paths = files.map((f) => f.path)

// POSIX permission bits don't exist on Windows; npm sets the exec bit on install.
const skipModes = process.platform === "win32" ? "file modes are POSIX-only" : false

test("publishes the built launcher, entry, manifest, and README", () => {
  for (const required of ["package.json", "README.md", "dist/cli.js", "dist/index.js"]) {
    assert.ok(paths.includes(required), `${required} is missing from the tarball (got ${paths.join(", ")})`)
  }
})

test("publishes dist files as executable", { skip: skipModes }, () => {
  for (const path of ["dist/cli.js", "dist/index.js"]) {
    const file = files.find((f) => f.path === path)
    assert.ok(file, `${path} missing`)
    assert.equal(file.mode & 0o777, 0o755, `${path} would not be executable after install`)
  }
})

test("does not publish sources, tests, CI config, or node_modules", () => {
  const leaked = paths.filter(
    (p) =>
      p.startsWith("node_modules/") ||
      p.startsWith("src/") ||
      p.startsWith("test/") ||
      p.startsWith(".github/") ||
      p.startsWith(".agents/") ||
      p === "cli.ts" ||
      p === "index.ts" ||
      p === "tsconfig.json" ||
      p.endsWith(".tgz"),
  )
  assert.deepEqual(leaked, [])
})

test("tarball is small (no accidental bloat)", () => {
  const total = files.reduce((sum, f) => sum + f.size, 0)
  assert.ok(total < 200_000, `unpacked tarball is ${total} bytes`)
})
