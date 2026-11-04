// Tests for src/ports.ts: parser fixtures for every platform, backend dispatch,
// kill semantics, and a real end-to-end listener on the current OS.
import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn, type ChildProcess } from "node:child_process"
import {
  detectPlatform,
  killProcess,
  listListeningPorts,
  parseAddressPort,
  parseLinuxNetstat,
  parseLsof,
  parsePort,
  parseSs,
  parseTasklist,
  parseWindowsNetstat,
  type PortEntry,
} from "../src/ports.ts"

const LSOF = `COMMAND     PID USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
node       4242  ash   23u  IPv4 0x1111111111      0t0  TCP *:3000 (LISTEN)
node       4242  ash   24u  IPv6 0x2222222222      0t0  TCP [::1]:3000 (LISTEN)
node       5555  ash   25u  IPv4 0x3333333333      0t0  TCP *:3000 (LISTEN)
postgres     99  ash    5u  IPv4 0x4444444444      0t0  TCP 127.0.0.1:5432 (LISTEN)
nginx       123  root   6u  IPv4 0x5555555555      0t0  TCP *:99999 (LISTEN)
garbage line
`

const SS = `State  Recv-Q Send-Q Local Address:Port Peer Address:Port Process
LISTEN 0      511          0.0.0.0:3000      0.0.0.0:*     users:(("node",pid=4242,fd=21))
LISTEN 0      128             [::1]:5432         [::]:*     users:(("postgres",pid=99,fd=7))
LISTEN 0      128                [::]:8080          [::]:*     users:(("nginx",pid=123,fd=6))
LISTEN 0      128           127.0.0.1:99999    0.0.0.0:*     users:(("bad",pid=1,fd=1))
`

const NETSTAT_LINUX = `Active Internet connections (only servers)
Proto Recv-Q Send-Q Local Address           Foreign Address         State       PID/Program name
tcp        0      0 0.0.0.0:3000            0.0.0.0:*               LISTEN      4242/node
tcp6       0      0 [::]:5432               [::]:*                  LISTEN      99/postgres
tcp        0      0 127.0.0.1:7000          127.0.0.1:5555          ESTABLISHED 5/foo
`

const NETSTAT_WINDOWS = `Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       4242
  TCP    [::1]:5432             [::]:0                 LISTENING       99
  TCP    127.0.0.1:5000         127.0.0.1:6000         ESTABLISHED     77
`

const TASKLIST = `"node.exe","4242","Console","1","100,000 K"
"postgres.exe","99","Console","1","50,000 K"
"System","4","Services","0","100 K"
`

const portsOf = (entries: PortEntry[]) => entries.map((e) => `${e.address}:${e.port}/${e.pid}`)

test("parsePort validates the 1-65535 range", () => {
  assert.equal(parsePort("3000"), 3000)
  assert.equal(parsePort("1"), 1)
  assert.equal(parsePort("65535"), 65535)
  assert.equal(parsePort("0"), null)
  assert.equal(parsePort("65536"), null)
  assert.equal(parsePort("-1"), null)
  assert.equal(parsePort("abc"), null)
  assert.equal(parsePort("30.5"), null)
})

test("parseAddressPort handles wildcard, IPv4, IPv6, and junk", () => {
  assert.deepEqual(parseAddressPort("*:3000 (LISTEN)"), { address: "*", port: 3000 })
  assert.deepEqual(parseAddressPort("127.0.0.1:5432"), { address: "127.0.0.1", port: 5432 })
  assert.deepEqual(parseAddressPort("0.0.0.0:80"), { address: "0.0.0.0", port: 80 })
  assert.deepEqual(parseAddressPort("[::1]:8080"), { address: "[::1]", port: 8080 })
  assert.deepEqual(parseAddressPort("[::]:443"), { address: "[::]", port: 443 })
  assert.equal(parseAddressPort("*:99999"), null)
  assert.equal(parseAddressPort("nonsense"), null)
  assert.equal(parseAddressPort("127.0.0.1:0"), null)
})

test("parseLsof reads rows, dedupes port+pid, and skips bad lines", () => {
  const entries = parseLsof(LSOF)
  assert.deepEqual(portsOf(entries), ["*:3000/4242", "*:3000/5555", "127.0.0.1:5432/99"])
  assert.equal(entries[0].processName, "node")
  assert.equal(entries[2].processName, "postgres")
  assert.equal(entries[0].protocol, "tcp")
})

test("parseSs reads users:(()) process info and skips invalid ports", () => {
  const entries = parseSs(SS)
  assert.deepEqual(portsOf(entries), ["0.0.0.0:3000/4242", "[::1]:5432/99", "[::]:8080/123"])
  assert.deepEqual(
    entries.map((e) => e.processName),
    ["node", "postgres", "nginx"],
  )
})

test("parseLinuxNetstat reads pid/program and ignores non-listening rows", () => {
  const entries = parseLinuxNetstat(NETSTAT_LINUX)
  assert.deepEqual(portsOf(entries), ["0.0.0.0:3000/4242", "[::]:5432/99"])
  assert.equal(entries[1].processName, "postgres")
})

test("parseTasklist maps PIDs to image names", () => {
  const map = parseTasklist(TASKLIST)
  assert.equal(map.get(4242), "node.exe")
  assert.equal(map.get(99), "postgres.exe")
  assert.equal(map.get(4), "System")
})

test("parseWindowsNetstat resolves names and ignores non-listening rows", () => {
  const entries = parseWindowsNetstat(NETSTAT_WINDOWS, parseTasklist(TASKLIST))
  assert.deepEqual(portsOf(entries), ["0.0.0.0:3000/4242", "[::1]:5432/99"])
  assert.deepEqual(
    entries.map((e) => e.processName),
    ["node.exe", "postgres.exe"],
  )
  // Unknown PIDs fall back to "unknown" rather than being dropped.
  const unknown = parseWindowsNetstat(NETSTAT_WINDOWS, new Map())
  assert.equal(unknown[0].processName, "unknown")
})

test("detectPlatform buckets unknown systems as other", () => {
  assert.equal(detectPlatform("darwin"), "darwin")
  assert.equal(detectPlatform("linux"), "linux")
  assert.equal(detectPlatform("win32"), "win32")
  assert.equal(detectPlatform("freebsd"), "other")
})

function fakeRun(responses: Record<string, string>) {
  const calls: string[] = []
  const run = async (cmd: string, args: string[]) => {
    calls.push([cmd, ...args].join(" "))
    const key = cmd
    if (!(key in responses)) throw Object.assign(new Error(`${cmd} not found`), { code: "ENOENT" })
    return responses[key]
  }
  return { run, calls }
}

test("darwin uses lsof only", async () => {
  const { run, calls } = fakeRun({ lsof: LSOF })
  const entries = await listListeningPorts({ platform: "darwin", run })
  assert.deepEqual(calls, ["lsof -nP -iTCP -sTCP:LISTEN"])
  assert.equal(entries.length, 3)
})

test("linux prefers ss and falls back to netstat then lsof", async () => {
  const ss = fakeRun({ ss: SS })
  await listListeningPorts({ platform: "linux", run: ss.run })
  assert.deepEqual(ss.calls, ["ss -tlnp"])

  const netstat = fakeRun({ ss: "", netstat: NETSTAT_LINUX })
  const entries = await listListeningPorts({ platform: "linux", run: netstat.run })
  assert.deepEqual(netstat.calls, ["ss -tlnp", "netstat -tlnp"])
  assert.equal(entries.length, 2)

  const lsof = fakeRun({ ss: "", netstat: "", lsof: LSOF })
  await listListeningPorts({ platform: "linux", run: lsof.run })
  assert.deepEqual(lsof.calls, ["ss -tlnp", "netstat -tlnp", "lsof -nP -iTCP -sTCP:LISTEN"])
})

test("windows uses netstat plus tasklist", async () => {
  const { run, calls } = fakeRun({ netstat: NETSTAT_WINDOWS, tasklist: TASKLIST })
  const entries = await listListeningPorts({ platform: "win32", run })
  assert.deepEqual(calls, ["netstat -ano -p tcp", "tasklist /FO CSV /NH"])
  assert.equal(entries.length, 2)
})

test("windows still lists ports when tasklist fails", async () => {
  const { run } = fakeRun({ netstat: NETSTAT_WINDOWS })
  const entries = await listListeningPorts({ platform: "win32", run })
  assert.equal(entries.length, 2)
  assert.equal(entries[0].processName, "unknown")
})

test("unsupported platforms return an empty list without shelling out", async () => {
  const { run, calls } = fakeRun({})
  assert.deepEqual(await listListeningPorts({ platform: "freebsd", run }), [])
  assert.deepEqual(calls, [])
})

test("results are sorted by port then pid", async () => {
  const unsorted = `COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME
b 9 u 1u IPv4 0x1 0t0 TCP *:9000 (LISTEN)
a 3 u 1u IPv4 0x2 0t0 TCP *:80 (LISTEN)
c 2 u 1u IPv4 0x3 0t0 TCP *:9000 (LISTEN)
`
  const entries = await listListeningPorts({ platform: "darwin", run: async () => unsorted })
  assert.deepEqual(portsOf(entries), ["*:80/3", "*:9000/2", "*:9000/9"])
})

test("killProcess sends SIGTERM on unix", async () => {
  const signals: Array<[number, string]> = []
  const result = await killProcess(4242, {
    platform: "darwin",
    kill: (pid, sig) => signals.push([pid, sig]),
  })
  assert.deepEqual(result, { ok: true })
  assert.deepEqual(signals, [[4242, "SIGTERM"]])
})

test("killProcess falls back to SIGKILL when SIGTERM fails", async () => {
  const signals: string[] = []
  const result = await killProcess(4242, {
    platform: "linux",
    kill: (_pid, sig) => {
      signals.push(sig)
      if (sig === "SIGTERM") throw Object.assign(new Error("no such process"), { code: "ESRCH" })
    },
  })
  assert.deepEqual(result, { ok: true })
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"])
})

test("killProcess does not retry with SIGKILL on EPERM", async () => {
  const signals: string[] = []
  const result = await killProcess(4242, {
    platform: "darwin",
    kill: (_pid, sig) => {
      signals.push(sig)
      throw Object.assign(new Error("operation not permitted"), { code: "EPERM" })
    },
  })
  assert.deepEqual(result, { ok: false, error: "Permission denied" })
  assert.deepEqual(signals, ["SIGTERM"])
})

test("killProcess reports the SIGKILL failure message", async () => {
  const result = await killProcess(4242, {
    platform: "linux",
    kill: () => {
      throw new Error("kaboom")
    },
  })
  assert.deepEqual(result, { ok: false, error: "kaboom" })
})

test("killProcess uses taskkill on windows", async () => {
  const calls: string[] = []
  const ok = await killProcess(4242, {
    platform: "win32",
    runProcess: async (cmd, args) => {
      calls.push([cmd, ...args].join(" "))
      return { code: 0, stdout: "", stderr: "" }
    },
  })
  assert.deepEqual(ok, { ok: true })
  assert.deepEqual(calls, ["taskkill /F /PID 4242"])

  const failed = await killProcess(4242, {
    platform: "win32",
    runProcess: async () => ({ code: 1, stdout: "", stderr: "Access is denied." }),
  })
  assert.deepEqual(failed, { ok: false, error: "Access is denied." })
})

/** Spawn a child that listens on an ephemeral port and prints it. */
async function spawnListener(): Promise<{ child: ChildProcess; port: number }> {
  const child = spawn(
    process.execPath,
    [
      "--eval",
      `const s = require("node:net").createServer();
       s.listen(0, "127.0.0.1", () => console.log(s.address().port));`,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  )
  const port = await new Promise<number>((resolve, reject) => {
    let out = ""
    child.stdout!.on("data", (chunk: Buffer) => {
      out += chunk.toString()
      const m = out.match(/(\d+)/)
      if (m) resolve(Number(m[1]))
    })
    child.on("error", reject)
    setTimeout(() => reject(new Error(`listener did not report a port; saw ${JSON.stringify(out)}`)), 10_000)
  })
  return { child, port }
}

test("finds a real listener and kills it (end-to-end on this OS)", async () => {
  const { child, port } = await spawnListener()
  try {
    let found: PortEntry | undefined
    for (let i = 0; i < 40 && !found; i++) {
      found = (await listListeningPorts()).find((e) => e.port === port)
      if (!found) await new Promise((r) => setTimeout(r, 100))
    }
    assert.ok(found, `port ${port} was not listed by the platform backend`)
    assert.equal(found.pid, child.pid)

    const result = await killProcess(child.pid!)
    assert.deepEqual(result, { ok: true })

    const exited = await new Promise<boolean>((resolve) => {
      child.on("exit", () => resolve(true))
      setTimeout(() => resolve(false), 5000)
    })
    assert.equal(exited, true, "process should exit after SIGTERM")
  } finally {
    child.kill("SIGKILL")
  }
})
