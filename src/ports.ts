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

type Platform = "darwin" | "linux" | "win32" | "other"

/** Normalize the current OS into one of the supported platform buckets for dispatch. */
function detectPlatform(): Platform {
  const p = process.platform
  if (p === "darwin" || p === "linux" || p === "win32") return p
  return "other"
}

/** Run a shell command and return its stdout as a string. Throws on spawn failure. */
async function run(cmd: string, args: string[]): Promise<string> {
  const proc = Bun.spawn([cmd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const exitCode = await proc.exited
  const stdout = await new Response(proc.stdout).text()
  if (exitCode !== 0) {
    // Non-zero exit is fine for our purposes (e.g. lsof returns 1 when no matches);
    // we just parse whatever stdout we got.
  }
  return stdout
}

/** Parse a port string into a validated 1-65535 integer, or null if invalid. */
function parsePort(s: string): number | null {
  const n = Number(s)
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : null
}

/** Parse the NAME column from lsof / netstat output, e.g. `*:3000 (LISTEN)` or `127.0.0.1:3000 (LISTEN)` or `[::1]:3000`. */
function parseAddressPort(nameField: string): { address: string; port: number } | null {
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

/** Enumerate TCP listening sockets on macOS/Linux using `lsof -nP -iTCP -sTCP:LISTEN`. */
async function listDarwinLinuxLsof(): Promise<PortEntry[]> {
  // -n no DNS, -P no port names, -iTCP only TCP, -sTCP:LISTEN only listening
  let out: string
  try {
    out = await run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"])
  } catch {
    return []
  }
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

/** Enumerate TCP listening sockets on Linux using `ss -tlnp` (preferred over netstat). */
async function listLinuxSs(): Promise<PortEntry[]> {
  let out: string
  try {
    out = await run("ss", ["-tlnp"])
  } catch {
    return []
  }
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
    let address = "*"
    let portStr = ""
    const v6 = local.match(/^\[(.+?)\]:(\d+)$/)
    const v4 = local.match(/^(?:\*|([0-9.]+)):(\d+)$/)
    if (v6) {
      address = `[${v6[1]}]`
      portStr = v6[2]
    } else if (v4) {
      address = v4[1] ?? "*"
      portStr = v4[2]
    } else {
      continue
    }
    const port = parsePort(portStr)
    if (!port) continue
    // users:(("node",pid=1234,fd=20))
    const pidMatch = procField.match(/pid=(\d+)/)
    const nameMatch = procField.match(/users:\(\("([^"]+)"/)
    const pid = pidMatch ? Number(pidMatch[1]) : 0
    const processName = nameMatch ? nameMatch[1] : "unknown"
    if (!pid) continue
    const key = `${port}:${pid}`
    if (seen.has(key)) continue
    seen.add(key)
    entries.push({ port, protocol: "tcp", pid, processName, address })
  }
  return entries
}

/** Fallback enumerator for Linux using `netstat -tlnp` when `ss` is unavailable. */
async function listLinuxNetstat(): Promise<PortEntry[]> {
  let out: string
  try {
    out = await run("netstat", ["-tlnp"])
  } catch {
    return []
  }
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
    const v6 = local.match(/^\[(.+?)\]:(\d+)$/)
    const v4 = local.match(/^(?:\*|([0-9.]+)):(\d+)$/)
    let address = "*"
    let portStr = ""
    if (v6) {
      address = `[${v6[1]}]`
      portStr = v6[2]
    } else if (v4) {
      address = v4[1] ?? "*"
      portStr = v4[2]
    } else {
      continue
    }
    const port = parsePort(portStr)
    if (!port) continue
    // pid/program  e.g. 1234/node
    const m = pidProg.match(/^(\d+)\/(.+)$/)
    if (!m) continue
    const pid = Number(m[1])
    if (!pid) continue
    const key = `${port}:${pid}`
    if (seen.has(key)) continue
    seen.add(key)
    entries.push({ port, protocol: "tcp", pid, processName: m[2], address })
  }
  return entries
}

/** Enumerate TCP listening sockets on Windows via `netstat -ano` plus `tasklist` for process names. */
async function listWindows(): Promise<PortEntry[]> {
  let netstatOut: string
  try {
    netstatOut = await run("netstat", ["-ano", "-p", "tcp"])
  } catch {
    return []
  }
  // Build pid -> process name map in one tasklist pass
  const pidToName = new Map<number, string>()
  try {
    const taskOut = await run("tasklist", ["/FO", "CSV", "/NH"])
    for (const line of taskOut.split("\n")) {
      if (!line.trim()) continue
      // "Name","PID","SessionName","Session#","MemUsage"
      const m = line.match(/^"([^"]+)","(\d+)"/)
      if (m) pidToName.set(Number(m[2]), m[1])
    }
  } catch {
    // ignore - names will be "unknown"
  }

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
    const v6 = local.match(/^\[(.+?)\]:(\d+)$/)
    const v4 = local.match(/^(?:\*|([0-9.]+)):(\d+)$/)
    let address = "*"
    let portStr = ""
    if (v6) {
      address = `[${v6[1]}]`
      portStr = v6[2]
    } else if (v4) {
      address = v4[1] ?? "*"
      portStr = v4[2]
    } else {
      continue
    }
    const port = parsePort(portStr)
    if (!port) continue
    const key = `${port}:${pid}`
    if (seen.has(key)) continue
    seen.add(key)
    entries.push({
      port,
      protocol: "tcp",
      pid,
      processName: pidToName.get(pid) ?? "unknown",
      address,
    })
  }
  return entries
}

/**
 * List all TCP listening ports on the current platform, sorted by port then PID.
 * Selects the best available backend per OS (lsof on macOS, ss/netstat/lsof on Linux,
 * netstat+tasklist on Windows) and returns an empty array on unsupported platforms.
 */
export async function listListeningPorts(): Promise<PortEntry[]> {
  const platform = detectPlatform()
  let entries: PortEntry[]
  if (platform === "darwin") {
    entries = await listDarwinLinuxLsof()
  } else if (platform === "linux") {
    // Prefer ss, fall back to netstat, then lsof
    entries = await listLinuxSs()
    if (entries.length === 0) {
      entries = await listLinuxNetstat()
    }
    if (entries.length === 0) {
      entries = await listDarwinLinuxLsof()
    }
  } else if (platform === "win32") {
    entries = await listWindows()
  } else {
    entries = []
  }
  entries.sort((a, b) => a.port - b.port || a.pid - b.pid)
  return entries
}

/**
 * Terminate the process with the given PID.
 * On Windows uses `taskkill /F /PID`; on Unix tries SIGTERM first and falls back to
 * SIGKILL, bailing out early on EPERM (permission denied).
 */
export async function killProcess(pid: number): Promise<KillResult> {
  const platform = detectPlatform()
  try {
    if (platform === "win32") {
      // taskkill /F /PID <pid>
      const proc = Bun.spawn(["taskkill", "/F", "/PID", String(pid)], {
        stdout: "pipe",
        stderr: "pipe",
      })
      const code = await proc.exited
      if (code === 0) return { ok: true }
      const err = (await new Response(proc.stderr).text()).trim()
      return { ok: false, error: err || `taskkill exited with code ${code}` }
    }
    // unix: try SIGTERM then SIGKILL
    try {
      process.kill(pid, "SIGTERM")
      return { ok: true }
    } catch (e1) {
      // EPERM means no permission; don't retry with SIGKILL
      if (e1 instanceof Error && "code" in e1 && (e1 as NodeJS.ErrnoException).code === "EPERM") {
        return { ok: false, error: "Permission denied" }
      }
      try {
        process.kill(pid, "SIGKILL")
        return { ok: true }
      } catch (e2) {
        return { ok: false, error: e2 instanceof Error ? e2.message : String(e2) }
      }
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
