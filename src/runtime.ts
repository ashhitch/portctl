// Runtime decisions for the published launcher (`cli.ts`). Kept separate from the
// side-effecting launcher so they can be unit-tested without spawning processes.

export const FFI_FLAG = "--experimental-ffi"
export const ALLOW_FFI_FLAG = "--allow-ffi"
export const QUIET_WARNING_FLAG = "--disable-warning=ExperimentalWarning"
/** Set on the re-exec'd child so a failed re-exec can't loop forever. */
export const RETRY_ENV = "PORTCTL_FFI_RETRY"

/** `node:ffi` landed in Node 26.1; older releases reject the flag outright. */
export function isFfiEligible(nodeVersion: string): boolean {
  const [major, minor] = nodeVersion.split(".").map(Number)
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return false
  return major > 26 || (major === 26 && minor >= 1)
}

/** True when we're already running with the flag the re-exec would add. */
export function hasFfiFlag(execArgv: readonly string[]): boolean {
  return execArgv.includes(FFI_FLAG)
}

/**
 * Arguments for the re-exec. `--allow-ffi` is only included when the running
 * Node accepts it, since older builds in the 26.x line may not know the flag.
 */
export function buildReexecArgs(
  argv: readonly string[],
  opts: { allowFfi: boolean },
): string[] {
  return [
    FFI_FLAG,
    ...(opts.allowFfi ? [ALLOW_FFI_FLAG] : []),
    QUIET_WARNING_FLAG,
    ...argv,
  ]
}

export interface ReexecInput {
  hasBun: boolean
  ffiAvailable: boolean
  execArgv: readonly string[]
  retried: boolean
  nodeVersion: string
}

/** Whether the launcher should re-exec itself to enable `node:ffi`. */
export function shouldReexec(input: ReexecInput): boolean {
  if (input.hasBun || input.ffiAvailable) return false
  if (input.retried || hasFfiFlag(input.execArgv)) return false
  return isFfiEligible(input.nodeVersion)
}

/** The message shown when neither Bun nor a Node build with `node:ffi` is available. */
export const UNSUPPORTED_RUNTIME_MESSAGE =
  "portctl needs the experimental `node:ffi` module (Node.js 26.1+ with FFI support) or Bun.\n" +
  "This Node.js build does not expose `node:ffi`; install a newer Node.js or Bun and try again."
