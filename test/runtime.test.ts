// Unit tests for the launcher's decision logic (src/runtime.ts).
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  ALLOW_FFI_FLAG,
  FFI_FLAG,
  QUIET_WARNING_FLAG,
  UNSUPPORTED_RUNTIME_MESSAGE,
  buildReexecArgs,
  hasFfiFlag,
  isFfiEligible,
  shouldReexec,
} from "../src/runtime.ts"

const base = {
  hasBun: false,
  ffiAvailable: false,
  execArgv: [] as string[],
  retried: false,
  nodeVersion: "26.13.0",
}

test("isFfiEligible accepts Node 26.1 and newer", () => {
  assert.equal(isFfiEligible("26.1.0"), true)
  assert.equal(isFfiEligible("26.1.5"), true)
  assert.equal(isFfiEligible("26.13.0"), true)
  assert.equal(isFfiEligible("27.0.0"), true)
  assert.equal(isFfiEligible("30.2.1"), true)
})

test("isFfiEligible rejects Node older than 26.1 and junk versions", () => {
  assert.equal(isFfiEligible("26.0.0"), false)
  assert.equal(isFfiEligible("25.9.9"), false)
  assert.equal(isFfiEligible("24.9.0"), false)
  assert.equal(isFfiEligible("20.11.1"), false)
  assert.equal(isFfiEligible("not-a-version"), false)
})

test("hasFfiFlag only matches the exact flag", () => {
  assert.equal(hasFfiFlag([FFI_FLAG]), true)
  assert.equal(hasFfiFlag(["--experimental-ffi=1"]), false)
  assert.equal(hasFfiFlag([]), false)
})

test("buildReexecArgs adds the flags before the original argv", () => {
  assert.deepEqual(buildReexecArgs(["script.js", "--foo"], { allowFfi: false }), [
    FFI_FLAG,
    QUIET_WARNING_FLAG,
    "script.js",
    "--foo",
  ])
  assert.deepEqual(buildReexecArgs(["script.js"], { allowFfi: true }), [
    FFI_FLAG,
    ALLOW_FFI_FLAG,
    QUIET_WARNING_FLAG,
    "script.js",
  ])
})

test("shouldReexec re-execs a plain Node 26.1+ run without node:ffi", () => {
  assert.equal(shouldReexec(base), true)
})

test("shouldReexec never runs under Bun", () => {
  assert.equal(shouldReexec({ ...base, hasBun: true }), false)
})

test("shouldReexec skips when node:ffi already works", () => {
  assert.equal(shouldReexec({ ...base, ffiAvailable: true }), false)
})

test("shouldReexec skips when the flag is already set", () => {
  assert.equal(shouldReexec({ ...base, execArgv: [FFI_FLAG] }), false)
})

test("shouldReexec skips when it has already retried (no loops)", () => {
  assert.equal(shouldReexec({ ...base, retried: true }), false)
})

test("shouldReexec skips on Node builds that predate node:ffi", () => {
  assert.equal(shouldReexec({ ...base, nodeVersion: "24.9.0" }), false)
})

test("the unsupported-runtime message tells the user what to install", () => {
  assert.match(UNSUPPORTED_RUNTIME_MESSAGE, /node:ffi/)
  assert.match(UNSUPPORTED_RUNTIME_MESSAGE, /26\.1\+/)
  assert.match(UNSUPPORTED_RUNTIME_MESSAGE, /Bun/)
})
