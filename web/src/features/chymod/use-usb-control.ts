import { useCallback, useEffect, useRef, useState } from 'react'

import { toAppError, type AppError } from '@/lib/errors/app-error'
import type { ControlResultMessage, DeviceMessage } from '@/services/preferences/ble-preference-client'
import {
  SerialPreferenceClient,
  type SerialNavigator,
  type SerialPortInfoLike,
  type SerialPortLike,
} from '@/services/preferences/serial-preference-client'

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

const REQUEST_TIMEOUT_MS = 5000
const CONNECTION_STORAGE_KEY = 'stackchan.chymod.usb-connection'

type StoredConnection = SerialPortInfoLike & { reconnect: true }

function readStoredConnection(): StoredConnection | null {
  try {
    const value = sessionStorage.getItem(CONNECTION_STORAGE_KEY)
    if (!value) return null
    const parsed = JSON.parse(value) as Partial<StoredConnection>
    return parsed.reconnect === true ? { ...parsed, reconnect: true } : null
  } catch {
    return null
  }
}

function rememberConnection(port: SerialPortLike) {
  try {
    const info = port.getInfo?.() ?? {}
    sessionStorage.setItem(CONNECTION_STORAGE_KEY, JSON.stringify({ reconnect: true, ...info }))
  } catch {}
}

function forgetConnection() {
  try {
    sessionStorage.removeItem(CONNECTION_STORAGE_KEY)
  } catch {}
}

function isStoredPort(port: SerialPortLike, stored: StoredConnection) {
  const info = port.getInfo?.() ?? {}
  return info.usbVendorId === stored.usbVendorId && info.usbProductId === stored.usbProductId
}

export function useUSBControl() {
  const [connection, setConnection] = useState<'disconnected' | 'connecting' | 'connected'>(() =>
    readStoredConnection() ? 'connecting' : 'disconnected'
  )
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

  const startConnection = useCallback(
    async (authorizedPort?: SerialPortLike) => {
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
        await nextClient.connect(authorizedPort)
        if (client.current !== nextClient) {
          await nextClient.disconnect()
          return
        }
        const connectedPort = nextClient.getPort()
        if (connectedPort) rememberConnection(connectedPort)
      } catch (cause) {
        if (client.current === nextClient) {
          client.current = undefined
          forgetConnection()
          setConnection('disconnected')
          setError(toAppError(cause, 'chymod-usb-connect'))
        }
      }
    },
    [handleMessage, rejectPending]
  )

  const connect = useCallback(async () => startConnection(), [startConnection])

  const disconnect = useCallback(async () => {
    forgetConnection()
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

  useEffect(() => {
    const stored = readStoredConnection()
    if (!stored) return

    let cancelled = false
    const restoreConnection = async () => {
      const serial = (navigator as SerialNavigator).serial
      if (!serial?.getPorts) {
        forgetConnection()
        setConnection('disconnected')
        return
      }
      try {
        const ports = await serial.getPorts()
        if (cancelled) return
        const port = ports.find((candidate) => isStoredPort(candidate, stored))
        if (!port) {
          forgetConnection()
          setConnection('disconnected')
          return
        }
        await startConnection(port)
      } catch (cause) {
        if (cancelled) return
        forgetConnection()
        setConnection('disconnected')
        setError(toAppError(cause, 'chymod-usb-reconnect'))
      }
    }
    void restoreConnection()

    return () => {
      cancelled = true
      const activeClient = client.current
      client.current = undefined
      rejectPending('USB connection closed')
      void activeClient?.disconnect()
    }
  }, [rejectPending, startConnection])

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
