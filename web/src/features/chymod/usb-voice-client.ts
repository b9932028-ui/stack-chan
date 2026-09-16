import type { SerialNavigator, SerialPortLike } from '@/services/preferences/serial-preference-client'

import {
  encodeStackChanFrame,
  pcm16Rms,
  pcm16ToWav,
  readPcm16Wav,
  STACKCHAN_MAX_PAYLOAD_BYTES,
  STACKCHAN_MICROPHONE_SAMPLE_RATE,
  StackChanControl,
  StackChanEventCodec,
  StackChanFrameParser,
  StackChanFrameType,
  WEB_VOICE_CAPABILITIES,
  type StackChanFrame,
} from './usb-audio-protocol'

type ControlWaiter = {
  control: StackChanControl
  streamId?: number
  resolve: (frame: StackChanFrame) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

type ApplicationControlWaiter = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

export type VoiceTransportState = 'disconnected' | 'connecting' | 'ready'
export type VoiceApplicationEvent = Record<string, unknown> & { type?: string }

/** Timeline of one microphone capture, in milliseconds from MIC_START. */
export type RecordingStats = {
  stopReason: 'silence' | 'limit' | 'manual' | 'ended'
  stopSentMilliseconds: number
  wallMilliseconds: number
  firstFrameMilliseconds: number | null
  lastFrameMilliseconds: number | null
  frames: number
  framesAfterStop: number
  audioMilliseconds: number
  missingFrames: number
  peakRms: number
  parserDiscardedBytes: number
  parserCrcFailures: number
}

const SILENCE_MILLISECONDS = 1_200
const MIN_RECORDING_MILLISECONDS = 2_000
const RECORDING_LIMIT_MILLISECONDS = 15_000
// CoreS3's raw microphone level is quiet: the captured diagnostic utterance
// had a speech RMS around 400-675 and an idle floor around 60-115.
const SPEECH_RMS_THRESHOLD = 180

export class USBVoiceClient {
  onStateChanged?: (state: VoiceTransportState) => void
  onApplicationEvent?: (event: VoiceApplicationEvent) => void
  onControlReady?: (capabilities: string[]) => void
  onRecordingStats?: (stats: RecordingStats) => void
  private state: VoiceTransportState = 'disconnected'
  private port?: SerialPortLike
  private reader?: ReadableStreamDefaultReader<Uint8Array>
  private readTask?: Promise<void>
  private closing = false
  private sendTail: Promise<void> = Promise.resolve()
  private parser = new StackChanFrameParser()
  private eventCodec = new StackChanEventCodec()
  private encoder = new TextEncoder()
  private decoder = new TextDecoder()
  private controlSequence = 0
  private applicationControlSequence = 0
  private streamSequence = 0
  private waiters = new Set<ControlWaiter>()
  private applicationControlWaiters = new Map<number, ApplicationControlWaiter>()
  private microphone?: {
    streamId: number
    chunks: Uint8Array[]
    speechSeen: boolean
    lastSpeechAt: number
    stopRequested: boolean
    expectedSequence: number
    missingFrames: number
    requestedAt: number
    firstFrameAt?: number
    lastFrameAt?: number
    stopSentAt?: number
    frames: number
    framesAfterStop: number
    pcmBytes: number
    peakRms: number
    discardedAtStart: number
    crcFailuresAtStart: number
  }
  private speaker?: { streamId: number; credit: number; sequence: number; wakeCredit?: () => void }

  async connect(authorizedPort?: SerialPortLike): Promise<void> {
    if (this.state !== 'disconnected') return
    this.setState('connecting')
    const serial = (navigator as SerialNavigator).serial
    if (!serial) throw new Error('Web Serial is unavailable. Use Chrome or Edge.')
    const port = authorizedPort ?? (await serial.requestPort())
    try {
      await port.open({ baudRate: 115200 })
      if (!port.readable || !port.writable) throw new Error('USB serial streams are unavailable.')
      this.port = port
      this.closing = false
      this.reader = port.readable.getReader()
      this.readTask = this.readLoop()
      const helloAck = this.waitForControl(StackChanControl.HELLO_ACK, undefined, 5000)
      const payload = new Uint8Array(8)
      const view = new DataView(payload.buffer)
      view.setUint32(0, STACKCHAN_MAX_PAYLOAD_BYTES, true)
      view.setUint32(4, WEB_VOICE_CAPABILITIES, true)
      await this.sendControl(StackChanControl.HELLO, 0, 0, payload)
      const ack = await helloAck
      if ((ack.payload?.byteLength ?? 0) !== 8) throw new Error('USB Audio handshake returned an invalid response.')
      const capabilities = new DataView(ack.payload!.buffer, ack.payload!.byteOffset, 8).getUint32(4, true)
      const required = (1 << 0) | (1 << 1) | (1 << 2) | (1 << 9) | (1 << 10)
      if ((capabilities & required) !== required)
        throw new Error('Connected firmware does not expose the required USB voice capabilities.')
      this.setState('ready')
      await this.sendApplicationEvent({ type: 'session.created', event_id: `web-${Date.now()}` })
    } catch (error) {
      await this.disconnect()
      throw error
    }
  }

  async disconnect(): Promise<void> {
    this.closing = true
    this.setState('disconnected')
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timeout)
      waiter.reject(new Error('USB voice connection closed.'))
    }
    this.waiters.clear()
    this.rejectApplicationControlWaiters(new Error('USB voice connection closed.'))
    this.microphone = undefined
    this.speaker = undefined
    try {
      await this.reader?.cancel()
    } catch {}
    try {
      await this.readTask
    } catch {}
    this.reader = undefined
    this.readTask = undefined
    const port = this.port
    this.port = undefined
    try {
      await port?.close()
    } finally {
      this.parser.reset()
      this.closing = false
    }
  }

  async recordUtterance(): Promise<Blob> {
    this.requireReady()
    if (this.microphone) throw new Error('Microphone capture is already active.')
    const streamId = this.nextStreamId()
    const started = this.waitForControl(StackChanControl.MIC_STARTED, streamId, 5000)
    this.microphone = {
      streamId,
      chunks: [],
      speechSeen: false,
      lastSpeechAt: Date.now(),
      stopRequested: false,
      expectedSequence: 0,
      missingFrames: 0,
      requestedAt: performance.now(),
      frames: 0,
      framesAfterStop: 0,
      pcmBytes: 0,
      peakRms: 0,
      discardedAtStart: this.parser.discardedBytes,
      crcFailuresAtStart: this.parser.crcFailures,
    }
    await this.sendControl(StackChanControl.MIC_START, streamId, STACKCHAN_MICROPHONE_SAMPLE_RATE)
    await started
    const beganAt = Date.now()
    let stopReason: RecordingStats['stopReason'] = 'ended'
    await new Promise<void>((resolve) => {
      const timer = window.setInterval(() => {
        const microphone = this.microphone
        const elapsed = Date.now() - beganAt
        const silent = Boolean(
          microphone?.speechSeen &&
          elapsed >= MIN_RECORDING_MILLISECONDS &&
          Date.now() - microphone.lastSpeechAt >= SILENCE_MILLISECONDS
        )
        if (!microphone || microphone.stopRequested || silent || elapsed >= RECORDING_LIMIT_MILLISECONDS) {
          stopReason = !microphone ? 'ended' : microphone.stopRequested ? 'manual' : silent ? 'silence' : 'limit'
          window.clearInterval(timer)
          resolve()
        }
      }, 100)
    })
    const microphone = this.microphone
    if (!microphone) throw new Error('Microphone capture ended unexpectedly.')
    const stopped = this.waitForControl(StackChanControl.MIC_STOPPED, streamId, 5000)
    microphone.stopSentAt = performance.now()
    await this.sendControl(StackChanControl.MIC_STOP, streamId, STACKCHAN_MICROPHONE_SAMPLE_RATE)
    await stopped
    this.microphone = undefined
    this.reportRecordingStats(microphone, stopReason)
    if (microphone.missingFrames > 0)
      throw new Error(`USB microphone lost ${microphone.missingFrames} PCM frame(s); recording was discarded.`)
    return pcm16ToWav(microphone.chunks)
  }

  stopRecording(): void {
    if (this.microphone) this.microphone.stopRequested = true
  }

  private reportRecordingStats(
    microphone: NonNullable<USBVoiceClient['microphone']>,
    stopReason: RecordingStats['stopReason']
  ): void {
    const since = (time?: number) => (time === undefined ? null : Math.round(time - microphone.requestedAt))
    const stats: RecordingStats = {
      stopReason,
      stopSentMilliseconds: since(microphone.stopSentAt) ?? 0,
      wallMilliseconds: Math.round(performance.now() - microphone.requestedAt),
      firstFrameMilliseconds: since(microphone.firstFrameAt),
      lastFrameMilliseconds: since(microphone.lastFrameAt),
      frames: microphone.frames,
      framesAfterStop: microphone.framesAfterStop,
      audioMilliseconds: Math.round((microphone.pcmBytes * 1000) / (STACKCHAN_MICROPHONE_SAMPLE_RATE * 2)),
      missingFrames: microphone.missingFrames,
      peakRms: Math.round(microphone.peakRms),
      parserDiscardedBytes: this.parser.discardedBytes - microphone.discardedAtStart,
      parserCrcFailures: this.parser.crcFailures - microphone.crcFailuresAtStart,
    }
    console.info('[chymod] microphone recording stats', stats)
    this.onRecordingStats?.(stats)
  }

  async playWav(wav: ArrayBuffer, caption: string): Promise<void> {
    this.requireReady()
    const { sampleRate, pcm } = readPcm16Wav(new Uint8Array(wav))
    const streamId = this.nextStreamId()
    this.speaker = { streamId, credit: 0, sequence: 0 }
    const done = this.waitForControl(StackChanControl.SPEAKER_DONE, streamId, 60_000)
    await this.sendControl(StackChanControl.SPEAKER_START, streamId, sampleRate)
    const captionBytes = this.encoder.encode(caption).slice(0, 1024)
    if (captionBytes.byteLength > 0)
      await this.sendControl(StackChanControl.SPEAKER_TEXT, streamId, sampleRate, captionBytes)
    let offset = 0
    while (offset < pcm.byteLength) {
      await this.waitForSpeakerCredit()
      const speaker = this.speaker
      if (!speaker || speaker.streamId !== streamId) throw new Error('Speaker playback ended unexpectedly.')
      const size = Math.min(STACKCHAN_MAX_PAYLOAD_BYTES, speaker.credit, pcm.byteLength - offset)
      if (size <= 0) continue
      await this.sendFrame({
        type: StackChanFrameType.SPEAKER_PCM,
        streamId,
        sampleRate,
        sequence: speaker.sequence++,
        payload: pcm.slice(offset, offset + size),
      })
      speaker.credit -= size
      offset += size
    }
    await this.sendControl(StackChanControl.SPEAKER_END, streamId, sampleRate)
    await done
    this.speaker = undefined
  }

  async sendApplicationEvent(event: Record<string, unknown>): Promise<void> {
    const bytes = this.encoder.encode(JSON.stringify(event))
    for (const frame of this.eventCodec.encode(bytes)) await this.sendFrame(frame)
  }

  async requestControl(command: string, value?: unknown): Promise<unknown> {
    this.requireReady()
    const requestId = ++this.applicationControlSequence
    const result = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.applicationControlWaiters.delete(requestId)
        reject(new Error(`USB control command timed out: ${command}`))
      }, 5000)
      this.applicationControlWaiters.set(requestId, { resolve, reject, timeout })
    })
    try {
      await this.sendApplicationEvent({ type: 'control.command', requestId, command, value })
      return await result
    } catch (error) {
      const waiter = this.applicationControlWaiters.get(requestId)
      if (waiter) clearTimeout(waiter.timeout)
      this.applicationControlWaiters.delete(requestId)
      throw error
    }
  }

  private async readLoop(): Promise<void> {
    const reader = this.reader
    if (!reader) return
    try {
      while (true) {
        const result = await reader.read()
        if (result.done) break
        for (const frame of this.parser.push(result.value)) this.handleFrame(frame)
      }
    } catch (error) {
      if (!this.closing) this.failAll(error instanceof Error ? error : new Error(String(error)))
    } finally {
      reader.releaseLock()
      if (!this.closing) {
        this.port = undefined
        this.setState('disconnected')
      }
    }
  }

  private handleFrame(frame: StackChanFrame): void {
    if (frame.type === StackChanFrameType.CONTROL) {
      const speaker = this.speaker
      const controlPayload = frame.payload
      if (
        frame.flags === StackChanControl.SPEAKER_CREDIT &&
        speaker &&
        speaker.streamId === frame.streamId &&
        controlPayload?.byteLength === 4
      ) {
        speaker.credit += new DataView(controlPayload.buffer, controlPayload.byteOffset, 4).getUint32(0, true)
        speaker.wakeCredit?.()
        speaker.wakeCredit = undefined
      }
      if (frame.flags === StackChanControl.ERROR) {
        const code =
          frame.payload?.byteLength === 4
            ? new DataView(frame.payload.buffer, frame.payload.byteOffset, 4).getUint32(0, true)
            : 0
        this.failAll(new Error(`Stack-Chan USB Audio error ${code}.`))
        return
      }
      this.resolveWaiters(frame)
      return
    }
    const microphone = this.microphone
    if (frame.type === StackChanFrameType.MICROPHONE_PCM && microphone && microphone.streamId === frame.streamId) {
      const payload = frame.payload ?? new Uint8Array(0)
      if (frame.sequence !== microphone.expectedSequence) {
        const gap = frame.sequence - microphone.expectedSequence
        microphone.missingFrames += gap > 0 ? gap : 1
      }
      microphone.expectedSequence = frame.sequence + 1
      microphone.chunks.push(payload)
      const now = performance.now()
      microphone.firstFrameAt ??= now
      microphone.lastFrameAt = now
      microphone.frames += 1
      microphone.pcmBytes += payload.byteLength
      if (microphone.stopSentAt !== undefined) microphone.framesAfterStop += 1
      const rms = pcm16Rms(payload)
      if (rms > microphone.peakRms) microphone.peakRms = rms
      if (rms >= SPEECH_RMS_THRESHOLD) {
        microphone.speechSeen = true
        microphone.lastSpeechAt = Date.now()
      }
      return
    }
    if (frame.type !== StackChanFrameType.EVENT) return
    const payload = this.eventCodec.push(frame)
    if (!payload) return
    try {
      const event = JSON.parse(this.decoder.decode(payload)) as VoiceApplicationEvent
      if (event.type === 'session.update' && typeof event.event_id === 'string') {
        void this.sendApplicationEvent({ type: 'session.updated', event_id: event.event_id })
      }
      if (event.type === 'control.ready' && Array.isArray(event.capabilities)) {
        this.onControlReady?.(
          event.capabilities.filter((capability): capability is string => typeof capability === 'string')
        )
      }
      if (event.type === 'control.result' && typeof event.requestId === 'number') {
        const waiter = this.applicationControlWaiters.get(event.requestId)
        if (waiter) {
          clearTimeout(waiter.timeout)
          this.applicationControlWaiters.delete(event.requestId)
          if (event.ok === true) waiter.resolve(event.result)
          else waiter.reject(new Error(typeof event.error === 'string' ? event.error : 'USB control command failed.'))
        }
      }
      this.onApplicationEvent?.(event)
    } catch {}
  }

  private sendControl(
    control: StackChanControl,
    streamId: number,
    sampleRate: number,
    payload?: Uint8Array
  ): Promise<void> {
    return this.sendFrame({
      type: StackChanFrameType.CONTROL,
      flags: control,
      streamId,
      sampleRate,
      sequence: this.controlSequence++,
      payload,
    })
  }

  private sendFrame(frame: StackChanFrame): Promise<void> {
    const operation = this.sendTail.then(async () => {
      const writable = this.port?.writable
      if (!writable) throw new Error('USB voice is not connected.')
      const writer = writable.getWriter()
      try {
        await writer.write(encodeStackChanFrame(frame))
      } finally {
        writer.releaseLock()
      }
    })
    this.sendTail = operation.catch(() => undefined)
    return operation
  }

  private waitForControl(
    control: StackChanControl,
    streamId?: number,
    timeoutMilliseconds = 5000
  ): Promise<StackChanFrame> {
    return new Promise((resolve, reject) => {
      const waiter: ControlWaiter = {
        control,
        streamId,
        resolve,
        reject,
        timeout: setTimeout(() => {
          this.waiters.delete(waiter)
          reject(new Error(`USB Audio control ${control} timed out.`))
        }, timeoutMilliseconds),
      }
      this.waiters.add(waiter)
    })
  }

  private resolveWaiters(frame: StackChanFrame): void {
    for (const waiter of this.waiters) {
      if (waiter.control !== frame.flags || (waiter.streamId !== undefined && waiter.streamId !== frame.streamId))
        continue
      clearTimeout(waiter.timeout)
      this.waiters.delete(waiter)
      waiter.resolve(frame)
    }
  }

  private waitForSpeakerCredit(): Promise<void> {
    if (this.speaker && this.speaker.credit > 0) return Promise.resolve()
    return new Promise((resolve) => {
      if (!this.speaker) resolve()
      else this.speaker.wakeCredit = resolve
    })
  }

  private failAll(error: Error): void {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timeout)
      waiter.reject(error)
    }
    this.waiters.clear()
    this.rejectApplicationControlWaiters(error)
    this.microphone = undefined
    this.speaker?.wakeCredit?.()
    this.speaker = undefined
  }

  private rejectApplicationControlWaiters(error: Error): void {
    for (const waiter of this.applicationControlWaiters.values()) {
      clearTimeout(waiter.timeout)
      waiter.reject(error)
    }
    this.applicationControlWaiters.clear()
  }

  private requireReady(): void {
    if (this.state !== 'ready') throw new Error('USB voice is not connected.')
  }

  private nextStreamId(): number {
    this.streamSequence = this.streamSequence >= 0xffff ? 1 : this.streamSequence + 1
    return this.streamSequence
  }

  private setState(state: VoiceTransportState): void {
    if (this.state === state) return
    this.state = state
    this.onStateChanged?.(state)
  }
}
