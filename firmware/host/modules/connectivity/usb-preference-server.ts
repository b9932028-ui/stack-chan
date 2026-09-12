import type { PREF_KEYS } from 'consts'
import Preference from 'preference'
import USBSerial from 'stackchan-usb-serial'
import { isUSBSerialOutputFullError, type USBSerialIO } from 'stackchan-usb-serial-types'
import TextDecoder from 'text/decoder'
import TextEncoder from 'text/encoder'

type PreferenceValue = string | boolean | number | ArrayBuffer

type USBPreferenceServerProps = {
  onPreferenceChanged?: (key: string, value: ReturnType<(typeof Preference)['get']>) => void
  onConnected?: () => void
  onDisconnected?: () => void
  keys?: typeof PREF_KEYS
  effectiveValues?: Readonly<Record<string, PreferenceValue>>
  readOnlyKeys?: readonly string[]
  onControlCommand?: (command: string, value: unknown) => unknown | Promise<unknown>
  controlCapabilities?: readonly string[]
}

const MAX_RECEIVE_BYTES = 64 * 1024
const WRITE_CHUNK_BYTES = 1024

export class USBPreferenceServer {
  #serial?: USBSerialIO
  #keys
  #effectiveValues
  #readOnlyKeys
  #receiveBytes: number[] = []
  #pendingOutput: Uint8Array[] = []
  #readBuffer = new Uint8Array(1024)
  #decoder = new TextDecoder('utf-8', { fatal: true })
  #encoder = new TextEncoder()
  #connected = false
  #handlePreferenceChanged?: (key: string, value: PreferenceValue) => void
  #handleConnected?: () => void
  #handleDisconnected?: () => void
  #handleControlCommand?: (command: string, value: unknown) => unknown | Promise<unknown>
  #controlCapabilities: readonly string[]

  constructor(options: USBPreferenceServerProps = {}) {
    this.#keys = Array.isArray(options.keys) ? options.keys.slice() : []
    this.#effectiveValues = options.effectiveValues ?? {}
    this.#readOnlyKeys = options.readOnlyKeys ?? []
    this.#handlePreferenceChanged = options.onPreferenceChanged
    this.#handleConnected = options.onConnected
    this.#handleDisconnected = options.onDisconnected
    this.#handleControlCommand = options.onControlCommand
    this.#controlCapabilities = options.controlCapabilities ?? []

    const server = this
    this.#serial = new USBSerial({
      format: 'buffer',
      onReadable(bytes) {
        server.#onReadable(this, bytes)
      },
      onWritable() {
        server.#onWritable(this)
      },
      onError() {
        server.#onError(this)
      },
    })
  }

  close() {
    const serial = this.#serial
    this.#serial = undefined
    this.#receiveBytes = []
    this.#pendingOutput = []
    serial?.close()
    this.#setDisconnected()
  }

  #onReadable(serial: USBSerialIO, _available: number) {
    if (serial !== this.#serial) return
    try {
      while (true) {
        const count = serial.read(this.#readBuffer)
        if (count === undefined || count <= 0) break
        for (let index = 0; index < count; index += 1) this.#receiveBytes.push(this.#readBuffer[index])
        if (this.#receiveBytes.length > MAX_RECEIVE_BYTES) {
          this.#receiveBytes = []
          trace('[preferences-usb] discarded oversized message\n')
          break
        }
        this.#consumeLines()
      }
      this.#flushOutput()
    } catch (error) {
      trace(`[preferences-usb] read failed: ${String(error)}\n`)
      this.#onError(serial)
    }
  }

  #onWritable(serial: USBSerialIO) {
    if (serial !== this.#serial) return
    if (!serial.connected) this.#setDisconnected()
    this.#flushOutput()
  }

  #onError(serial: USBSerialIO) {
    if (serial !== this.#serial) return
    this.#serial = undefined
    try {
      serial.close()
    } catch {}
    this.#setDisconnected()
  }

  #consumeLines() {
    while (true) {
      const newline = this.#receiveBytes.indexOf(10)
      if (newline < 0) return
      const line = this.#receiveBytes.splice(0, newline)
      this.#receiveBytes.splice(0, 1)
      if (line.length === 0) continue
      try {
        const message = JSON.parse(this.#decoder.decode(new Uint8Array(line))) as Record<string, unknown>
        this.#handleMessage(message)
      } catch (error) {
        trace(`[preferences-usb] invalid message: ${String(error)}\n`)
      }
    }
  }

  #handleMessage(message: Record<string, unknown>) {
    if (message._hello === 'preferences-v1' || message._hello === 'stackchan-usb-v1') {
      if (!this.#connected) {
        this.#connected = true
        this.#handleConnected?.()
      }
      for (const [domain, key] of this.#keys) {
        const prop = `${domain}.${key}`
        const readOnly = this.#readOnlyKeys.includes(prop)
        const currentValue = readOnly
          ? this.#effectiveValues[prop]
          : (Preference.get(domain, key) ?? this.#effectiveValues[prop])
        if (currentValue != null) this.#notifyPreference(prop, currentValue, readOnly)
      }
      this.#notify({ type: 'control.ready', capabilities: this.#controlCapabilities })
      return
    }

    if (message.type === 'control.command' && typeof message.command === 'string') {
      void this.#runControlCommand(message.command, message.value, message.requestId)
      return
    }

    if (message._batch && typeof message._batch === 'object') {
      for (const [prop, value] of Object.entries(message._batch as Record<string, PreferenceValue>)) {
        this.#receiveAndSetPreference(prop, value)
      }
      return
    }

    if (typeof message.prop === 'string' && message.value != null) {
      this.#receiveAndSetPreference(message.prop, message.value as PreferenceValue)
    }
  }

  async #runControlCommand(command: string, value: unknown, requestId: unknown) {
    if (!this.#handleControlCommand || !this.#controlCapabilities.includes(command)) {
      this.#notify({ type: 'control.result', requestId, command, ok: false, error: 'unsupported command' })
      return
    }
    try {
      const result = await this.#handleControlCommand(command, value)
      this.#notify({
        type: 'control.result',
        requestId,
        command,
        ok: true,
        ...(result === undefined ? {} : { result }),
      })
    } catch (error) {
      this.#notify({ type: 'control.result', requestId, command, ok: false, error: String(error) })
    }
  }

  #receiveAndSetPreference(prop: string, value: PreferenceValue) {
    const separator = prop.indexOf('.')
    if (separator <= 0 || separator === prop.length - 1) return
    const domain = prop.slice(0, separator)
    const key = prop.slice(separator + 1)
    if (this.#readOnlyKeys.includes(prop)) {
      const currentValue = this.#effectiveValues[prop]
      if (currentValue != null) this.#notifyPreference(prop, currentValue, true)
      return
    }
    const currentValue = Preference.get(domain, key) ?? this.#effectiveValues[prop]
    if (currentValue === value) return
    Preference.set(domain, key, value)
    this.#notifyPreference(prop, value)
    this.#handlePreferenceChanged?.(prop, value)
  }

  #notifyPreference(prop: string, value: PreferenceValue, readOnly = false) {
    this.#notify({ prop, value, ...(readOnly ? { readOnly: true } : {}) })
  }

  #notify(message: Record<string, unknown>) {
    const bytes = this.#encoder.encode(`${JSON.stringify(message)}\n`)
    for (let offset = 0; offset < bytes.byteLength; offset += WRITE_CHUNK_BYTES) {
      this.#pendingOutput.push(bytes.slice(offset, offset + WRITE_CHUNK_BYTES))
    }
    this.#flushOutput()
  }

  #flushOutput() {
    const serial = this.#serial
    if (!serial?.connected) return
    while (this.#pendingOutput.length > 0) {
      try {
        serial.write(this.#pendingOutput[0])
        this.#pendingOutput.shift()
      } catch (error) {
        if (isUSBSerialOutputFullError(error)) return
        throw error
      }
    }
  }

  #setDisconnected() {
    if (!this.#connected) return
    this.#connected = false
    this.#handleDisconnected?.()
  }
}
