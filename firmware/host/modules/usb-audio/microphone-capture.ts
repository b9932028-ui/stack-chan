/**
 * Native 16 kHz mono microphone capture for the USB microphone stream
 * (see microphone-capture.c). The main VM opens and closes it while holding
 * `audio-input-lock`; the USB worker drains it with readMicrophoneCapture().
 */

const nativeOpen = native('xs_stackchan_microphone_capture_open')
const nativeClose = native('xs_stackchan_microphone_capture_close')
const nativeRead = native('xs_stackchan_microphone_capture_read')
const nativeStats = native('xs_stackchan_microphone_capture_stats')

export type MicrophoneCaptureStats = {
  open: boolean
  availableSamples: number
  capturedSamples: number
  droppedSamples: number
  readErrors: number
}

export function openMicrophoneCapture(): void {
  nativeOpen.call(undefined)
}

export function closeMicrophoneCapture(): void {
  nativeClose.call(undefined)
}

/** Copies buffered PCM16 into target and returns the byte count; 0 when nothing is buffered or closed. */
export function readMicrophoneCapture(target: Uint8Array): number {
  return nativeRead.call(undefined, target)
}

export function microphoneCaptureStats(): MicrophoneCaptureStats {
  return nativeStats.call(undefined)
}
