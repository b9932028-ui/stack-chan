import { applyNeutralPose } from 'capsule-face-animations/shared'
import { drawPixelRows, drawPixelText, staticPixelEffect } from 'capsule-face-animations/static-pixel-effect'

const DURATION_MS = 6000
const RAINBOW_WIDTH = 24
const RAINBOW_HEIGHT = 16
const bands = 'roygbp'

// Generate a low-resolution semicircle once. Integer-scaled rendering keeps its pixel edges sharp.
const rainbow = []
for (let y = 0; y < RAINBOW_HEIGHT; y += 1) {
  let row = ''
  for (let x = 0; x < RAINBOW_WIDTH; x += 1) {
    const dx = x - (RAINBOW_WIDTH - 1) / 2
    const dy = y - (RAINBOW_HEIGHT - 1)
    const radius = Math.sqrt(dx * dx + dy * dy)
    const band = Math.floor(14 - radius)
    row += band >= 0 && band < bands.length ? bands[band] : '.'
  }
  rainbow.push(row)
}
Object.freeze(rainbow)

const rainbowColors = Object.freeze({
  r: '#ef4444',
  o: '#f97316',
  y: '#facc15',
  g: '#22c55e',
  b: '#3b82f6',
  p: '#a855f7',
})

export const RainbowEffect = staticPixelEffect('rainbow', (port) => {
  // 120 x 80 rainbow and 60 x 84 numeral share the same vertical center.
  drawPixelRows(port, rainbow, rainbowColors, 20, 80, 5)
  drawPixelText(port, '7', '#ffffff', 220, 78, 12)
})

export default Object.freeze({
  duration: DURATION_MS,
  apply(face) {
    applyNeutralPose(face)
  },
})
