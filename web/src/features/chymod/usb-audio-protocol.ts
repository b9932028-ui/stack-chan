export const STACKCHAN_MAGIC = 0x5343
export const STACKCHAN_PROTOCOL_VERSION = 2
export const STACKCHAN_HEADER_BYTES = 20
export const STACKCHAN_CRC_BYTES = 4
export const STACKCHAN_MAX_PAYLOAD_BYTES = 4096
export const STACKCHAN_MICROPHONE_SAMPLE_RATE = 16000

export enum StackChanFrameType {
  CONTROL = 0,
  MICROPHONE_PCM = 1,
  SPEAKER_PCM = 2,
  EVENT = 6,
}

export enum StackChanControl {
  HELLO = 1,
  HELLO_ACK = 2,
  ERROR = 3,
  MIC_START = 16,
  MIC_STARTED = 17,
  MIC_STOP = 18,
  MIC_STOPPED = 19,
  SPEAKER_START = 32,
  SPEAKER_CREDIT = 33,
  SPEAKER_END = 34,
  SPEAKER_DONE = 35,
  SPEAKER_ABORT = 36,
  SPEAKER_TEXT = 37,
}

export const StackChanCapability = {
  MICROPHONE_PCM: 1 << 0,
  SPEAKER_PCM: 1 << 1,
  SPEAKER_CREDIT: 1 << 2,
  SPEAKER_RATE_8000: 1 << 3,
  SPEAKER_RATE_16000: 1 << 4,
  SPEAKER_RATE_24000: 1 << 5,
  SPEAKER_TEXT: 1 << 6,
  STREAM_ID: 1 << 9,
  EVENT: 1 << 10,
  STATUS_EXTENDED: 1 << 11,
} as const

export const WEB_VOICE_CAPABILITIES = Object.values(StackChanCapability).reduce((value, bit) => value | bit, 0)

export const StackChanEventFlag = {
  START: 1,
  END: 1 << 1,
} as const

export type StackChanFrame = {
  type: StackChanFrameType
  flags?: number
  streamId?: number
  sequence: number
  sampleRate?: number
  payload?: Uint8Array
}

const CRC32_TABLE = new Uint32Array(256)
for (let index = 0; index < CRC32_TABLE.length; index += 1) {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  CRC32_TABLE[index] = value >>> 0
}

export function crc32(bytes: Uint8Array, end = bytes.byteLength): number {
  let value = 0xffffffff
  for (let index = 0; index < end; index += 1) value = CRC32_TABLE[(value ^ bytes[index]) & 0xff] ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}

export function encodeStackChanFrame(frame: StackChanFrame): Uint8Array {
  const payload = frame.payload ?? new Uint8Array(0)
  if (payload.byteLength > STACKCHAN_MAX_PAYLOAD_BYTES) throw new RangeError('USB audio payload is too large')
  const result = new Uint8Array(STACKCHAN_HEADER_BYTES + payload.byteLength + STACKCHAN_CRC_BYTES)
  const view = new DataView(result.buffer)
  view.setUint16(0, STACKCHAN_MAGIC, true)
  view.setUint8(2, STACKCHAN_PROTOCOL_VERSION)
  view.setUint8(3, frame.type)
  view.setUint16(4, frame.flags ?? 0, true)
  view.setUint16(6, frame.streamId ?? 0, true)
  view.setUint32(8, frame.sequence >>> 0, true)
  view.setUint32(12, frame.sampleRate ?? 0, true)
  view.setUint32(16, payload.byteLength, true)
  result.set(payload, STACKCHAN_HEADER_BYTES)
  view.setUint32(
    STACKCHAN_HEADER_BYTES + payload.byteLength,
    crc32(result, STACKCHAN_HEADER_BYTES + payload.byteLength),
    true
  )
  return result
}

export class StackChanFrameParser {
  private pending = new Uint8Array(0)
  /** Bytes skipped while resynchronizing; non-frame bytes on the wire show up here. */
  discardedBytes = 0
  crcFailures = 0

  push(chunk: Uint8Array): StackChanFrame[] {
    const combined = new Uint8Array(this.pending.byteLength + chunk.byteLength)
    combined.set(this.pending)
    combined.set(chunk, this.pending.byteLength)
    this.pending = combined
    const frames: StackChanFrame[] = []
    while (this.pending.byteLength >= STACKCHAN_HEADER_BYTES + STACKCHAN_CRC_BYTES) {
      const offset = this.findMagic()
      if (offset < 0) {
        const keep = Math.max(0, this.pending.byteLength - 1)
        this.discardedBytes += keep
        this.pending = this.pending.slice(keep)
        break
      }
      if (offset > 0) {
        this.discardedBytes += offset
        this.pending = this.pending.slice(offset)
      }
      if (this.pending.byteLength < STACKCHAN_HEADER_BYTES + STACKCHAN_CRC_BYTES) break
      const view = new DataView(this.pending.buffer, this.pending.byteOffset, this.pending.byteLength)
      const payloadBytes = view.getUint32(16, true)
      if (view.getUint8(2) !== STACKCHAN_PROTOCOL_VERSION || payloadBytes > STACKCHAN_MAX_PAYLOAD_BYTES) {
        this.discardedBytes += 1
        this.pending = this.pending.slice(1)
        continue
      }
      const frameBytes = STACKCHAN_HEADER_BYTES + payloadBytes + STACKCHAN_CRC_BYTES
      if (this.pending.byteLength < frameBytes) break
      const bytes = this.pending.slice(0, frameBytes)
      const bytesView = new DataView(bytes.buffer)
      const expected = bytesView.getUint32(STACKCHAN_HEADER_BYTES + payloadBytes, true)
      if (crc32(bytes, STACKCHAN_HEADER_BYTES + payloadBytes) !== expected) {
        this.crcFailures += 1
        this.discardedBytes += 1
        this.pending = this.pending.slice(1)
        continue
      }
      frames.push({
        type: bytesView.getUint8(3),
        flags: bytesView.getUint16(4, true),
        streamId: bytesView.getUint16(6, true),
        sequence: bytesView.getUint32(8, true),
        sampleRate: bytesView.getUint32(12, true),
        payload: bytes.slice(STACKCHAN_HEADER_BYTES, STACKCHAN_HEADER_BYTES + payloadBytes),
      })
      this.pending = this.pending.slice(frameBytes)
    }
    return frames
  }

  reset(): void {
    this.pending = new Uint8Array(0)
  }

  private findMagic(): number {
    for (let index = 0; index + 1 < this.pending.byteLength; index += 1) {
      if (this.pending[index] === 0x43 && this.pending[index + 1] === 0x53) return index
    }
    return -1
  }
}

export class StackChanEventCodec {
  private messageId = 0
  private receive?: { id: number; nextSequence: number; chunks: Uint8Array[] }

  encode(payload: Uint8Array): StackChanFrame[] {
    this.messageId = this.messageId >= 0xffff ? 1 : this.messageId + 1
    const frames: StackChanFrame[] = []
    const count = Math.max(1, Math.ceil(payload.byteLength / STACKCHAN_MAX_PAYLOAD_BYTES))
    for (let sequence = 0; sequence < count; sequence += 1) {
      const start = sequence * STACKCHAN_MAX_PAYLOAD_BYTES
      frames.push({
        type: StackChanFrameType.EVENT,
        flags: (sequence === 0 ? StackChanEventFlag.START : 0) | (sequence === count - 1 ? StackChanEventFlag.END : 0),
        streamId: this.messageId,
        sequence,
        payload: payload.slice(start, start + STACKCHAN_MAX_PAYLOAD_BYTES),
      })
    }
    return frames
  }

  push(frame: StackChanFrame): Uint8Array | undefined {
    const id = frame.streamId ?? 0
    const flags = frame.flags ?? 0
    if ((flags & StackChanEventFlag.START) !== 0) this.receive = { id, nextSequence: 0, chunks: [] }
    const current = this.receive
    if (!current || current.id !== id || frame.sequence !== current.nextSequence) {
      this.receive = undefined
      return
    }
    current.chunks.push(frame.payload ?? new Uint8Array(0))
    current.nextSequence += 1
    if ((flags & StackChanEventFlag.END) === 0) return
    this.receive = undefined
    const size = current.chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
    const result = new Uint8Array(size)
    let offset = 0
    for (const chunk of current.chunks) {
      result.set(chunk, offset)
      offset += chunk.byteLength
    }
    return result
  }
}

export function pcm16ToWav(chunks: Uint8Array[], sampleRate = STACKCHAN_MICROPHONE_SAMPLE_RATE): Blob {
  return new Blob([pcm16ToWavBytes(chunks, sampleRate, true).buffer], { type: 'audio/wav' })
}

export function pcm16ToWavBytes(
  chunks: Uint8Array[],
  sampleRate = STACKCHAN_MICROPHONE_SAMPLE_RATE,
  normalize = false
): Uint8Array<ArrayBuffer> {
  const dataBytes = chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
  const bytes = new Uint8Array(44 + dataBytes)
  const view = new DataView(bytes.buffer)
  writeAscii(bytes, 0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  writeAscii(bytes, 8, 'WAVEfmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeAscii(bytes, 36, 'data')
  view.setUint32(40, dataBytes, true)
  let offset = 44
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  if (normalize) normalizePcm16(bytes.subarray(44))
  return bytes
}

function normalizePcm16(bytes: Uint8Array): void {
  const samples = Math.floor(bytes.byteLength / 2)
  if (samples === 0) return
  const view = new DataView(bytes.buffer, bytes.byteOffset, samples * 2)
  let peak = 0
  for (let index = 0; index < samples; index += 1) peak = Math.max(peak, Math.abs(view.getInt16(index * 2, true)))
  if (peak === 0) return
  const gain = Math.min(8, Math.max(1, 16_000 / peak))
  if (gain === 1) return
  for (let index = 0; index < samples; index += 1) {
    const amplified = Math.round(view.getInt16(index * 2, true) * gain)
    view.setInt16(index * 2, Math.max(-32_768, Math.min(32_767, amplified)), true)
  }
}

export function readPcm16Wav(bytes: Uint8Array): { sampleRate: number; pcm: Uint8Array } {
  if (bytes.byteLength < 44 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WAVE') {
    throw new Error('TTS returned an invalid WAV file')
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 12
  let sampleRate = 0
  let validFormat = false
  let pcm: Uint8Array | undefined
  while (offset + 8 <= bytes.byteLength) {
    const id = ascii(bytes, offset, 4)
    const size = view.getUint32(offset + 4, true)
    const start = offset + 8
    if (start + size > bytes.byteLength) break
    if (id === 'fmt ' && size >= 16) {
      validFormat =
        view.getUint16(start, true) === 1 &&
        view.getUint16(start + 2, true) === 1 &&
        view.getUint16(start + 14, true) === 16
      sampleRate = view.getUint32(start + 4, true)
    } else if (id === 'data') pcm = bytes.slice(start, start + size)
    offset = start + size + (size & 1)
  }
  if (!validFormat || !pcm || ![8000, 16000, 24000].includes(sampleRate))
    throw new Error('TTS WAV must be mono PCM16 at 8, 16, or 24 kHz')
  return { sampleRate, pcm }
}

export function pcm16Rms(bytes: Uint8Array): number {
  const samples = Math.floor(bytes.byteLength / 2)
  if (samples === 0) return 0
  const view = new DataView(bytes.buffer, bytes.byteOffset, samples * 2)
  let sum = 0
  for (let index = 0; index < samples; index += 1) {
    const value = view.getInt16(index * 2, true)
    sum += value * value
  }
  return Math.sqrt(sum / samples)
}

function writeAscii(bytes: Uint8Array, offset: number, text: string): void {
  for (let index = 0; index < text.length; index += 1) bytes[offset + index] = text.charCodeAt(index)
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.slice(offset, offset + length))
}
