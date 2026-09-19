export type VoiceLogLevel = 'info' | 'warn' | 'error'
export type VoiceLogFields = Record<string, unknown>

type QueuedEntry = VoiceLogFields & { t: string; level: VoiceLogLevel; event: string }

const FLUSH_DELAY_MILLISECONDS = 1000
const MAX_QUEUED = 200
const LOG_ENDPOINT = '/api/chymod/voice/log'

let queue: QueuedEntry[] = []
let timer: ReturnType<typeof setTimeout> | undefined
let inFlight: Promise<void> = Promise.resolve()

/**
 * Mirrors what the page sees into the backend's voice log, so a failure can be
 * read back later instead of only living in this tab's console. Logging is best
 * effort: a dropped batch must never disturb the conversation.
 */
export function logVoice(level: VoiceLogLevel, event: string, fields: VoiceLogFields = {}): void {
  queue.push({ ...fields, t: new Date().toISOString(), level, event })
  if (queue.length > MAX_QUEUED) queue.splice(0, queue.length - MAX_QUEUED)
  // Errors are the reason this log exists, so they go out without waiting for
  // a batch that a page reload might discard.
  if (level === 'error') {
    void flushVoiceLog()
    return
  }
  if (timer === undefined) {
    timer = setTimeout(() => {
      timer = undefined
      void flushVoiceLog()
    }, FLUSH_DELAY_MILLISECONDS)
  }
}

export function flushVoiceLog(): Promise<void> {
  if (timer !== undefined) {
    clearTimeout(timer)
    timer = undefined
  }
  if (queue.length === 0) return inFlight
  const entries = queue
  queue = []
  inFlight = inFlight
    .catch(() => undefined)
    .then(async () => {
      try {
        await fetch(LOG_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ entries }),
          keepalive: true,
        })
      } catch {
        // The dev server may be restarting; the conversation still matters more.
      }
    })
  return inFlight
}

/** Test seam: drops anything not yet posted. */
export function resetVoiceLog(): void {
  if (timer !== undefined) clearTimeout(timer)
  timer = undefined
  queue = []
  inFlight = Promise.resolve()
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
