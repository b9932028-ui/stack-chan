import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { flushVoiceLog, logVoice, resetVoiceLog } from '@/features/chymod/voice-log'

function postedEntries(fetchMock: ReturnType<typeof vi.fn>, call = 0) {
  const body = fetchMock.mock.calls[call]?.[1]?.body as string
  return JSON.parse(body).entries as Array<Record<string, unknown>>
}

describe('logVoice', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.useFakeTimers()
    resetVoiceLog()
    fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.useRealTimers()
    resetVoiceLog()
  })

  it('batches informational entries into one request', async () => {
    logVoice('info', 'usb.transport', { state: 'ready' })
    logVoice('info', 'conversation.start', { requestId: 'r1' })
    expect(fetchMock).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const entries = postedEntries(fetchMock)
    expect(entries.map((entry) => entry.event)).toEqual(['usb.transport', 'conversation.start'])
    expect(entries[0].level).toBe('info')
    expect(typeof entries[0].t).toBe('string')
  })

  it('posts an error immediately, since a reload would lose the batch', async () => {
    logVoice('info', 'usb.transport', { state: 'ready' })
    logVoice('error', 'usb.device-error', { code: 4 })
    await vi.advanceTimersByTimeAsync(0)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(postedEntries(fetchMock).map((entry) => entry.event)).toEqual(['usb.transport', 'usb.device-error'])
  })

  it('never rejects when the dev server is unreachable', async () => {
    fetchMock.mockRejectedValue(new Error('Failed to fetch'))
    logVoice('error', 'conversation.failed', { message: 'boom' })
    await expect(flushVoiceLog()).resolves.toBeUndefined()
  })

  it('does not post when nothing was logged', async () => {
    await flushVoiceLog()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
