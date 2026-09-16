import { describe, expect, it } from 'vitest'

import {
  encodeStackChanFrame,
  pcm16ToWavBytes,
  readPcm16Wav,
  StackChanControl,
  StackChanEventCodec,
  StackChanFrameParser,
  StackChanFrameType,
} from './usb-audio-protocol'

describe('USB Audio v2 protocol', () => {
  it('parses a frame across arbitrary serial chunks', () => {
    const encoded = encodeStackChanFrame({
      type: StackChanFrameType.CONTROL,
      flags: StackChanControl.MIC_START,
      streamId: 7,
      sequence: 3,
      sampleRate: 16000,
    })
    const parser = new StackChanFrameParser()

    expect(parser.push(encoded.slice(0, 5))).toEqual([])
    expect(parser.push(encoded.slice(5, 17))).toEqual([])
    expect(parser.push(encoded.slice(17))).toEqual([
      expect.objectContaining({
        type: StackChanFrameType.CONTROL,
        flags: StackChanControl.MIC_START,
        streamId: 7,
        sequence: 3,
        sampleRate: 16000,
      }),
    ])
  })

  it('reassembles event payloads', () => {
    const sender = new StackChanEventCodec()
    const receiver = new StackChanEventCodec()
    const payload = new TextEncoder().encode('x'.repeat(5000))
    const frames = sender.encode(payload)

    expect(frames).toHaveLength(2)
    expect(receiver.push(frames[0])).toBeUndefined()
    expect(Array.from(receiver.push(frames[1]) ?? [])).toEqual(Array.from(payload))
  })

  it('wraps and reads mono PCM16 WAV data', () => {
    const pcm = Uint8Array.of(1, 2, 3, 4)
    const wav = pcm16ToWavBytes([pcm])

    const result = readPcm16Wav(wav)
    expect(result.sampleRate).toBe(16000)
    expect(Array.from(result.pcm)).toEqual(Array.from(pcm))
  })

  it('normalizes quiet microphone PCM when requested', () => {
    const pcm = new Uint8Array(4)
    const input = new DataView(pcm.buffer)
    input.setInt16(0, 1_000, true)
    input.setInt16(2, -2_000, true)

    const wav = pcm16ToWavBytes([pcm], 16_000, true)
    const output = new DataView(readPcm16Wav(wav).pcm.buffer)
    expect(output.getInt16(0, true)).toBe(8_000)
    expect(output.getInt16(2, true)).toBe(-16_000)
  })
})
