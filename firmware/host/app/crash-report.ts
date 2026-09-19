import Modules from 'modules'
import Preference from 'preference'

/**
 * Reports XS aborts on a release build.
 *
 * Moddable compiles its own abort reporting out unless mxDebug, mxInstrument or
 * the `xs.abortHook` define is set (xs/platforms/esp/xsPlatform.c), so a release
 * board restarts through esp_restart() with nothing on the wire: the only trace
 * left is `rst:0xc (RTC_SW_CPU_RST)` from the ROM. The define is now set in the
 * host manifest, and this hook adds what the message alone does not say — the
 * exception behind it, and the heap and stack figures that separate an
 * out-of-memory abort from a stack overflow.
 *
 * The report is also stored, because the restart can cut the trace short: the
 * next boot prints whatever arrived too late to read.
 */

const ABORT_DOMAIN = 'diagnostics'
const ABORT_PREFERENCE = 'lastAbort'
// NVS rejects an oversized value, and a truncated report beats none.
const MAX_STORED_REPORT = 900

type CrashDiagnostics = Record<string, number>

function readDiagnostics(): CrashDiagnostics | undefined {
  try {
    if (!Modules.has('stackchan-crash-diagnostics')) return undefined
    return (Modules.importNow('stackchan-crash-diagnostics') as () => CrashDiagnostics)()
  } catch {
    return undefined
  }
}

function describeDiagnostics(diagnostics: CrashDiagnostics | undefined): string {
  if (!diagnostics) return 'diagnostics unavailable'
  const parts: string[] = []
  for (const key in diagnostics) parts.push(`${key}=${diagnostics[key]}`)
  return parts.join(' ')
}

function describeException(exception: unknown): string {
  if (exception === undefined || exception === null) return ''
  try {
    const error = exception as { message?: unknown; stack?: unknown; constructor?: { name?: string } }
    const name = error?.constructor?.name ?? 'value'
    const message = typeof error?.message === 'string' ? error.message : String(exception)
    const stack = typeof error?.stack === 'string' ? ` | stack: ${error.stack}` : ''
    return ` | ${name}: ${message}${stack}`
  } catch {
    return ' | exception could not be described'
  }
}

/** Formats one line so a crash reads the same in the trace and on the next boot. */
export function formatCrashReport(
  message: string,
  exception: unknown,
  diagnostics: CrashDiagnostics | undefined,
): string {
  return `XS abort: ${message}${describeException(exception)} | ${describeDiagnostics(diagnostics)}`
}

export function readLastCrashReport(): string | undefined {
  try {
    const stored = Preference.get(ABORT_DOMAIN, ABORT_PREFERENCE)
    return typeof stored === 'string' && stored ? stored : undefined
  } catch {
    return undefined
  }
}

export function clearLastCrashReport(): void {
  try {
    Preference.delete(ABORT_DOMAIN, ABORT_PREFERENCE)
  } catch {}
}

/**
 * Traces the report the last abort stored, then clears it so the next boot does
 * not repeat a crash that has already been read.
 */
export function reportLastCrash(): void {
  const stored = readLastCrashReport()
  if (!stored) return
  trace(`[crash] previous boot ended in an abort: ${stored}\n`)
  clearLastCrashReport()
}

export function installCrashReporter(): void {
  const globalEnv = globalThis as typeof globalThis & { abort?: (message: string, exception: unknown) => void }
  globalEnv.abort = (message: string, exception: unknown) => {
    // An out-of-memory abort cannot build a string, so name the machine with a
    // literal first: literals are in ROM and need no chunk. Everything after this
    // is best effort and guarded, because a throw here would restore the silence.
    trace('[crash] main machine aborted\n')
    let report = `XS abort: ${message}`
    try {
      report = formatCrashReport(message, exception, readDiagnostics())
    } catch {}
    try {
      trace(`[crash] ${report}\n`)
    } catch {}
    try {
      Preference.set(ABORT_DOMAIN, ABORT_PREFERENCE, report.slice(0, MAX_STORED_REPORT))
    } catch {}
    // Returning false would resume a machine that has already given up; let it restart.
  }
}
