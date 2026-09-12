import { useCallback, useEffect, useRef, useState } from 'react'

import { toAppError, type AppError } from '@/lib/errors/app-error'
import type { ControlResultMessage, DeviceMessage } from '@/services/preferences/ble-preference-client'
import { SerialPreferenceClient } from '@/services/preferences/serial-preference-client'

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

const REQUEST_TIMEOUT_MS = 5000

export function useUSBControl() {
  const [connection, setConnection] = useState<'disconnected' | 'connecting' | 'connected'>('disconnected')
  const [capabilities, setCapabilities] = useState<Set<string>>(() => new Set())
  const [error, setError] = useState<AppError | null>(null)
  const client = useRef<SerialPreferenceClient | undefined>(undefined)
  const pending = useRef(new Map<number, PendingRequest>())
  const nextRequestId = useRef(1)

  const rejectPending = useCallback((message: string) => {
    for (const request of pending.current.values()) {
      clearTimeout(request.timeout)
      request.reject(new Error(message))
    }
    pending.current.clear()
  }, [])

  const handleMessage = useCallback((message: DeviceMessage) => {
    if (!('type' in message)) return
    if (message.type === 'control.ready') {
      setCapabilities(new Set(message.capabilities))
      setConnection('connected')
      return
    }
    if (message.type !== 'control.result' || typeof message.requestId !== 'number') return
    const request = pending.current.get(message.requestId)
    if (!request) return
    clearTimeout(request.timeout)
    pending.current.delete(message.requestId)
    if (message.ok) request.resolve((message as ControlResultMessage).result)
    else request.reject(new Error(message.error ?? 'USB control command failed'))
  }, [])

  const connect = useCallback(async () => {
    setConnection('connecting')
    setError(null)
    const nextClient = new SerialPreferenceClient({ onValue: handleMessage })
    nextClient.onDisconnected = () => {
      setConnection('disconnected')
      setCapabilities(new Set())
      rejectPending('USB connection closed')
    }
    client.current = nextClient
    try {
      await nextClient.connect()
    } catch (cause) {
      client.current = undefined
      setConnection('disconnected')
      setError(toAppError(cause, 'chymod-usb-connect'))
    }
  }, [handleMessage, rejectPending])

  const disconnect = useCallback(async () => {
    const activeClient = client.current
    client.current = undefined
    rejectPending('USB connection closed')
    await activeClient?.disconnect()
    setConnection('disconnected')
    setCapabilities(new Set())
  }, [rejectPending])

  const request = useCallback(
    async (command: string, value?: unknown) => {
      const activeClient = client.current
      if (!activeClient?.isConnected()) throw new Error('USB is not connected')
      if (!capabilities.has(command)) throw new Error(`Unsupported command: ${command}`)
      const requestId = nextRequestId.current++
      const response = new Promise<unknown>((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.current.delete(requestId)
          reject(new Error(`USB command timed out: ${command}`))
        }, REQUEST_TIMEOUT_MS)
        pending.current.set(requestId, { resolve, reject, timeout })
      })
      try {
        await activeClient.send({ type: 'control.command', command, value, requestId })
        return await response
      } catch (cause) {
        const activeRequest = pending.current.get(requestId)
        if (activeRequest) clearTimeout(activeRequest.timeout)
        pending.current.delete(requestId)
        throw cause
      }
    },
    [capabilities]
  )

  useEffect(() => () => void disconnect(), [disconnect])

  return {
    connection,
    connected: connection === 'connected',
    capabilities,
    error,
    connect,
    disconnect,
    request,
  }
}
