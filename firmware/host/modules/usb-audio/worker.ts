import startUsbAudioBridge, {
  type UsbAudioBridgeControl,
  type UsbAudioMicrophoneInput,
  type UsbAudioMicrophoneInputFactory,
  type UsbAudioMicrophoneInputOptions,
  type UsbAudioPlaybackObserver,
} from 'stackchan-usb-audio-core'
import { crc32Usb } from 'stackchan-usb-crc32'
import type { UsbEventTransportState } from 'stackchan-usb-event-transport'
import { readMicrophoneCapture } from 'stackchan-usb-microphone-capture'
import USBSerial from 'stackchan-usb-serial'
import { type SharedSpeakerOutputBuffers, SharedSpeakerOutputService } from 'stackchan-usb-shared-output'
import Timer from 'timer'
import type { Self } from 'worker'

declare const self: Self

let bridge: UsbAudioBridgeControl | undefined
let inputService: NativeMicrophoneInputService | undefined
let outputService: SharedSpeakerOutputService | undefined

type PostMessage = (message: Record<string, unknown>) => void

const MICROPHONE_POLL_MILLISECONDS = 20
// 128 ms of 16 kHz mono PCM per read; the native ring holds 3 seconds.
const MICROPHONE_READ_BYTES = 4096
const MICROPHONE_MAX_READS_PER_POLL = 16

/**
 * The main VM claims the shared I2S input and opens native capture; this worker
 * drains the native ring directly, so a busy main VM cannot drop speech.
 */
class NativeMicrophoneInput implements UsbAudioMicrophoneInput {
  readonly #options: UsbAudioMicrophoneInputOptions
  readonly #postMessage: PostMessage
  readonly #buffer = new Uint8Array(MICROPHONE_READ_BYTES)
  #timer: ReturnType<typeof Timer.repeat> | undefined
  #active = false
  #closed = false
  #startPosted = false

  constructor(options: UsbAudioMicrophoneInputOptions, postMessage: PostMessage) {
    this.#options = options
    this.#postMessage = postMessage
  }

  get streamId(): number {
    return this.#options.streamId
  }

  start(): void {
    if (this.#closed || this.#startPosted) return
    this.#startPosted = true
    this.#postMessage({
      id: 'microphone-open',
      streamId: this.streamId,
      sampleRate: this.#options.sampleRate,
      channels: this.#options.channels,
      bitsPerSample: this.#options.bitsPerSample,
    })
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#active = false
    this.#stopPolling()
    this.#postMessage({ id: 'microphone-close', streamId: this.streamId })
  }

  handleStarted(): void {
    if (this.#closed || this.#active || !this.#startPosted) return
    this.#active = true
    this.#options.onStarted.call(this)
    if (!this.#active) return
    this.#timer = Timer.repeat(() => this.#drain(), MICROPHONE_POLL_MILLISECONDS)
  }

  handleFailed(): void {
    if (this.#closed) return
    this.#active = false
    this.#stopPolling()
    this.#options.onError.call(this)
  }

  #drain(): void {
    for (let reads = 0; reads < MICROPHONE_MAX_READS_PER_POLL && this.#active; reads += 1) {
      let byteLength: number
      try {
        byteLength = readMicrophoneCapture(this.#buffer)
      } catch {
        this.handleFailed()
        return
      }
      if (byteLength <= 0) return
      // The bridge copies the bytes into its own frame buffer before returning.
      this.#options.onReadable.call(this, this.#buffer.subarray(0, byteLength))
    }
  }

  #stopPolling(): void {
    if (this.#timer === undefined) return
    Timer.clear(this.#timer)
    this.#timer = undefined
  }
}

class NativeMicrophoneInputService {
  readonly #postMessage: PostMessage
  #current: NativeMicrophoneInput | undefined

  constructor(postMessage: PostMessage) {
    this.#postMessage = postMessage
  }

  readonly createInput: UsbAudioMicrophoneInputFactory = (options) => {
    this.#current?.close()
    const input = new NativeMicrophoneInput(options, this.#postMessage)
    this.#current = input
    return input
  }

  handleStarted(streamId: number): void {
    if (this.#current?.streamId !== streamId) return
    this.#current.handleStarted()
  }

  handleFailed(streamId: number): void {
    const input = this.#current
    if (input?.streamId !== streamId) return
    input.handleFailed()
    if (this.#current === input) this.#current = undefined
  }

  close(): void {
    this.#current?.close()
    this.#current = undefined
  }
}

const playbackObserver: UsbAudioPlaybackObserver = {
  onPlaybackStarted() {
    self.postMessage({ id: 'playback-started', streamId: outputService?.streamId ?? 0 })
  },
  onPlaybackPower() {},
  onPlaybackText(text) {
    self.postMessage({
      id: 'playback-text',
      text,
      position: outputService?.writtenBytes ?? 0,
      streamId: outputService?.streamId ?? 0,
    })
  },
  onPlaybackStopped() {
    self.postMessage({ id: 'playback-stopped', streamId: outputService?.streamId ?? 0 })
  },
}

const onEvent = (event: string) => self.postMessage({ id: 'event', event })
const onStatus = (status: number) => self.postMessage({ id: 'status-changed', status })
const onTransportState = (transportState: UsbEventTransportState) =>
  self.postMessage({ id: 'transport-state', transportState })

function closeWorker(): void {
  bridge?.setStatusHandler(undefined)
  bridge?.setTransportStateHandler(undefined)
  bridge?.close()
  bridge = undefined
  inputService?.close()
  inputService = undefined
  outputService?.close()
  outputService = undefined
  try {
    self.postMessage({ id: 'closed' })
  } finally {
    self.close()
  }
}

function startWorker(message: {
  speakerVolume?: number
  diagnostics?: boolean
  output?: SharedSpeakerOutputBuffers
}): void {
  if (bridge) return
  if (!message.output) throw new TypeError('shared speaker output is required')
  const nextInputService = new NativeMicrophoneInputService((next) => self.postMessage(next))
  const nextOutputService = new SharedSpeakerOutputService(message.output, (next) => self.postMessage(next))
  let nextBridge: UsbAudioBridgeControl | undefined
  try {
    nextBridge = startUsbAudioBridge({
      speakerVolume: message.speakerVolume,
      diagnostics: message.diagnostics,
      createMicrophoneInput: nextInputService.createInput,
      createSpeakerOutput: nextOutputService.createOutput,
      createUSBSerial: (options) => new USBSerial(options),
      checksum: crc32Usb,
    })
    nextBridge.setPlaybackObserver(playbackObserver)
    nextBridge.setEventHandler(onEvent)
    nextBridge.setStatusHandler(onStatus)
    nextBridge.setTransportStateHandler(onTransportState)
    self.postMessage({ id: 'ready' })
    inputService = nextInputService
    outputService = nextOutputService
    bridge = nextBridge
  } catch (error) {
    try {
      nextBridge?.setPlaybackObserver(undefined)
    } catch {}
    try {
      nextBridge?.setEventHandler(undefined)
    } catch {}
    try {
      nextBridge?.setStatusHandler(undefined)
    } catch {}
    try {
      nextBridge?.setTransportStateHandler(undefined)
    } catch {}
    try {
      nextBridge?.close()
    } catch {}
    try {
      nextInputService.close()
    } catch {}
    try {
      nextOutputService.close()
    } catch {}
    throw error
  }
}

self.onmessage = (message: {
  id?: string
  speakerVolume?: number
  diagnostics?: boolean
  bitsPerSample?: number
  channels?: number
  output?: SharedSpeakerOutputBuffers
  sampleRate?: number
  streamId?: number
  event?: string
  requestId?: number
  volume?: number
}) => {
  try {
    switch (message.id) {
      case 'start':
        startWorker(message)
        break
      case 'audio-drained':
        outputService?.handleDrained(message.streamId ?? 0)
        break
      case 'audio-opened':
        outputService?.handleOpened(message.streamId ?? 0)
        break
      case 'audio-failed':
        outputService?.handleFailed(message.streamId ?? 0)
        break
      case 'microphone-started':
        inputService?.handleStarted(message.streamId ?? 0)
        break
      case 'microphone-failed':
        inputService?.handleFailed(message.streamId ?? 0)
        break
      case 'send-event':
        try {
          if (message.requestId === undefined) throw new TypeError('EVENT send request ID is required')
          if (message.event === undefined) throw new TypeError('EVENT payload is required')
          self.postMessage({
            id: 'send-event-result',
            requestId: message.requestId,
            result: bridge?.sendEvent(message.event) ?? 'disconnected',
          })
        } catch (error) {
          self.postMessage({
            id: 'send-event-error',
            requestId: message.requestId,
            reason: error instanceof Error ? error.message : String(error),
          })
        }
        break
      case 'speaker-volume':
        bridge?.setSpeakerVolume(message.volume ?? Number.NaN)
        break
      case 'close':
        closeWorker()
        break
    }
  } catch (error) {
    self.postMessage({ id: 'error', reason: error instanceof Error ? error.message : String(error) })
  }
}
