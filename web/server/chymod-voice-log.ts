import { appendFile, mkdir, rename, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Append-only record of the ChyMOD voice pipeline, written as JSON lines so a
 * past failure can be read back without reproducing it. Both halves write here:
 * the backend directly, and the browser page through /api/chymod/voice/log.
 *
 * The file stays on the machine running the dev server. It contains what was
 * said and answered, because a voice pipeline cannot be debugged without them.
 */
export const VOICE_LOG_DIR = fileURLToPath(new URL('../logs/', import.meta.url))
export const VOICE_LOG_PATH = join(VOICE_LOG_DIR, 'chymod-voice.log')
export const VOICE_LOG_PREVIOUS_PATH = join(VOICE_LOG_DIR, 'chymod-voice.1.log')

/** Rotates once past this size, keeping one previous file: at most 8 MB on disk. */
export const VOICE_LOG_MAX_BYTES = 4 * 1024 * 1024
const MAX_FIELD_LENGTH = 4000
export const VOICE_LOG_MAX_BATCH = 200

export type VoiceLogLevel = 'info' | 'warn' | 'error'
export type VoiceLogSource = 'backend' | 'page'

export type VoiceLogEntry = {
  level: VoiceLogLevel
  event: string
  /** Set by the page for events it recorded before the batch was posted. */
  t?: string
  [field: string]: unknown
}

function truncate(value: unknown): unknown {
  if (typeof value === 'string' && value.length > MAX_FIELD_LENGTH) {
    return `${value.slice(0, MAX_FIELD_LENGTH)}…[${value.length} chars]`
  }
  return value
}

export function formatVoiceLogLine(entry: VoiceLogEntry, source: VoiceLogSource, now = new Date()): string {
  const { level, event, t, ...fields } = entry
  const record: Record<string, unknown> = {
    t: typeof t === 'string' && t ? t : now.toISOString(),
    level,
    source,
    event,
  }
  for (const [key, value] of Object.entries(fields)) {
    if (key === 'level' || key === 'event' || key === 'source') continue
    record[key] = truncate(value)
  }
  try {
    return `${JSON.stringify(record)}\n`
  } catch {
    return `${JSON.stringify({ t: record.t, level: 'warn', source, event, note: 'entry was not serialisable' })}\n`
  }
}

/** Accepts only what the page is supposed to send, so a stray body cannot bloat the file. */
export function readVoiceLogBatch(value: unknown): VoiceLogEntry[] {
  const entries = Array.isArray(value)
    ? value
    : Array.isArray((value as { entries?: unknown })?.entries)
      ? (value as { entries: unknown[] }).entries
      : []
  const accepted: VoiceLogEntry[] = []
  for (const item of entries.slice(0, VOICE_LOG_MAX_BATCH)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const candidate = item as Record<string, unknown>
    if (typeof candidate.event !== 'string' || candidate.event === '') continue
    const level = candidate.level
    accepted.push({
      ...candidate,
      event: candidate.event,
      level: level === 'error' || level === 'warn' ? level : 'info',
    })
  }
  return accepted
}

let writes: Promise<void> = Promise.resolve()
let knownSize: number | undefined

async function currentSize(): Promise<number> {
  try {
    return (await stat(VOICE_LOG_PATH)).size
  } catch {
    return 0
  }
}

async function rotate(): Promise<void> {
  try {
    await unlink(VOICE_LOG_PREVIOUS_PATH)
  } catch {}
  try {
    await rename(VOICE_LOG_PATH, VOICE_LOG_PREVIOUS_PATH)
  } catch {}
  knownSize = 0
}

async function write(text: string): Promise<void> {
  await mkdir(VOICE_LOG_DIR, { recursive: true })
  if (knownSize === undefined) knownSize = await currentSize()
  const bytes = Buffer.byteLength(text)
  if (knownSize + bytes > VOICE_LOG_MAX_BYTES) await rotate()
  await appendFile(VOICE_LOG_PATH, text, 'utf8')
  knownSize = (knownSize ?? 0) + bytes
}

/**
 * Queues entries for the log. Never rejects and never blocks the caller: a
 * request must not fail because its own logging did.
 */
export function logVoiceEvents(entries: VoiceLogEntry[], source: VoiceLogSource = 'backend'): Promise<void> {
  if (entries.length === 0) return writes
  const text = entries.map((entry) => formatVoiceLogLine(entry, source)).join('')
  writes = writes.then(
    () => write(text),
    () => write(text)
  )
  return writes.catch((error) => {
    console.warn('[chymod] voice log write failed', error)
  })
}

export function logVoiceEvent(entry: VoiceLogEntry, source: VoiceLogSource = 'backend'): void {
  void logVoiceEvents([entry], source)
}

/** Resets the cached file size; tests and a manual delete both need this. */
export function resetVoiceLogState(): void {
  knownSize = undefined
}
