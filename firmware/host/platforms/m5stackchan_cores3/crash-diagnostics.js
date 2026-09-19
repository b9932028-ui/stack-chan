export default function readCrashDiagnostics() {
  return native('xs_stackchan_crash_diagnostics').call(this)
}
