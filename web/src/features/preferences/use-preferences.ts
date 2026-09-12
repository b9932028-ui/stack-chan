import { useCallback, useEffect, useRef, useState } from 'react'

import {
  DEFAULT_PREFERENCES,
  isPreferenceKey,
  type PreferenceKey,
  type PreferenceValues,
} from '@/features/preferences/preference-model'
import type { OperationState } from '@/features/operations/operation-state'
import { toAppError } from '@/lib/errors/app-error'
import {
  BlePreferenceClient,
  type DeviceMessage,
  type PreferenceClient,
} from '@/services/preferences/ble-preference-client'
import { SerialPreferenceClient } from '@/services/preferences/serial-preference-client'

type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'disconnecting'
export type PreferenceTransport = 'ble' | 'usb'
type ClientFactory = (onValue: (value: DeviceMessage) => void, transport: PreferenceTransport) => PreferenceClient

const defaultClientFactory: ClientFactory = (onValue, transport) =>
  transport === 'usb'
    ? new SerialPreferenceClient({ onValue })
    : new BlePreferenceClient({ deviceName: 'STK', onValue })

export function usePreferences(clientFactory: ClientFactory = defaultClientFactory) {
  const [connection, setConnection] = useState<ConnectionState>('disconnected')
  const [transport, setTransport] = useState<PreferenceTransport>('ble')
  const [values, setValues] = useState<PreferenceValues>(DEFAULT_PREFERENCES)
  const [readOnly, setReadOnly] = useState<Set<PreferenceKey>>(() => new Set())
  const [controlCapabilities, setControlCapabilities] = useState<Set<string>>(() => new Set())
  const [operation, setOperation] = useState<OperationState>({
    status: 'idle',
  })
  const currentValues = useRef<Partial<PreferenceValues>>({})
  const dirty = useRef(new Set<PreferenceKey>())
  const readOnlyRef = useRef(new Set<PreferenceKey>())
  const valueHandler = useRef<(value: DeviceMessage) => void>(() => {})
  const nextRequestId = useRef(1)
  const acknowledgedPowerCommand = useRef(false)
  const disconnectedHandler = useRef<() => void>(() => {})
  const client = useRef<PreferenceClient | undefined>(undefined)

  valueHandler.current = (message) => {
    if ('type' in message && message.type === 'control.ready') {
      setControlCapabilities(new Set(message.capabilities))
      return
    }
    if ('type' in message && message.type === 'control.result') {
      if (message.ok) {
        acknowledgedPowerCommand.current = message.command === 'restart' || message.command === 'shutdown'
        setOperation({
          status: 'success',
          result: undefined,
          message: '操作を送信しました。',
        })
      } else {
        setOperation({
          status: 'error',
          error: toAppError(new Error(message.error ?? '操作に失敗しました'), 'control-command'),
        })
      }
      return
    }
    if (!('prop' in message)) return
    const { prop, value, readOnly: isReadOnly = false } = message
    if (!isPreferenceKey(prop)) return
    const normalized = String(value)
    currentValues.current[prop] = normalized
    const nextReadOnly = new Set(readOnlyRef.current)
    if (isReadOnly) {
      nextReadOnly.add(prop)
      dirty.current.delete(prop)
    } else {
      nextReadOnly.delete(prop)
    }
    readOnlyRef.current = nextReadOnly
    setReadOnly(nextReadOnly)
    if (!dirty.current.has(prop)) setValues((current) => ({ ...current, [prop]: normalized }))
  }

  disconnectedHandler.current = () => {
    setConnection('disconnected')
    setOperation({
      ...(acknowledgedPowerCommand.current
        ? {
            status: 'success' as const,
            result: undefined,
            message: '電源操作を受け付けました。USB接続が切断されました。',
          }
        : { status: 'cancelled' as const, message: '接続が切れました。保存されていない項目を確認してください。' }),
    })
    acknowledgedPowerCommand.current = false
    currentValues.current = {}
    dirty.current.clear()
    readOnlyRef.current = new Set()
    setReadOnly(new Set())
    setControlCapabilities(new Set())
  }

  if (!client.current) {
    client.current = clientFactory((value) => valueHandler.current(value), transport)
    client.current.onDisconnected = () => disconnectedHandler.current()
  }

  useEffect(() => {
    return () => {
      const activeClient = client.current
      if (!activeClient) return
      activeClient.onDisconnected = undefined
      if (activeClient.isConnected()) activeClient.disconnect().catch(() => {})
    }
  }, [])

  const connect = useCallback(
    async (nextTransport: PreferenceTransport = 'ble') => {
      let activeClient = client.current
      if (!activeClient || nextTransport !== transport) {
        activeClient = clientFactory((value) => valueHandler.current(value), nextTransport)
        activeClient.onDisconnected = () => disconnectedHandler.current()
        client.current = activeClient
      }
      setTransport(nextTransport)
      setConnection('connecting')
      setOperation({
        status: 'pending',
        message: nextTransport === 'usb' ? 'USBデバイスを選択してください' : 'BLEデバイスを検索しています',
      })
      try {
        await activeClient.connect()
        setConnection('connected')
        setOperation({
          status: 'success',
          result: undefined,
          message: 'ｽﾀｯｸﾁｬﾝへ接続しました',
        })
      } catch (error) {
        setConnection('disconnected')
        setOperation({
          status: 'error',
          error: toAppError(error, `${nextTransport}-connect`),
        })
      }
    },
    [clientFactory, transport]
  )

  const disconnect = useCallback(async () => {
    const activeClient = client.current
    if (!activeClient) return
    setConnection('disconnecting')
    try {
      await activeClient.disconnect()
      setConnection('disconnected')
      setOperation({ status: 'cancelled', message: 'BLE接続を切断しました' })
    } catch (error) {
      setConnection(activeClient.isConnected() ? 'connected' : 'disconnected')
      setOperation({
        status: 'error',
        error: toAppError(error, 'ble-disconnect'),
      })
    }
  }, [])

  const update = useCallback((key: PreferenceKey, value: string) => {
    if (readOnlyRef.current.has(key)) return
    if (currentValues.current[key] === value) dirty.current.delete(key)
    else dirty.current.add(key)
    setValues((current) => ({ ...current, [key]: value }))
  }, [])

  const savePayload = useCallback(async (payload: Partial<PreferenceValues>, successMessage: string) => {
    const activeClient = client.current
    if (!activeClient?.isConnected()) return
    const entries = Object.entries(payload).filter(([key]) => !readOnlyRef.current.has(key as PreferenceKey))
    if (entries.length === 0) {
      setOperation({
        status: 'cancelled',
        message: '変更する項目がありません。',
      })
      return
    }
    const batch = Object.fromEntries(entries)
    setOperation({ status: 'pending', message: '設定を保存しています' })
    try {
      await activeClient.send({ _batch: batch })
      for (const [key, value] of entries) {
        const preferenceKey = key as PreferenceKey
        currentValues.current[preferenceKey] = value
        dirty.current.delete(preferenceKey)
      }
      setOperation({
        status: 'success',
        result: undefined,
        message: successMessage,
      })
    } catch (error) {
      setOperation({
        status: 'error',
        error: toAppError(error, 'preference-save'),
      })
    }
  }, [])

  const save = useCallback(() => {
    const payload: Partial<PreferenceValues> = {}
    for (const key of dirty.current) {
      if (!readOnlyRef.current.has(key) && currentValues.current[key] !== values[key]) {
        payload[key] = values[key]
      }
    }
    return savePayload(payload, '設定を送信しました。')
  }, [savePayload, values])

  const clearWifi = useCallback(async () => {
    dirty.current.add('wifi.ssid')
    dirty.current.add('wifi.password')
    setValues((current) => ({
      ...current,
      'wifi.ssid': '',
      'wifi.password': '',
    }))
    await savePayload(
      { 'wifi.ssid': '', 'wifi.password': '' },
      'Wi-Fi設定を消去しました。再起動後はオフラインになります。'
    )
  }, [savePayload])

  const control = useCallback(
    async (command: string, value?: unknown) => {
      const activeClient = client.current
      if (!activeClient?.isConnected() || transport !== 'usb' || !controlCapabilities.has(command)) return
      setOperation({ status: 'pending', message: '操作を送信しています' })
      try {
        await activeClient.send({
          type: 'control.command',
          command,
          value,
          requestId: nextRequestId.current++,
        })
      } catch (error) {
        setOperation({
          status: 'error',
          error: toAppError(error, 'control-command'),
        })
      }
    },
    [controlCapabilities, transport]
  )

  return {
    connection,
    transport,
    connected: connection === 'connected',
    busy: connection === 'connecting' || connection === 'disconnecting' || operation.status === 'pending',
    values,
    readOnly,
    controlCapabilities,
    controlAvailable: transport === 'usb' && controlCapabilities.size > 0,
    operation,
    connect,
    disconnect,
    update,
    save,
    clearWifi,
    control,
  }
}
