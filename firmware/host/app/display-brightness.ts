import { canonicalizeBrightness } from 'brightness-model'

type Backlight = { write(value: number): void }

export function applyDisplayBrightness(value: unknown): number {
  const brightness = canonicalizeBrightness(value)
  const backlight = (globalThis as typeof globalThis & { backlight?: Backlight }).backlight
  try {
    backlight?.write(brightness)
  } catch (error) {
    trace(`[display] brightness update failed: ${String(error)}\n`)
  }
  return brightness
}
