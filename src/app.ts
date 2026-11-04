import {
  BoxRenderable,
  TextRenderable,
  SelectRenderable,
  SelectRenderableEvents,
  t,
  bold,
  fg,
  type CliRenderer,
} from "@opentui/core"
import { listListeningPorts, killProcess, type PortEntry, type KillResult } from "./ports.ts"

export interface AppState {
  ports: PortEntry[]
  confirmPid: number | null
  confirmLabel: string
  lastRefresh: string
  refreshing: boolean
}

export interface AppDeps {
  /** Port discovery (injectable for tests). */
  listPorts?: () => Promise<PortEntry[]>
  /** Process termination (injectable for tests). */
  kill?: (pid: number) => Promise<KillResult>
  /** Auto-refresh interval in ms. */
  refreshMs?: number
  /** Clock used for the "updated HH:MM:SS" stamp. */
  now?: () => string
}

export interface App {
  readonly state: AppState
  refresh(silent?: boolean): Promise<void>
  destroy(): void
}

export const REFRESH_MS = 5000

/** Return the current time as an `HH:MM:SS` stamp for the "last refreshed" indicator. */
export function nowStamp(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** Right-pad (or truncate) `s` to exactly `len` characters for fixed-width list columns. */
function pad(s: string, len: number): string {
  if (s.length >= len) return s.slice(0, len)
  return s + " ".repeat(len - s.length)
}

/** Build a SelectRenderable option (name + description) from a single port entry. */
function formatRow(e: PortEntry) {
  const port = pad(String(e.port), 6)
  const proto = pad(e.protocol, 5)
  const pid = pad(String(e.pid), 7)
  return {
    name: ` ${port}  ${proto}  ${pid}  ${e.processName}`,
    description: ` listening on ${e.address}:${e.port}`,
  }
}

/**
 * Build the portctl UI inside `renderer` and start the refresh loop.
 * Split out from `index.ts` so the app can be mounted on OpenTUI's test renderer.
 */
export function mount(renderer: CliRenderer, deps: AppDeps = {}): App {
  const listPorts = deps.listPorts ?? listListeningPorts
  const kill = deps.kill ?? killProcess
  const refreshMs = deps.refreshMs ?? REFRESH_MS
  const now = deps.now ?? nowStamp

  const state: AppState = {
    ports: [],
    confirmPid: null,
    confirmLabel: "",
    lastRefresh: "",
    refreshing: false,
  }

  // Once the renderer is torn down, in-flight async work (the initial refresh, a
  // kill, the auto-refresh timer) can still resolve; writing to a destroyed
  // renderable throws "TextBuffer is destroyed", so every render path checks first.
  const isDead = () => renderer.isDestroyed

  // --- Layout (imperative Renderable API) ---
  const root = new BoxRenderable(renderer, {
    id: "root",
    flexDirection: "column",
    height: "100%",
  })

  const header = new BoxRenderable(renderer, {
    id: "header",
    borderStyle: "rounded",
    borderColor: "#ef233c",
    flexDirection: "column",
    height: 4,
    paddingLeft: 1,
    paddingRight: 1,
  })
  const titleText = new TextRenderable(renderer, {
    id: "title",
    content: t`${bold(fg("#ef233c")("portctl"))}`,
  })
  const helpText = new TextRenderable(renderer, {
    id: "help",
    content: "↑/↓ navigate · Enter kill · r refresh · q quit",
    fg: "#8d99ae",
  })
  header.add(titleText)
  header.add(helpText)

  const body = new BoxRenderable(renderer, {
    id: "body",
    borderStyle: "single",
    borderColor: "#2b2d42",
    flexDirection: "column",
    flexGrow: 1,
  })

  const list = new SelectRenderable(renderer, {
    id: "ports",
    width: "100%",
    height: 20,
    options: [],
    backgroundColor: "#2b2d42",
    selectedBackgroundColor: "#8d99ae",
    selectedTextColor: "#2b2d42",
    textColor: "#edf2f4",
    descriptionColor: "#8d99ae",
    showDescription: true,
    showScrollIndicator: true,
    wrapSelection: false,
    // Must be an integer: node:ffi rejects fractional row offsets with
    // "Argument 4 must be a uint32" (Bun's FFI tolerates it).
    itemSpacing: 0,
  })
  body.add(list)

  const footer = new BoxRenderable(renderer, {
    id: "footer",
    borderStyle: "single",
    borderColor: "#2b2d42",
    flexDirection: "column",
    height: 4,
    paddingLeft: 1,
    paddingRight: 1,
  })
  const statusText = new TextRenderable(renderer, { id: "status", content: "", fg: "#8d99ae" })
  const promptText = new TextRenderable(renderer, { id: "prompt", content: "", fg: "#ef233c" })
  footer.add(statusText)
  footer.add(promptText)

  root.add(header)
  root.add(body)
  root.add(footer)
  renderer.root.add(root)

  list.focus()

  // --- Rendering helpers ---
  /** Re-render the port list, or show an empty-state message when nothing is listening. */
  function renderList() {
    if (isDead()) return
    if (state.ports.length === 0) {
      list.options = [
        {
          name: "No listening ports found.",
          description: "Press r to refresh. Some system ports may require elevated privileges.",
        },
      ]
      return
    }
    list.options = state.ports.map(formatRow)
  }

  /** Update the footer status line with port count, last refresh time, and refreshing state. */
  function renderStatus() {
    if (isDead()) return
    const count = state.ports.length
    const parts: string[] = [`${count} listening port${count === 1 ? "" : "s"}`]
    if (state.lastRefresh) parts.push(`updated ${state.lastRefresh}`)
    if (state.refreshing) parts.push("refreshing…")
    statusText.content = parts.join("  ·  ")
    statusText.fg = "#8d99ae"
  }

  /** Show or clear the kill-confirmation prompt depending on `state.confirmPid`. */
  function renderPrompt() {
    if (isDead()) return
    if (state.confirmPid !== null) {
      promptText.content = state.confirmLabel
      promptText.fg = "#ef233c"
    } else {
      promptText.content = ""
    }
  }

  /** Overwrite the status line with an ad-hoc message in the given color. */
  function setStatus(msg: string, color = "#8d99ae") {
    if (isDead()) return
    statusText.content = msg
    statusText.fg = color
  }

  // --- Refresh ---
  /** Re-query listening ports and refresh the list, preserving the current selection when silent. */
  async function refresh(silent = false): Promise<void> {
    if (isDead() || state.refreshing) return
    state.refreshing = true
    if (!silent) setStatus("Refreshing…", "#8d99ae")
    try {
      const prevIndex = list.getSelectedIndex()
      const ports = await listPorts()
      if (isDead()) return
      state.ports = ports
      state.lastRefresh = now()
      renderList()
      if (prevIndex >= 0 && prevIndex < ports.length) {
        list.setSelectedIndex(prevIndex)
      }
    } catch (e) {
      setStatus(`Refresh failed: ${e instanceof Error ? e.message : String(e)}`, "#d90429")
      return
    } finally {
      state.refreshing = false
    }
    renderStatus()
  }

  // --- Kill flow ---
  /** Enter the kill-confirmation state for the given port entry, showing the [y/N] prompt. */
  function startConfirm(entry: PortEntry) {
    state.confirmPid = entry.pid
    state.confirmLabel = `Kill PID ${entry.pid} (${entry.processName} on :${entry.port})? [y/N]`
    renderPrompt()
  }

  /** Abort the kill-confirmation flow and clear the prompt. */
  function cancelConfirm() {
    state.confirmPid = null
    state.confirmLabel = ""
    renderPrompt()
  }

  /** Execute the confirmed kill, report the result on the status line, and silently re-refresh. */
  async function confirmKill() {
    const pid = state.confirmPid
    if (pid === null) return
    const entry = state.ports.find((p) => p.pid === pid)
    state.confirmPid = null
    state.confirmLabel = ""
    renderPrompt()
    setStatus(`Killing PID ${pid}…`, "#ef233c")
    const result = await kill(pid)
    if (result.ok) {
      setStatus(`Killed PID ${pid}${entry ? ` (${entry.processName} on :${entry.port})` : ""}`, "#edf2f4")
      setTimeout(() => void refresh(true), 400)
    } else {
      setStatus(`Failed to kill PID ${pid}: ${result.error ?? "unknown error"}`, "#d90429")
    }
  }

  // --- Select events ---
  list.on(SelectRenderableEvents.ITEM_SELECTED, () => {
    const idx = list.getSelectedIndex()
    if (idx < 0 || idx >= state.ports.length) return
    if (state.confirmPid !== null) return
    startConfirm(state.ports[idx])
  })

  // --- Global key handling ---
  renderer.keyInput.on("keypress", (key: { name: string; ctrl?: boolean; meta?: boolean }) => {
    if (key.name === "q" && !key.ctrl) {
      renderer.destroy()
      return
    }
    if (key.name === "r" && !key.ctrl && !key.meta) {
      void refresh()
      return
    }
    if (state.confirmPid !== null) {
      if (key.name === "y") {
        void confirmKill()
      } else if (key.name === "n" || key.name === "escape") {
        cancelConfirm()
      }
    }
  })

  // --- Auto-refresh + initial load ---
  const autoRefresh = setInterval(() => {
    void refresh(true)
  }, refreshMs)
  renderer.on("destroy", () => clearInterval(autoRefresh))

  void refresh()

  return {
    state,
    refresh,
    destroy() {
      clearInterval(autoRefresh)
      renderer.destroy()
    },
  }
}
