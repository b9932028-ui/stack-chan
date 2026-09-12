import { describe, expect, it, vi } from 'vitest'

import { SerialPreferenceClient } from '@/services/preferences/serial-preference-client'

describe('SerialPreferenceClient', () => {
  it('uses newline-delimited JSON for the USB preference protocol', async () => {
    const writes: string[] = []
    let receive: ReadableStreamDefaultController<Uint8Array> | undefined
    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        receive = controller
      },
    })
    const writable = new WritableStream<Uint8Array>({
      write(chunk) {
        writes.push(new TextDecoder().decode(chunk))
      },
    })
    const port = {
      readable,
      writable,
      open: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    }
    Object.defineProperty(navigator, 'serial', {
      configurable: true,
      value: { requestPort: vi.fn(async () => port) },
    })
    const onValue = vi.fn()
    const client = new SerialPreferenceClient({ onValue })

    await client.connect()
    expect(writes).toEqual(['{"_hello":"stackchan-usb-v1"}\n'])

    receive?.enqueue(
      new TextEncoder().encode('{"prop":"ui.language","value":"en"}\n{"prop":"tts.volume","value":0.5}\n')
    )
    await Promise.resolve()
    expect(onValue).toHaveBeenNthCalledWith(1, {
      prop: 'ui.language',
      value: 'en',
    })
    expect(onValue).toHaveBeenNthCalledWith(2, {
      prop: 'tts.volume',
      value: 0.5,
    })

    await client.send({ _batch: { 'ui.language': 'zh-CN' } })
    expect(writes.at(-1)).toBe('{"_batch":{"ui.language":"zh-CN"}}\n')
    await client.disconnect()
    expect(port.close).toHaveBeenCalledOnce()
  })
})
