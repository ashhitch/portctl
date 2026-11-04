// Headless tests for the TUI, driven through OpenTUI's test renderer.
// These run on plain Node and cover what a piped stdout can't: list contents,
// key handling, and the kill-confirmation flow.
import { test, type TestContext } from "node:test"
import assert from "node:assert/strict"
import { createTestRenderer, KeyCodes } from "@opentui/core/testing"
import type { PortEntry } from "../src/ports.ts"
import { mount, nowStamp, type AppDeps } from "../src/app.ts"

const entry = (port: number, pid: number, processName = "node"): PortEntry => ({
  port,
  protocol: "tcp",
  pid,
  processName,
  address: "*",
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function setup(ctx: TestContext, deps: AppDeps = {}, size = { width: 80, height: 24 }) {
  const harness = await createTestRenderer(size)
  const app = mount(harness.renderer, deps)
  ctx.after(async () => {
    if (!harness.renderer.isDestroyed) harness.renderer.destroy()
    await sleep(0)
  })
  return { ...harness, app }
}

test("renders the title, help line, and discovered ports", async (ctx) => {
  const h = await setup(ctx, { listPorts: async () => [entry(3000, 4242), entry(5432, 99, "postgres")] })
  const frame = await h.waitForFrame((f) => f.includes("5432"))
  assert.match(frame, /portctl/)
  assert.match(frame, /Enter kill/)
  assert.match(frame, /3000/)
  assert.match(frame, /4242/)
  assert.match(frame, /postgres/)
  assert.match(frame, /2 listening ports/)
  assert.match(frame, /listening on \*:3000/)
})

test("shows an empty state when nothing is listening", async (ctx) => {
  const h = await setup(ctx, { listPorts: async () => [] })
  const frame = await h.waitForFrame((f) => f.includes("No listening ports found"))
  assert.match(frame, /0 listening ports/)
})

test("Enter opens the kill prompt and n cancels it", async (ctx) => {
  const h = await setup(ctx, { listPorts: async () => [entry(3000, 4242)] })
  await h.waitForFrame((f) => f.includes("3000"))
  h.mockInput.pressKey(KeyCodes.RETURN)
  const prompt = await h.waitForFrame((f) => f.includes("Kill PID"))
  assert.match(prompt, /Kill PID 4242 \(node on :3000\)\? \[y\/N\]/)
  assert.equal(h.app.state.confirmPid, 4242)
  h.mockInput.pressKey("n")
  const frame = await h.waitForFrame((f) => !f.includes("Kill PID"))
  assert.equal(h.app.state.confirmPid, null)
  assert.doesNotMatch(frame, /Kill PID/)
})

test("Escape also cancels the kill prompt", async (ctx) => {
  const h = await setup(ctx, { listPorts: async () => [entry(3000, 4242)] })
  await h.waitForFrame((f) => f.includes("3000"))
  h.mockInput.pressKey(KeyCodes.RETURN)
  await h.waitForFrame((f) => f.includes("Kill PID"))
  h.mockInput.pressEscape()
  // A lone ESC is ambiguous with the start of a sequence; the parser flushes it
  // to `escape` after its timeout.
  await sleep(120)
  await h.waitForFrame((f) => !f.includes("Kill PID"))
  assert.equal(h.app.state.confirmPid, null)
})

test("y kills the selected PID and re-refreshes", async (ctx) => {
  const killed: number[] = []
  let listCalls = 0
  const h = await setup(ctx, {
    listPorts: async () => {
      listCalls++
      return [entry(3000, 4242)]
    },
    kill: async (pid) => {
      killed.push(pid)
      return { ok: true }
    },
  })
  await h.waitForFrame((f) => f.includes("3000"))
  h.mockInput.pressKey(KeyCodes.RETURN)
  await h.waitForFrame((f) => f.includes("Kill PID"))
  h.mockInput.pressKey("y")
  const frame = await h.waitForFrame((f) => f.includes("Killed PID 4242"))
  assert.deepEqual(killed, [4242])
  assert.match(frame, /Killed PID 4242 \(node on :3000\)/)
  // The post-kill refresh is delayed by 400ms on a real timer.
  await sleep(700)
  assert.ok(listCalls >= 2, `expected a refresh after the kill, saw ${listCalls} list calls`)
})

test("a failed kill is reported on the status line", async (ctx) => {
  const h = await setup(ctx, {
    listPorts: async () => [entry(3000, 4242)],
    kill: async () => ({ ok: false, error: "Permission denied" }),
  })
  await h.waitForFrame((f) => f.includes("3000"))
  h.mockInput.pressKey(KeyCodes.RETURN)
  await h.waitForFrame((f) => f.includes("Kill PID"))
  h.mockInput.pressKey("y")
  assert.match(
    await h.waitForFrame((f) => f.includes("Failed to kill")),
    /Failed to kill PID 4242: Permission denied/,
  )
})

test("arrow keys move the selection before confirming", async (ctx) => {
  const h = await setup(ctx, { listPorts: async () => [entry(3000, 111), entry(5432, 222)] })
  await h.waitForFrame((f) => f.includes("5432"))
  h.mockInput.pressArrow("down")
  await h.flush()
  h.mockInput.pressKey(KeyCodes.RETURN)
  assert.match(await h.waitForFrame((f) => f.includes("Kill PID")), /Kill PID 222/)
})

test("r triggers a refresh", async (ctx) => {
  let calls = 0
  const h = await setup(ctx, {
    listPorts: async () => {
      calls++
      return [entry(3000, 4242)]
    },
  })
  await h.waitForFrame((f) => f.includes("3000"))
  assert.equal(calls, 1)
  h.mockInput.pressKey("r")
  await sleep(50)
  assert.equal(calls, 2)
})

test("refresh failures are reported instead of crashing", async (ctx) => {
  const h = await setup(ctx, { listPorts: async () => Promise.reject(new Error("lsof exploded")) })
  assert.match(await h.waitForFrame((f) => f.includes("Refresh failed")), /Refresh failed: lsof exploded/)
})

test("auto-refresh polls on the configured interval and stops on destroy", async (ctx) => {
  let calls = 0
  const h = await setup(ctx, {
    refreshMs: 20,
    listPorts: async () => {
      calls++
      return []
    },
  })
  await h.waitForFrame((f) => f.includes("No listening ports found"))
  await sleep(150)
  assert.ok(calls >= 3, `expected repeated refreshes, saw ${calls}`)
  h.app.destroy()
  const afterDestroy = calls
  await sleep(80)
  assert.equal(calls, afterDestroy, "timer kept polling after destroy")
})

test("q destroys the renderer", async (ctx) => {
  const h = await setup(ctx, { listPorts: async () => [] })
  await h.waitForFrame((f) => f.includes("No listening ports found"))
  h.mockInput.pressKey("q")
  await sleep(20)
  assert.equal(h.renderer.isDestroyed, true)
})

test("a refresh resolving after destroy does not throw", async (ctx) => {
  // Regression: this used to crash with "TextBuffer is destroyed" on quit.
  const rejections: unknown[] = []
  const onRejection = (e: unknown) => rejections.push(e)
  process.on("unhandledRejection", onRejection)
  try {
    let resolvePorts!: (ports: PortEntry[]) => void
    const h = await setup(ctx, {
      listPorts: () => new Promise<PortEntry[]>((resolve) => (resolvePorts = resolve)),
    })
    await h.flush()
    h.app.destroy()
    resolvePorts([entry(3000, 4242)])
    await sleep(20)
    assert.deepEqual(rejections, [])
    assert.deepEqual(h.app.state.ports, [])
  } finally {
    process.off("unhandledRejection", onRejection)
  }
})

test("nowStamp formats as HH:MM:SS", () => {
  assert.equal(nowStamp(new Date(2026, 0, 2, 3, 4, 5)), "03:04:05")
})
