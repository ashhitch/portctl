// Shared helpers for spawning the built CLI and driving it over pipes.
// The TUI renders fine without a PTY, so plain pipes keep these tests
// cross-platform (no node-pty dependency).
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process"

export interface CliExit {
  code: number | null
  signal: NodeJS.Signals | null
}

export interface CliHandle {
  child: ChildProcessWithoutNullStreams
  /** Everything written to stdout + stderr so far (ANSI escapes included). */
  output(): string
  waitFor(pattern: string | RegExp, timeoutMs?: number): Promise<void>
  write(data: string): void
  /** Current exit info, or null while still running. */
  exited(): CliExit | null
  waitForExit(timeoutMs?: number): Promise<CliExit>
  dispose(): Promise<void>
}

export interface SpawnOptions {
  args?: string[]
  /** Extra args for node itself, e.g. `--no-experimental-ffi`. */
  nodeArgs?: string[]
  env?: NodeJS.ProcessEnv
  cwd?: string
}

const DEFAULT_TIMEOUT = 20_000

export function spawnCli(script: string, opts: SpawnOptions = {}): CliHandle {
  const child = spawn(process.execPath, [...(opts.nodeArgs ?? []), script, ...(opts.args ?? [])], {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdio: ["pipe", "pipe", "pipe"],
    // Make the CLI a process-group leader so we can tear down the launcher and
    // any re-exec'd child it spawned in one go.
    detached: process.platform !== "win32",
  })

  let output = ""
  const textWaiters = new Set<{
    re: RegExp
    resolve: () => void
    reject: (err: Error) => void
    timer: NodeJS.Timeout
  }>()
  const exitWaiters = new Set<(exit: CliExit) => void>()
  let exit: CliExit | null = null

  const toRegExp = (p: string | RegExp) => (typeof p === "string" ? new RegExp(escapeRe(p)) : p)

  const settleWaiters = () => {
    for (const waiter of [...textWaiters]) {
      if (waiter.re.test(output)) {
        clearTimeout(waiter.timer)
        textWaiters.delete(waiter)
        waiter.resolve()
      }
    }
  }

  const failWaiters = (err: Error) => {
    for (const waiter of [...textWaiters]) {
      clearTimeout(waiter.timer)
      textWaiters.delete(waiter)
      waiter.reject(err)
    }
  }

  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString()
    settleWaiters()
  })
  child.stderr.on("data", (chunk: Buffer) => {
    output += chunk.toString()
    settleWaiters()
  })
  child.on("exit", (code, signal) => {
    exit = { code, signal }
    failWaiters(new Error(`process exited (code=${code}, signal=${signal}) before matching output`))
    for (const waiter of [...exitWaiters]) {
      exitWaiters.delete(waiter)
      waiter(exit)
    }
  })

  return {
    child,
    output: () => output,
    waitFor(pattern, timeoutMs = DEFAULT_TIMEOUT) {
      const re = toRegExp(pattern)
      if (re.test(output)) return Promise.resolve()
      return new Promise<void>((resolve, reject) => {
        const waiter = {
          re,
          resolve,
          reject,
          timer: setTimeout(() => {
            textWaiters.delete(waiter)
            reject(new Error(`timed out waiting for ${re} in:\n${tail(output)}`))
          }, timeoutMs),
        }
        textWaiters.add(waiter)
      })
    },
    write(data) {
      child.stdin.write(data)
    },
    exited: () => exit,
    waitForExit(timeoutMs = DEFAULT_TIMEOUT) {
      if (exit) return Promise.resolve(exit)
      return new Promise<CliExit>((resolve, reject) => {
        const timer = setTimeout(() => {
          exitWaiters.delete(waiter)
          killTree(child)
          reject(new Error(`timed out waiting for exit; output:\n${tail(output)}`))
        }, timeoutMs)
        const waiter = (result: CliExit) => {
          clearTimeout(timer)
          resolve(result)
        }
        exitWaiters.add(waiter)
      })
    },
    async dispose() {
      if (!exit) {
        killTree(child)
        await new Promise((r) => child.on("exit", r))
      }
    },
  }
}

/**
 * SIGKILL the CLI and anything it spawned. The launcher re-execs itself with
 * `--experimental-ffi`, and killing only the parent would orphan that child
 * (which then holds the test runner's pipes open forever).
 */
function killTree(child: ChildProcessWithoutNullStreams): void {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], { stdio: "ignore" })
    return
  }
  try {
    process.kill(-child.pid, "SIGKILL") // negative PID = the whole process group
  } catch {
    child.kill("SIGKILL")
  }
}

/** Convenience wrapper: spawn, wait for an optional marker, send input, collect the exit. */
export async function runCli(
  script: string,
  opts: SpawnOptions & { waitFor?: string | RegExp; input?: string; timeoutMs?: number } = {},
): Promise<CliExit & { output: string }> {
  const handle = spawnCli(script, opts)
  try {
    if (opts.waitFor) await handle.waitFor(opts.waitFor, opts.timeoutMs)
    const exit = opts.input
      ? await sendUntilExit(handle, opts.input, opts.timeoutMs)
      : await handle.waitForExit(opts.timeoutMs)
    return { ...exit, output: handle.output() }
  } finally {
    await handle.dispose()
  }
}

/**
 * Keystrokes can be dropped while the TUI is still wiring up its input parser,
 * so re-send the key until the process exits instead of writing it once.
 */
export async function sendUntilExit(
  cli: CliHandle,
  input: string,
  timeoutMs = DEFAULT_TIMEOUT,
): Promise<CliExit> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const exit = cli.exited()
    if (exit) return exit
    cli.write(input)
    await sleep(250)
  }
  throw new Error(`did not exit after sending ${JSON.stringify(input)}; output:\n${tail(cli.output())}`)
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Last `n` characters of output, for failure messages (ANSI escapes stripped). */
export function tail(output: string, n = 2000): string {
  const plain = output.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
  return plain.length > n ? plain.slice(-n) : plain
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
