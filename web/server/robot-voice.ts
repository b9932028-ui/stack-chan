/**
 * Small, dependency-free "cute robot" post-processing for Windows TTS output.
 *
 * Ring modulation gives the metallic robot timbre, optional bit crushing adds a
 * toy-like digital edge, and the result is peak-normalized. Input and output are
 * mono PCM16 WAV, the format Stack-Chan's USB speaker path accepts.
 */

export type RobotVoiceOptions = {
  /** Carrier frequency of the ring modulator in Hz. */
  ringFrequency: number
  /** 0 keeps the dry voice, 1 is fully ring-modulated. */
  ringMix: number
  /** Quantize to this many bits; omit to skip bit crushing. */
  bitDepth?: number
  /** Hold every Nth sample; 1 or omitted keeps the original sample rate. */
  sampleHold?: number
  /**
   * Band-limit to this rate and linearly upsample back, like stackchan-voice's
   * 8 kHz formant synth played through its 3x linear converter. Must divide the
   * source rate; omit to keep full bandwidth.
   */
  lofiSampleRate?: number
  /** Soft-clipping drive (> 0) for a buzzier, synthesized timbre; omit to skip. */
  drive?: number
  /**
   * Resampling factor (> 1) that raises pitch and formants together for a thinner,
   * smaller voice. It also shortens the speech, so slow the TTS rate to compensate.
   */
  pitchShift?: number
  /** High-pass cutoff in Hz that removes body from the voice; omit to skip. */
  highPassHz?: number
  /**
   * Raise the average (RMS) level to this dBFS and soft-limit the peaks that exceed
   * full scale, so a small speaker sounds louder without hard clipping; omit to
   * peak-normalize instead.
   */
  targetRmsDb?: number
}

export const ROBOT_VOICE_PRESETS = {
  none: { ringFrequency: 0, ringMix: 0 },
  // Unchanged timbre, louder: RMS raised, peaks soft-limited.
  loud: { ringFrequency: 0, ringMix: 0, targetRmsDb: -14 },
  // A thin, lo-fi voice reminiscent of stackchan-voice that stays intelligible:
  // no speed-up, low body removed, 12 kHz band with linear-upsampling fizz, light buzz.
  stackchan: { ringFrequency: 0, ringMix: 0, lofiSampleRate: 12000, drive: 1.5, highPassHz: 500 },
} satisfies Record<string, RobotVoiceOptions>

export type RobotVoicePreset = keyof typeof ROBOT_VOICE_PRESETS

const PEAK_TARGET = 0.9

export function applyRobotVoice(wav: Uint8Array, options: RobotVoiceOptions): Uint8Array {
  const { sampleRate, samples } = readMonoPcm16(wav)
  let input: Float32Array = new Float32Array(samples.length)
  for (let index = 0; index < samples.length; index += 1) input[index] = samples[index] / 32768
  if (options.pitchShift && options.pitchShift > 1) input = resampleFaster(input, options.pitchShift)
  if (options.highPassHz && options.highPassHz > 0) input = highPass(input, sampleRate, options.highPassHz)
  if (options.drive && options.drive > 0) input = softClip(input, options.drive)
  if (options.lofiSampleRate) input = lofi(input, sampleRate, options.lofiSampleRate)

  const output = new Float32Array(input.length)
  const ringMix = Math.min(1, Math.max(0, options.ringMix))
  const levels = options.bitDepth ? 2 ** (options.bitDepth - 1) : 0
  const hold = Math.max(1, Math.round(options.sampleHold ?? 1))
  let held = 0
  let peak = 0

  for (let index = 0; index < input.length; index += 1) {
    let value = input[index]
    if (ringMix > 0 && options.ringFrequency > 0) {
      const carrier = Math.sin((2 * Math.PI * options.ringFrequency * index) / sampleRate)
      value *= 1 - ringMix + ringMix * carrier
    }
    if (levels > 0) value = Math.round(value * levels) / levels
    if (index % hold === 0) held = value
    output[index] = held
    peak = Math.max(peak, Math.abs(held))
  }

  const pcm = new Int16Array(output.length)
  if (options.targetRmsDb !== undefined) {
    let sum = 0
    for (let index = 0; index < output.length; index += 1) sum += output[index] * output[index]
    const rms = Math.sqrt(sum / Math.max(1, output.length))
    const gain = rms > 0 ? 10 ** (options.targetRmsDb / 20) / rms : 1
    for (let index = 0; index < output.length; index += 1) {
      pcm[index] = Math.round(softLimit(output[index] * gain) * 32767)
    }
  } else {
    const gain = peak > 0 ? PEAK_TARGET / peak : 1
    for (let index = 0; index < output.length; index += 1) {
      pcm[index] = Math.max(-32768, Math.min(32767, Math.round(output[index] * gain * 32767)))
    }
  }
  return writeMonoPcm16(sampleRate, pcm)
}

const LIMITER_KNEE = 0.7

/** Leaves samples below the knee untouched and bends louder ones smoothly toward full scale. */
function softLimit(value: number): number {
  const magnitude = Math.abs(value)
  if (magnitude <= LIMITER_KNEE) return value
  const headroom = 1 - LIMITER_KNEE
  return Math.sign(value) * (LIMITER_KNEE + headroom * Math.tanh((magnitude - LIMITER_KNEE) / headroom))
}

/** Reads the input faster with linear interpolation, raising pitch and formants by `factor`. */
function resampleFaster(input: Float32Array, factor: number): Float32Array {
  const output = new Float32Array(Math.floor((input.length - 1) / factor))
  for (let index = 0; index < output.length; index += 1) {
    const position = index * factor
    const base = Math.floor(position)
    const fraction = position - base
    output[index] = input[base] + (input[base + 1] - input[base]) * fraction
  }
  return output
}

/** Second-order Butterworth high-pass (RBJ biquad). */
function highPass(input: Float32Array, sampleRate: number, cutoff: number): Float32Array {
  const omega = (2 * Math.PI * cutoff) / sampleRate
  const alpha = Math.sin(omega) / Math.SQRT2
  const cosine = Math.cos(omega)
  const a0 = 1 + alpha
  const b0 = (1 + cosine) / 2 / a0
  const b1 = -(1 + cosine) / a0
  const b2 = b0
  const a1 = (-2 * cosine) / a0
  const a2 = (1 - alpha) / a0
  const output = new Float32Array(input.length)
  let x1 = 0
  let x2 = 0
  let y1 = 0
  let y2 = 0
  for (let index = 0; index < input.length; index += 1) {
    const x0 = input[index]
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
    output[index] = y0
    x2 = x1
    x1 = x0
    y2 = y1
    y1 = y0
  }
  return output
}

function softClip(input: Float32Array, drive: number): Float32Array {
  const output = new Float32Array(input.length)
  const normalizer = Math.tanh(drive)
  for (let index = 0; index < input.length; index += 1) output[index] = Math.tanh(input[index] * drive) / normalizer
  return output
}

/**
 * Averages down to the lo-fi rate, then linearly interpolates back up. The
 * interpolation mirrors stackchan-voice's 3x converter, whose imaging gives its
 * characteristic fizz.
 */
function lofi(input: Float32Array, sampleRate: number, targetRate: number): Float32Array {
  const factor = Math.round(sampleRate / targetRate)
  if (factor < 2 || sampleRate % targetRate !== 0) return input
  const lowCount = Math.floor(input.length / factor)
  const output = new Float32Array(lowCount * factor)
  let previous = 0
  for (let low = 0; low < lowCount; low += 1) {
    let sum = 0
    for (let offset = 0; offset < factor; offset += 1) sum += input[low * factor + offset]
    const sample = sum / factor
    for (let step = 0; step < factor; step += 1) {
      output[low * factor + step] = previous + ((sample - previous) * step) / factor
    }
    previous = sample
  }
  return output
}

function readMonoPcm16(wav: Uint8Array): { sampleRate: number; samples: Int16Array } {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength)
  const ascii = (offset: number) => String.fromCharCode(...wav.subarray(offset, offset + 4))
  if (wav.byteLength < 44 || ascii(0) !== 'RIFF' || ascii(8) !== 'WAVE') throw new Error('TTS returned an invalid WAV.')
  let offset = 12
  let sampleRate = 0
  let data: Uint8Array | undefined
  while (offset + 8 <= wav.byteLength) {
    const size = view.getUint32(offset + 4, true)
    const start = offset + 8
    if (start + size > wav.byteLength) break
    if (ascii(offset) === 'fmt ') {
      const pcm16Mono =
        view.getUint16(start, true) === 1 &&
        view.getUint16(start + 2, true) === 1 &&
        view.getUint16(start + 14, true) === 16
      if (!pcm16Mono) throw new Error('TTS WAV must be mono PCM16.')
      sampleRate = view.getUint32(start + 4, true)
    } else if (ascii(offset) === 'data') {
      data = wav.subarray(start, start + size)
    }
    offset = start + size + (size & 1)
  }
  if (!sampleRate || !data) throw new Error('TTS WAV is missing its format or data.')
  const samples = new Int16Array(Math.floor(data.byteLength / 2))
  const dataView = new DataView(data.buffer, data.byteOffset, samples.length * 2)
  for (let index = 0; index < samples.length; index += 1) samples[index] = dataView.getInt16(index * 2, true)
  return { sampleRate, samples }
}

function writeMonoPcm16(sampleRate: number, pcm: Int16Array): Uint8Array {
  const bytes = new Uint8Array(44 + pcm.length * 2)
  const view = new DataView(bytes.buffer)
  const writeAscii = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) bytes[offset + index] = text.charCodeAt(index)
  }
  writeAscii(0, 'RIFF')
  view.setUint32(4, 36 + pcm.length * 2, true)
  writeAscii(8, 'WAVE')
  writeAscii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeAscii(36, 'data')
  view.setUint32(40, pcm.length * 2, true)
  for (let index = 0; index < pcm.length; index += 1) view.setInt16(44 + index * 2, pcm[index], true)
  return bytes
}
