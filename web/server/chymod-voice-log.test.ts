import { describe, expect, it } from 'vitest'

import { formatVoiceLogLine, readVoiceLogBatch, VOICE_LOG_MAX_BATCH } from './chymod-voice-log'

describe('formatVoiceLogLine', () => {
  it('writes one JSON object per line, stamping the source and a timestamp', () => {
    const line = formatVoiceLogLine(
      { level: 'info', event: 'backend.ask', milliseconds: 5300 },
      'backend',
      new Date('2026-09-16T08:00:00.000Z')
    )
    expect(line.endsWith('\n')).toBe(true)
    expect(JSON.parse(line)).toEqual({
      t: '2026-09-16T08:00:00.000Z',
      level: 'info',
      source: 'backend',
      event: 'backend.ask',
      milliseconds: 5300,
    })
  })

  it('keeps the timestamp the page recorded, so queued entries stay in order', () => {
    const line = formatVoiceLogLine(
      { level: 'error', event: 'usb.device-error', t: '2026-09-16T07:59:00.000Z' },
      'page',
      new Date('2026-09-16T08:00:00.000Z')
    )
    expect(JSON.parse(line).t).toBe('2026-09-16T07:59:00.000Z')
    expect(JSON.parse(line).source).toBe('page')
  })

  it('truncates a runaway field instead of writing it whole', () => {
    const parsed = JSON.parse(formatVoiceLogLine({ level: 'info', event: 'e', text: 'x'.repeat(9000) }, 'page'))
    expect(parsed.text.length).toBeLessThan(9000)
    expect(parsed.text).toContain('[9000 chars]')
  })

  it('still produces a line when a field cannot be serialised', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const parsed = JSON.parse(formatVoiceLogLine({ level: 'info', event: 'e', cyclic }, 'page'))
    expect(parsed.event).toBe('e')
    expect(parsed.note).toBe('entry was not serialisable')
  })
})

describe('readVoiceLogBatch', () => {
  it('accepts entries under an `entries` key or as a bare array', () => {
    const entry = { level: 'warn', event: 'usb.transport', state: 'disconnected' }
    expect(readVoiceLogBatch({ entries: [entry] })).toEqual([entry])
    expect(readVoiceLogBatch([entry])).toEqual([entry])
  })

  it('drops anything without an event name and defaults an unknown level', () => {
    const accepted = readVoiceLogBatch({
      entries: [{ event: '' }, { level: 'info' }, 'string', null, [1], { event: 'ok', level: 'shout' }],
    })
    expect(accepted).toEqual([{ event: 'ok', level: 'info' }])
  })

  it('caps how much one request can append', () => {
    const entries = Array.from({ length: VOICE_LOG_MAX_BATCH + 50 }, (_, index) => ({
      level: 'info',
      event: `e${index}`,
    }))
    expect(readVoiceLogBatch({ entries })).toHaveLength(VOICE_LOG_MAX_BATCH)
  })

  it('returns nothing for a body that is not a batch', () => {
    expect(readVoiceLogBatch({ nope: true })).toEqual([])
    expect(readVoiceLogBatch(undefined)).toEqual([])
  })
})
