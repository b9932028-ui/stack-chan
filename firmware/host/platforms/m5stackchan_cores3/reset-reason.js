export default function readResetReason() {
  return native('xs_stackchan_reset_reason').call(this)
}
