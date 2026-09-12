import { AppError } from '@/lib/errors/app-error'
import type { DeviceMessage, PreferenceClient } from '@/services/preferences/ble-preference-client'

type SerialPortLike = {
  readable?: ReadableStream<Uint8Array>
  writable?: WritableStream<Uint8Array>
  open: (options: { baudRate: number }) => Promise<void>
  close: () => Promise<void>
}

type SerialNavigator = Navigator & {
  serial?: {
    requestPort: () => Promise<SerialPortLike>
  }
}

export class SerialPreferenceClient implements PreferenceClient {
  onDisconnected?: () => void
  private readonly onValue: (value: DeviceMessage) => void
  private readonly encoder = new TextEncoder()
  private readonly decoder = new TextDecoder()
  private port?: SerialPortLike
  private reader?: ReadableStreamDefaultReader<Uint8Array>
  private readTask?: Promise<void>
  private receiveBuffer = ''
  private connected = false
  private closing = false

  constructor({ onValue }: { onValue: (value: DeviceMessage) => void }) {
    this.onValue = onValue
  }

  async connect() {
    const serial = (navigator as SerialNavigator).serial
    if (!serial) throw new AppError('serial-unavailable', 'このブラウザはWeb Serialに対応していません。')
    if (this.port) await this.disconnect()

    const port = await serial.requestPort()
    try {
      await port.open({ baudRate: 115200 })
      if (!port.readable || !port.writable) {
        throw new AppError('serial-stream-unavailable', 'USBシリアル通信を開始できませんでした')
      }

      this.port = port
      this.connected = true
      this.closing = false
      this.reader = port.readable.getReader()
      this.readTask = this.readLoop()
      await this.write({ _hello: 'stackchan-usb-v1' })
    } catch (error) {
      if (this.port) await this.disconnect()
      else await port.close().catch(() => {})
      throw error
    }
  }

  isConnected() {
    return this.connected
  }

  async disconnect() {
    const port = this.port
    this.closing = true
    this.connected = false
    this.port = undefined
    try {
      await this.reader?.cancel()
    } catch {}
    try {
      await this.readTask
    } catch {}
    this.reader = undefined
    this.readTask = undefined
    this.receiveBuffer = ''
    try {
      await port?.close()
    } finally {
      this.closing = false
    }
  }

  async send(payload: object) {
    if (!this.connected) throw new AppError('not-connected', 'ｽﾀｯｸﾁｬﾝへ接続していません')
    await this.write(payload)
  }

  private async write(payload: object) {
    const writable = this.port?.writable
    if (!writable) throw new AppError('not-connected', 'ｽﾀｯｸﾁｬﾝへ接続していません')
    const writer = writable.getWriter()
    try {
      await writer.write(this.encoder.encode(`${JSON.stringify(payload)}\n`))
    } finally {
      writer.releaseLock()
    }
  }

  private async readLoop() {
    const reader = this.reader
    const port = this.port
    if (!reader) return
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        this.receiveBuffer += this.decoder.decode(value, { stream: true })
        this.consumeLines()
      }
      this.receiveBuffer += this.decoder.decode()
      this.consumeLines()
    } catch (error) {
      if (!this.closing) console.warn('[preferences] USB serial read failed', error)
    } finally {
      reader.releaseLock()
      if (!this.closing && this.connected) {
        this.connected = false
        this.port = undefined
        await port?.close().catch(() => {})
        this.onDisconnected?.()
      }
    }
  }

  private consumeLines() {
    while (true) {
      const newline = this.receiveBuffer.indexOf('\n')
      if (newline < 0) return
      const line = this.receiveBuffer.slice(0, newline).trim()
      this.receiveBuffer = this.receiveBuffer.slice(newline + 1)
      if (!line) continue
      try {
        this.onValue(JSON.parse(line) as DeviceMessage)
      } catch (error) {
        console.warn('[preferences] Invalid USB serial message', error)
      }
    }
  }
}
