// Guards on the build output and the package manifest: the artifact must be
// plain ESM that Node can parse, with no Bun-only APIs left in it.
import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { isFfiEligible } from "../src/runtime.ts"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))

const artifacts = {
  entry: join(root, "dist", "index.js"),
  launcher: join(root, "dist", "cli.js"),
}

const sources = [
  join(root, "index.ts"),
  join(root, "cli.ts"),
  join(root, "src", "app.ts"),
  join(root, "src", "ports.ts"),
  join(root, "src", "runtime.ts"),
]

// Bun-only entry points and globals. `globalThis.Bun` (the launcher's runtime
// probe) is intentionally allowed and checked separately below.
const BUN_ONLY =
  /from\s+["']bun:|require\(\s*["']bun:|import\(\s*["']bun:|Bun\.(?:spawn|spawnSync|write|file|serve|build|env|argv|version|sleep|which|stdin|stdout|stderr|hash|gzip|listen|connect|nanoseconds)\b/

const read = (p: string) => readFileSync(p, "utf8")

// POSIX permission bits don't exist on Windows; npm sets the exec bit on install.
const skipModes = process.platform === "win32" ? "file modes are POSIX-only" : false

test("dist artifacts exist and are executable", { skip: skipModes }, () => {
  for (const [name, path] of Object.entries(artifacts)) {
    assert.ok(existsSync(path), `${name} missing — run \`bun run build\``)
    const mode = statSync(path).mode & 0o777
    assert.equal(mode, 0o755, `${name} should be executable, got 0o${mode.toString(8)}`)
  }
})

test("dist artifacts exist", () => {
  for (const [name, path] of Object.entries(artifacts)) {
    assert.ok(existsSync(path), `${name} missing — run \`bun run build\``)
  }
})

test("dist artifacts start with a node shebang", () => {
  for (const path of Object.values(artifacts)) {
    assert.match(read(path).split("\n")[0], /^#!\/usr\/bin\/env node$/)
  }
})

test("dist artifacts parse as ESM under node --check", () => {
  for (const path of Object.values(artifacts)) {
    const result = spawnSync(process.execPath, ["--check", path], { encoding: "utf8" })
    assert.equal(result.status, 0, `${path}: ${result.stderr}`)
  }
})

test("dist artifacts contain no Bun-only APIs", () => {
  for (const path of Object.values(artifacts)) {
    const code = read(path)
    assert.doesNotMatch(code, BUN_ONLY, `${path} still references Bun`)
    assert.doesNotMatch(code, /["']bun:[a-z]+["']/, `${path} still imports a bun: module`)
  }
})

test("@opentui/core stays an external dependency of the entry bundle", () => {
  const code = read(artifacts.entry)
  assert.match(code, /from\s+["']@opentui\/core["']/, "entry should import @opentui/core")
  assert.doesNotMatch(code, /class CliRenderer/, "the native core must not be bundled in")
})

test("the launcher keeps a runtime import of ./index.js instead of inlining the TUI", () => {
  const code = read(artifacts.launcher)
  assert.match(code, /new URL\(["']\.\/index\.js["'],\s*import\.meta\.url\)/)
  assert.doesNotMatch(code, /SelectRenderable|createCliRenderer/, "the TUI must not be inlined")
})

test("package.json points bin/main at the built files", () => {
  assert.equal(pkg.type, "module")
  assert.equal(pkg.bin?.portctl, "dist/cli.js")
  assert.equal(pkg.main, "dist/index.js")
  assert.ok(pkg.files?.includes("dist"), "dist must be published")
  assert.ok(existsSync(join(root, pkg.bin.portctl)))
  assert.ok(existsSync(join(root, pkg.main)))
})

test("package.json declares the Node version the launcher requires", () => {
  assert.ok(pkg.engines?.node, "engines.node is missing — npm won't warn on old Node")
  const floor = pkg.engines.node.match(/(\d+)\.(\d+)/)
  assert.ok(floor, `unexpected engines.node: ${pkg.engines.node}`)
  const [major, minor] = [Number(floor[1]), Number(floor[2])]
  assert.equal(isFfiEligible(`${major}.${minor}.0`), true, "engines floor should be FFI-eligible")
  assert.equal(isFfiEligible(`${major}.${minor - 1}.0`), false, "engines floor should be the real floor")
})

test("source files are runtime-agnostic", () => {
  for (const path of sources) {
    assert.doesNotMatch(read(path), BUN_ONLY, `${path} uses a Bun-only API`)
  }
  // The one allowed Bun reference is the launcher's runtime probe.
  assert.match(read(join(root, "cli.ts")), /typeof \(globalThis as \{ Bun\?: unknown \}\)\.Bun/)
})

test("runtime dependencies are limited to @opentui/core", () => {
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}), ["@opentui/core"])
})
