export const DEFAULT_DISPLAY_BRIGHTNESS = 100

export function canonicalizeBrightness(value: unknown, fallback = DEFAULT_DISPLAY_BRIGHTNESS): number {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.max(0, Math.min(100, Math.round(numeric)))
}
