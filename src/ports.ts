import { spawn } from "node:child_process"

export interface PortEntry {
  port: number
  protocol: string
  pid: number
  processName: string
  address: string
}

export interface KillResult {
  ok: boolean
  error?: string
}

export type Platform = "darwin" | "linux" | "win32" | "other"

/** Runs a command and resolves with its stdout. Injected in tests. */
export type RunFn = (cmd: string, args: string[]) => Promise<string>

interface RunResult {
  code: number
  stdout: string
  stderr: string
}

export type RunProcessFn = (cmd: string, args: string[]) => Promise<RunResult>
export type KillFn = (pid: number, signal: NodeJS.Signals) => void

/** Normalize the current OS into one of the supported platform buckets for dispatch. */
export function detectPlatform(platform: string = process.platform): Platform {
  if (platform === "darwin" || platform === "linux" || platform === "win32") return platform
  return "other"
}

/** Spawn a command and resolve with its exit code and captured stdout/stderr. Works on Bun and Node.js. */
function runProcess(cmd: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString()
    })
    child.on("error", reject) // e.g. command not found (ENOENT)
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }))
  })
}

/** Run a shell command and return its stdout as a string. Throws on spawn failure. */
async function run(cmd: string, args: string[]): Promise<string> {
  // Non-zero exit is fine for our purposes (e.g. lsof returns 1 when no matches);
  // we just parse whatever stdout we got.
  return (await runProcess(cmd, args)).stdout
}

/** Parse a port string into a validated 1-65535 integer, or null if invalid. */
export function parsePort(s: string): number | null {
  const n = Number(s)
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : null
}

/** Parse the NAME column from lsof / netstat output, e.g. `*:3000 (LISTEN)` or `127.0.0.1:3000 (LISTEN)` or `[::1]:3000`. */
export function parseAddressPort(nameField: string): { address: string; port: number } | null {
  // Strip trailing state like "(LISTEN)"
  const cleaned = nameField.replace(/\s*\(.*\)\s*$/, "").trim()
  // IPv6 bracketed: [::1]:3000  or [::]:3000
  const v6 = cleaned.match(/^\[(.+?)\]:(\d+)$/)
  if (v6) {
    const port = parsePort(v6[2])
    return port ? { address: `[${v6[1]}]`, port } : null
  }
  // *:3000  or 0.0.0.0:3000  or 127.0.0.1:3000
  const v4 = cleaned.match(/^(?:\*|([0-9.]+)):(\d+)$/)
  if (v4) {
    const port = parsePort(v4[2])
    return port ? { address: v4[1] ?? "*", port } : null
  }
  return null
}

/** Parse the `lsof -nP -iTCP -sTCP:LISTEN` table into port entries. */
export function parseLsof(out: string): PortEntry[] {
  const lines = out.split("\n").slice(1) // skip header
  const entries: PortEntry[] = []
  const seen = new Set<string>()
  for (const line of lines) {
    if (!line.trim()) continue
    const cols = line.trim().split(/\s+/)
    // COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME
    if (cols.length < 9) continue
    const command = cols[0]
    const pid = Number(cols[1])
    if (!Number.isInteger(pid) || pid <= 0) continue
    const nameField = cols.slice(8).join(" ")
    const parsed = parseAddressPort(nameField)
    if (!parsed) continue
    const key = `${parsed.port}:${pid}`
    if (seen.has(key)) continue
    seen.add(key)
    entries.push({
      port: parsed.port,
      protocol: "tcp",
      pid,
      processName: command,
      address: parsed.address,
    })
  }
  return entries
}

/** Enumerate TCP listening sockets on macOS/Linux using `lsof -nP -iTCP -sTCP:LISTEN`. */
async function listDarwinLinuxLsof(runCmd: RunFn = run): Promise<PortEntry[]> {
  let out: string
  try {
    // -n no DNS, -P no port names, -iTCP only TCP, -sTCP:LISTEN only listening
    out = await runCmd("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"])
  } catch {
    return []
  }
  return parseLsof(out)
}

/** Parse the `ss -tlnp` table into port entries. */
export function parseSs(out: string): PortEntry[] {
  const lines = out.split("\n").slice(1)
  const entries: PortEntry[] = []
  const seen = new Set<string>()
  for (const line of lines) {
    if (!line.trim()) continue
    // State  Recv-Q Send-Q Local Address:Port Peer Address:Port Process
    const cols = line.trim().split(/\s+/)
    if (cols.length < 5) continue
    const local = cols[3]
    const procField = cols.slice(5).join(" ")
    // Local may be `0.0.0.0:3000`, `*:3000`, or `[::1]:3000` (ss uses brackets for v6)
    const parsed = parseAddressPort(local)
    if (!parsed) continue
    // users:(("node",pid=1234,fd=20))
    const pidMatch = procField.match(/pid=(\d+)/)
    const nameMatch = procField.match(/users:\(\("([^"]+)"/)
    const pid = pidMatch ? Number(pidMatch[1]) : 0
    const processName = nameMatch ? nameMatch[1] : "unknown"
    if (!pid) continue
    const key = `${parsed.port}:${pid}`
    if (seen.has(key)) continue
    seen.add(key)
    entries.push({ port: parsed.port, protocol: "tcp", pid, processName, address: parsed.address })
  }
  return entries
}

/** Enumerate TCP listening sockets on Linux using `ss -tlnp` (preferred over netstat). */
async function listLinuxSs(runCmd: RunFn = run): Promise<PortEntry[]> {
  let out: string
  try {
    out = await runCmd("ss", ["-tlnp"])
  } catch {
    return []
  }
  return parseSs(out)
}

/** Parse the `netstat -tlnp` table into port entries. */
export function parseLinuxNetstat(out: string): PortEntry[] {
  const lines = out.split("\n")
  const entries: PortEntry[] = []
  const seen = new Set<string>()
  for (const line of lines) {
    if (!/LISTEN/.test(line)) continue
    const cols = line.trim().split(/\s+/)
    // Proto Recv-Q Send-Q Local Address Foreign Address State  PID/Program name
    if (cols.length < 7) continue
    const local = cols[3]
    const pidProg = cols[cols.length - 1]
    const parsed = parseAddressPort(local)
    if (!parsed) continue
    // pid/program  e.g. 1234/node
    const m = pidProg.match(/^(\d+)\/(.+)$/)
    if (!m) continue
    const pid = Number(m[1])
    if (!pid) continue
    const key = `${parsed.port}:${pid}`
    if (seen.has(key)) continue
    seen.add(key)
    entries.push({ port: parsed.port, protocol: "tcp", pid, processName: m[2], address: parsed.address })
  }
  return entries
}

/** Fallback enumerator for Linux using `netstat -tlnp` when `ss` is unavailable. */
async function listLinuxNetstat(runCmd: RunFn = run): Promise<PortEntry[]> {
  let out: string
  try {
    out = await runCmd("netstat", ["-tlnp"])
  } catch {
    return []
  }
  return parseLinuxNetstat(out)
}

/** Parse `netstat -ano` output, resolving process names from a `tasklist` PID map. */
export function parseWindowsNetstat(netstatOut: string, pidToName: Map<number, string>): PortEntry[] {
  const entries: PortEntry[] = []
  const seen = new Set<string>()
  for (const line of netstatOut.split("\n")) {
    if (!/LISTENING/.test(line)) continue
    const cols = line.trim().split(/\s+/)
    // Proto Local Address Foreign Address State PID
    if (cols.length < 5) continue
    const local = cols[1]
    const pid = Number(cols[cols.length - 1])
    if (!pid) continue
    const parsed = parseAddressPort(local)
    if (!parsed) continue
    const key = `${parsed.port}:${pid}`
    if (seen.has(key)) continue
    seen.add(key)
    entries.push({
      port: parsed.port,
      protocol: "tcp",
      pid,
      processName: pidToName.get(pid) ?? "unknown",
      address: parsed.address,
    })
  }
  return entries
}

/** Parse `tasklist /FO CSV /NH` output into a PID -> image name map. */
export function parseTasklist(out: string): Map<number, string> {
  const pidToName = new Map<number, string>()
  for (const line of out.split("\n")) {
    if (!line.trim()) continue
    // "Name","PID","SessionName","Session#","MemUsage"
    const m = line.match(/^"([^"]+)","(\d+)"/)
    if (m) pidToName.set(Number(m[2]), m[1])
  }
  return pidToName
}

/** Enumerate TCP listening sockets on Windows via `netstat -ano` plus `tasklist` for process names. */
async function listWindows(runCmd: RunFn = run): Promise<PortEntry[]> {
  let netstatOut: string
  try {
    netstatOut = await runCmd("netstat", ["-ano", "-p", "tcp"])
  } catch {
    return []
  }
  // Build pid -> process name map in one tasklist pass
  let pidToName = new Map<number, string>()
  try {
    pidToName = parseTasklist(await runCmd("tasklist", ["/FO", "CSV", "/NH"]))
  } catch {
    // ignore - names will be "unknown"
  }
  return parseWindowsNetstat(netstatOut, pidToName)
}

export interface ListOptions {
  /** Override the detected platform (tests). */
  platform?: string
  /** Override command execution (tests). */
  run?: RunFn
}

/**
 * List all TCP listening ports on the current platform, sorted by port then PID.
 * Selects the best available backend per OS (lsof on macOS, ss/netstat/lsof on Linux,
 * netstat+tasklist on Windows) and returns an empty array on unsupported platforms.
 */
export async function listListeningPorts(opts: ListOptions = {}): Promise<PortEntry[]> {
  const platform = detectPlatform(opts.platform ?? process.platform)
  const runCmd = opts.run ?? run
  let entries: PortEntry[]
  if (platform === "darwin") {
    entries = await listDarwinLinuxLsof(runCmd)
  } else if (platform === "linux") {
    // Prefer ss, fall back to netstat, then lsof
    entries = await listLinuxSs(runCmd)
    if (entries.length === 0) {
      entries = await listLinuxNetstat(runCmd)
    }
    if (entries.length === 0) {
      entries = await listDarwinLinuxLsof(runCmd)
    }
  } else if (platform === "win32") {
    entries = await listWindows(runCmd)
  } else {
    entries = []
  }
  entries.sort((a, b) => a.port - b.port || a.pid - b.pid)
  return entries
}

export interface KillOptions {
  /** Override the detected platform (tests). */
  platform?: string
  /** Override `process.kill` (tests). */
  kill?: KillFn
  /** Override command execution (tests). */
  runProcess?: RunProcessFn
}

/**
 * Terminate the process with the given PID.
 * On Windows uses `taskkill /F /PID`; on Unix tries SIGTERM first and falls back to
 * SIGKILL, bailing out early on EPERM (permission denied).
 */
export async function killProcess(pid: number, opts: KillOptions = {}): Promise<KillResult> {
  const platform = detectPlatform(opts.platform ?? process.platform)
  const kill = opts.kill ?? process.kill
  const exec = opts.runProcess ?? runProcess
  try {
    if (platform === "win32") {
      // taskkill /F /PID <pid>
      const { code, stderr } = await exec("taskkill", ["/F", "/PID", String(pid)])
      if (code === 0) return { ok: true }
      const err = stderr.trim()
      return { ok: false, error: err || `taskkill exited with code ${code}` }
    }
    // unix: try SIGTERM then SIGKILL
    try {
      kill(pid, "SIGTERM")
      return { ok: true }
    } catch (e1) {
      // EPERM means no permission; don't retry with SIGKILL
      if (e1 instanceof Error && "code" in e1 && (e1 as NodeJS.ErrnoException).code === "EPERM") {
        return { ok: false, error: "Permission denied" }
      }
      try {
        kill(pid, "SIGKILL")
        return { ok: true }
      } catch (e2) {
        return { ok: false, error: e2 instanceof Error ? e2.message : String(e2) }
      }
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
