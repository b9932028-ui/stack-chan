import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useUSBControl } from '@/features/chymod/use-usb-control'

const CONNECTION_STORAGE_KEY = 'stackchan.chymod.usb-connection'

afterEach(() => {
  sessionStorage.removeItem(CONNECTION_STORAGE_KEY)
})

describe('useUSBControl', () => {
  it('reconnects the remembered authorized port and only forgets it on manual disconnect', async () => {
    let receive: ReadableStreamDefaultController<Uint8Array> | undefined
    const port = {
      readable: new ReadableStream<Uint8Array>({
        start(controller) {
          receive = controller
        },
      }),
      writable: new WritableStream<Uint8Array>(),
      open: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      getInfo: () => ({ usbVendorId: 0x303a, usbProductId: 0x1001 }),
    }
    const getPorts = vi.fn(async () => [port])
    const requestPort = vi.fn()
    Object.defineProperty(navigator, 'serial', {
      configurable: true,
      value: { getPorts, requestPort },
    })
    sessionStorage.setItem(
      CONNECTION_STORAGE_KEY,
      JSON.stringify({ reconnect: true, usbVendorId: 0x303a, usbProductId: 0x1001 })
    )

    const { result } = renderHook(() => useUSBControl())

    await waitFor(() => expect(port.open).toHaveBeenCalledOnce())
    expect(getPorts).toHaveBeenCalledOnce()
    expect(requestPort).not.toHaveBeenCalled()

    await act(async () => {
      receive?.enqueue(new TextEncoder().encode('{"type":"control.ready","capabilities":["chy.animation.play"]}\n'))
      await Promise.resolve()
    })
    expect(result.current.connection).toBe('connected')
    expect(sessionStorage.getItem(CONNECTION_STORAGE_KEY)).not.toBeNull()

    await act(async () => result.current.disconnect())
    expect(result.current.connection).toBe('disconnected')
    expect(sessionStorage.getItem(CONNECTION_STORAGE_KEY)).toBeNull()
  })
})
